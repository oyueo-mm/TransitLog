import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { TransitDB } from '../src/db/db'
import {
  addSeatEvent,
  deleteTrip,
  endRide,
  existingFingerprints,
  getSetting,
  getTripWithEvents,
  ongoingTrip,
  saveDay,
  saveTrip,
  setSetting,
  startRide,
  tripFingerprint,
  tripsOnDate,
} from '../src/db/repo'
import { emptyTripDraft } from '../src/domain/types'
import { commitCandidates, markDuplicates } from '../src/import/commit'
import { parseNotes } from '../src/import/parser'

let db: TransitDB
let seq = 0
beforeEach(() => {
  db = new TransitDB(`test-${++seq}-${Math.random()}`)
})

describe('IndexedDB 저장·조회·수정·삭제', () => {
  it('저장한 기록이 연결을 닫았다 다시 열어도(재접속) 그대로 있다', async () => {
    const name = db.name
    const saved = await saveTrip(
      { ...emptyTripDraft('2026-03-02'), line: '1호선', boardTime: '08:24', initialSeat: 'standing', note: '  메모 ' },
      [{ time: '08:30', state: 'seated', place: '가역' }],
      db,
    )
    db.close()
    const reopened = new TransitDB(name)
    const got = await getTripWithEvents(saved.id, reopened)
    expect(got?.trip.line).toBe('1호선')
    expect(got?.trip.note).toBe('메모') // 공백 정리
    expect(got?.events).toHaveLength(1)
    expect(got?.events[0]).toMatchObject({ time: '08:30', state: 'seated', place: '가역' })
    reopened.close()
  })

  it('수정은 같은 id 를 갱신하고 createdAt 을 유지한다', async () => {
    const a = await saveTrip({ ...emptyTripDraft('2026-03-02'), line: '1호선' }, [], db)
    const b = await saveTrip({ ...a, line: '2호선' }, undefined, db)
    expect(b.id).toBe(a.id)
    expect(b.createdAt).toBe(a.createdAt)
    expect((await db.trips.toArray()).map((t) => t.line)).toEqual(['2호선'])
  })

  it('삭제하면 좌석 변화 이벤트도 함께 삭제', async () => {
    const a = await saveTrip({ ...emptyTripDraft('2026-03-02') }, [{ time: null, state: 'seated', place: null }], db)
    await deleteTrip(a.id, db)
    expect(await db.trips.count()).toBe(0)
    expect(await db.seatEvents.count()).toBe(0)
  })

  it('해당 없음으로 표시한 필드는 값이 비워지고 미기록과 구분되어 저장', async () => {
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02'), car: 5, naFields: ['car', 'waitOrder'] }, [], db)
    const got = (await db.trips.get(t.id))!
    expect(got.car).toBeNull()
    expect(got.naFields).toEqual(['car', 'waitOrder'])
    expect(got.door).toBeNull() // 미기록: naFields 에 없음
    expect(got.naFields.includes('door')).toBe(false)
  })

  it('버스 기록에는 지하철 전용 필드가 저장되지 않는다', async () => {
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02', 'bus'), car: 3, side: 'left', trainDestination: '가' }, [], db)
    expect([t.car, t.side, t.trainDestination]).toEqual([null, null, null])
  })

  it('날짜별 조회는 승차 시각순이고 시각 없는 기록은 뒤로', async () => {
    await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: '09:00' }, [], db)
    await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: null }, [], db)
    await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: '08:00' }, [], db)
    await saveTrip({ ...emptyTripDraft('2026-03-03'), boardTime: '07:00' }, [], db)
    expect((await tripsOnDate('2026-03-02', db)).map((t) => t.boardTime)).toEqual(['08:00', '09:00', null])
  })

  it('설정 저장·조회', async () => {
    await setSetting('k', { a: 1 }, db)
    expect(await getSetting('k', null, db)).toEqual({ a: 1 })
    expect(await getSetting('none', 'x', db)).toBe('x')
  })

  it('일지는 일부 칸만 수정해도 나머지가 유지', async () => {
    await saveDay('2026-03-02', { homeDepart: '07:50' }, db)
    await saveDay('2026-03-02', { schoolArrive: '09:30' }, db)
    const d = (await db.days.get('2026-03-02'))!
    expect([d.homeDepart, d.schoolArrive, d.homeArrive]).toEqual(['07:50', '09:30', null])
  })
})

