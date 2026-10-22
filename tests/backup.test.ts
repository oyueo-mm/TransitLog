import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { TransitDB } from '../src/db/db'
import { buildBackup, parseBackup, restoreMerge, restoreReplace, tripsToCsv } from '../src/db/backup'
import { saveDay, saveTemplate, saveTrip, templateFromTrip } from '../src/db/repo'
import { emptyTripDraft } from '../src/domain/types'
import { mkEvent, mkTrip } from './helpers'

let seq = 0
let a: TransitDB
let b: TransitDB
beforeEach(() => {
  a = new TransitDB(`bk-a-${++seq}-${Math.random()}`)
  b = new TransitDB(`bk-b-${seq}-${Math.random()}`)
})

async function seed(db: TransitDB) {
  const t = await saveTrip(
    { ...emptyTripDraft('2026-03-02'), line: '1호선', boardTime: '08:00', alightTime: '08:30', initialSeat: 'standing', seatLogComplete: true, naFields: ['waitOrder'] },
    [{ time: '08:10', state: 'seated', place: '가역' }],
    db,
  )
  await saveDay('2026-03-02', { homeDepart: '07:50' }, db)
  await saveTemplate(templateFromTrip(t, '내 경로'), db)
  return t
}

describe('JSON 백업·복원', () => {
  it('내보낸 백업을 다른 기기(빈 DB)에 복원하면 모든 데이터가 같다', async () => {
    await seed(a)
    const json = JSON.stringify(await buildBackup(a))
    const parsed = parseBackup(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.summary).toMatchObject({ trips: 1, seatEvents: 1, days: 1, templates: 1 })
    const res = await restoreMerge(parsed.backup, b)
    expect(res.addedTrips).toBe(1)
    expect(await b.trips.toArray()).toEqual(await a.trips.toArray())
    expect(await b.seatEvents.toArray()).toEqual(await a.seatEvents.toArray())
    expect(await b.days.toArray()).toEqual(await a.days.toArray())
    expect(await b.templates.toArray()).toEqual(await a.templates.toArray())
    // 해당 없음(naFields)과 미기록(null)의 구분이 보존
    expect((await b.trips.toArray())[0].naFields).toEqual(['waitOrder'])
  })

  it('병합 복원은 기존 데이터를 덮어쓰거나 지우지 않고, 같은 기록은 건너뛴다', async () => {
    const t = await seed(a)
    const backup = await buildBackup(a)
    // b 에는 같은 id 의 기록(사용자가 이미 수정해 둔 상태)과 다른 기록이 있다
    await b.trips.add({ ...t, note: '이 기기에서 수정함' })
    const mine = await saveTrip({ ...emptyTripDraft('2026-03-09'), line: '2호선' }, [], b)
    const res = await restoreMerge(backup, b)
    expect(res.addedTrips).toBe(0)
    expect(res.skippedTrips).toBe(1)
    expect((await b.trips.get(t.id))!.note).toBe('이 기기에서 수정함')
    expect(await b.trips.get(mine.id)).toBeTruthy()
    // 두 번 복원해도 늘어나지 않는다
    await restoreMerge(backup, b)
    expect(await b.trips.count()).toBe(2)
  })

  it('병합 복원은 일지의 빈 칸만 채운다', async () => {
    await seed(a)
    await saveDay('2026-03-02', { schoolArrive: '09:30' }, a)
    const backup = await buildBackup(a)
    await saveDay('2026-03-02', { homeDepart: '07:00' }, b)
    await restoreMerge(backup, b)
    const d = (await b.days.get('2026-03-02'))!
    expect(d.homeDepart).toBe('07:00')
    expect(d.schoolArrive).toBe('09:30')
  })

  it('전체 교체 복원은 백업 내용으로 정확히 바꾼다', async () => {
    await seed(a)
    await saveTrip({ ...emptyTripDraft('2026-04-01') }, [], b)
    await restoreReplace(await buildBackup(a), b)
    expect(await b.trips.count()).toBe(1)
    expect((await b.trips.toArray())[0].date).toBe('2026-03-02')
  })

  it('형식이 맞지 않는 파일은 거부', () => {
    expect(parseBackup('not json').ok).toBe(false)
    expect(parseBackup('{"hello":1}').ok).toBe(false)
    expect(parseBackup(JSON.stringify({ app: 'TransitLog', schemaVersion: 1, data: { trips: [{ id: 1 }] } })).ok).toBe(false)
  })

  it('더 새로운 스키마 버전의 백업은 데이터 손상을 막기 위해 거부', () => {
    const r = parseBackup(JSON.stringify({ app: 'TransitLog', schemaVersion: 999, data: {} }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/새로운 버전/)
  })

  it('이전 버전 백업에서 일부 테이블이 없어도 읽는다', () => {
    const r = parseBackup(JSON.stringify({ app: 'TransitLog', schemaVersion: 1, data: { trips: [] } }))
    expect(r.ok).toBe(true)
  })
})

describe('CSV 내보내기', () => {
  it('미기록은 빈 칸, 해당 없음은 N/A 로 구분하고 계산값도 미확인이면 비운다', () => {
    const t = mkTrip({ boardTime: '08:00', alightTime: '08:30', initialSeat: 'standing', seatLogComplete: true, naFields: ['waitOrder'], car: null })
    const u = mkTrip({ boardTime: '09:00' })
    const csv = tripsToCsv([t, u], [mkEvent(t.id, { time: '08:10', state: 'seated', place: '가역' })])
    const lines = csv.replace('﻿', '').split('\r\n')
    const head = lines[0].split(',')
    const rowT = lines[1].split(',')
    const rowU = lines[2].split(',')
    const col = (n: string) => head.indexOf(n)
    expect(rowT[col('대기 순서')]).toBe('N/A')
    expect(rowT[col('칸')]).toBe('')
    expect(rowT[col('소요 시간(분)')]).toBe('30')
    expect(rowT[col('착석까지(분)')]).toBe('10')
    expect(rowU[col('소요 시간(분)')]).toBe('')
    expect(rowU[col('즉시 착석')]).toBe('')
    expect(csv.startsWith('﻿')).toBe(true)
  })
  it('쉼표·따옴표·줄바꿈이 들어간 비고를 안전하게 인용', () => {
    const csv = tripsToCsv([mkTrip({ note: '가,"나"\n다' })], [])
    expect(csv).toContain('"가,""나""\n다"')
  })
})