describe('지금 탑승 · 하차 · 좌석 변화', () => {
  it('탑승 시작 → 좌석 변화 → 하차: 시각이 기록되고 소요 시간이 계산 가능', async () => {
    const t = await startRide({ mode: 'subway', line: '1호선', boardTime: '08:24', initialSeat: 'standing' }, [], db)
    expect(t.ongoing).toBe(true)
    expect((await ongoingTrip(db))?.id).toBe(t.id)
    await addSeatEvent(t.id, { time: '08:30', state: 'seated', place: '가역' }, db)
    const done = await endRide(t.id, { alightTime: '09:20', alightPlace: '나역', seatLogComplete: true }, db)
    expect(done?.ongoing).toBe(false)
    expect(await ongoingTrip(db)).toBeUndefined()
    expect(done?.alightTime).toBe('09:20')
  })

  it('좌석 변화가 새로 생기면 기록 완결 확인은 해제', async () => {
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02'), initialSeat: 'standing', seatLogComplete: true }, [], db)
    await addSeatEvent(t.id, { time: '08:10', state: 'seated', place: null }, db)
    expect((await db.trips.get(t.id))!.seatLogComplete).toBeNull()
  })
})

describe('중복 가져오기 방지', () => {
  const TEXT = `2026-03-02 월요일
08:00 1호선, 가역->나역, 다->라행
3-2, 왼쪽, 1번째, 서서감
2026-03-03 화요일
08:10 1호선, 가역->나역, 다->라행
3-2, 왼쪽, 1번째, 앉아서감
`
  it('같은 파일을 두 번 가져와도 두 번째는 추가되지 않는다', async () => {
    const first = parseNotes(TEXT)
    await markDuplicates(first.candidates, db)
    expect((await commitCandidates(first.candidates, first.days, db)).added).toBe(2)

    const second = parseNotes(TEXT)
    await markDuplicates(second.candidates, db)
    expect(second.candidates.every((c) => c.duplicate === 'existing' && !c.selected)).toBe(true)
    // 선택을 억지로 켜도 저장 직전 재확인에서 걸러진다
    second.candidates.forEach((c) => (c.selected = true))
    const r = await commitCandidates(second.candidates, second.days, db)
    expect(r.added).toBe(0)
    expect(r.skippedDuplicates).toBe(2)
    expect(await db.trips.count()).toBe(2)
  })

  it('직접 입력한 기존 기록은 가져오기로 덮어쓰이지 않고 같은 기록은 건너뜀', async () => {
    await saveTrip({ ...emptyTripDraft('2026-03-02'), line: '1호선', boardTime: '08:00', boardPlace: '가역', alightPlace: '나역', trainDestination: '라', note: '내가 쓴 메모' }, [], db)
    const p = parseNotes(TEXT)
    await markDuplicates(p.candidates, db)
    await commitCandidates(p.candidates, p.days, db)
    const all = await db.trips.toArray()
    expect(all).toHaveLength(2)
    expect(all.find((t) => t.date === '2026-03-02')!.note).toBe('내가 쓴 메모')
  })

  it('하루 기록은 이미 입력된 칸을 덮어쓰지 않고 빈 칸만 채운다', async () => {
    await saveDay('2026-03-02', { homeDepart: '07:00' }, db)
    const p = parseNotes('2026-03-02 월요일\n(07:50 집에서 출발)\n(09:00 학교 도착)\n')
    await commitCandidates(p.candidates, p.days, db)
    const d = (await db.days.get('2026-03-02'))!
    expect(d.homeDepart).toBe('07:00')
    expect(d.schoolArrive).toBe('09:00')
  })

  it('지문은 공백·대소문자 차이를 무시', async () => {
    const a = emptyTripDraft('2026-03-02')
    expect(tripFingerprint({ ...a, line: '1 호선' })).toBe(tripFingerprint({ ...a, line: '1호선' }))
    await saveTrip({ ...a, line: '1호선' }, [], db)
    expect((await existingFingerprints(db)).size).toBe(1)
  })
})
