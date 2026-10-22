import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { TransitDB } from '../src/db/db'
import { addSeatEvent, getTripWithEvents, saveTrip } from '../src/db/repo'
import { parseBackup } from '../src/db/backup'
import { cleanEvent, dedupeEvents, findFirstSeated, removeFirstSeated, upsertFirstSeated } from '../src/domain/seatEdit'
import { summarizeSeat } from '../src/domain/seat'
import { emptyTripDraft, type SeatEventDraft } from '../src/domain/types'
import { mkTrip } from './helpers'

let n = 0
const newDb = () => new TransitDB(`seatedit-${++n}-${Math.random()}`)

describe('중간 착석 편집', () => {
  it('같은 동작을 여러 번 해도 착석 이벤트는 하나만 만들어진다', () => {
    let ev: SeatEventDraft[] = []
    ev = upsertFirstSeated(ev)
    ev = upsertFirstSeated(ev)
    ev = upsertFirstSeated(ev, { time: '08:30' })
    ev = upsertFirstSeated(ev, { place: '성균관대역' })
    expect(ev).toEqual([{ time: '08:30', state: 'seated', place: '성균관대역', note: null }])
  })
  it('시각·역·비고를 모르면 비워 둔 채로 만든다', () => {
    expect(upsertFirstSeated([])).toEqual([{ time: null, state: 'seated', place: null, note: null }])
  })
  it('수정·삭제', () => {
    const ev = upsertFirstSeated([], { time: '08:30', place: '가역', note: '자리가 남음' })
    expect(removeFirstSeated(upsertFirstSeated(ev, { time: '08:40' }))).toEqual([])
    expect(removeFirstSeated([])).toEqual([])
  })
  it('다른 좌석 변화(일어섬 등)는 건드리지 않는다', () => {
    const ev: SeatEventDraft[] = [
      { time: '08:20', state: 'standing', place: null },
      { time: '08:30', state: 'seated', place: null },
      { time: '09:00', state: 'standing', place: null },
    ]
    expect(findFirstSeated(ev)).toBe(1)
    const next = upsertFirstSeated(ev, { time: '08:35' })
    expect(next).toHaveLength(3)
    expect(next[0]).toEqual(ev[0])
    expect(next[2]).toEqual(ev[2])
    expect(next[1].time).toBe('08:35')
    expect(removeFirstSeated(ev)).toHaveLength(2)
  })
  it('완전히 같은 이벤트는 하나로 합친다', () => {
    const a: SeatEventDraft = { time: '08:30', state: 'seated', place: '가역', note: null }
    expect(dedupeEvents([a, { ...a }, { ...a, time: '08:31' }])).toHaveLength(2)
  })
  it('빈 문자열은 미기록(null)으로 정리', () => {
    expect(cleanEvent({ time: '', state: 'seated', place: '  ', note: ' ' })).toEqual({ time: null, state: 'seated', place: null, note: null })
    expect(cleanEvent({ time: '08:30', state: 'seated', place: ' 가역 ' }).place).toBe('가역')
  })
})

describe('중간 착석 저장 (IndexedDB)', () => {
  it('시각·역·비고를 저장·수정·삭제하고, 다시 저장해도 이벤트가 중복되지 않는다', async () => {
    const db = newDb()
    const draft = { ...emptyTripDraft('2026-03-02'), line: '1호선', boardTime: '08:24', alightTime: '09:20', initialSeat: 'standing' as const, seatLogComplete: true }
    const t = await saveTrip(draft, [{ time: '08:30', state: 'seated', place: '성균관대역', note: '자리가 남음' }], db)
    let got = await getTripWithEvents(t.id, db)
    expect(got!.events).toHaveLength(1)
    expect(got!.events[0]).toMatchObject({ time: '08:30', place: '성균관대역', note: '자리가 남음', state: 'seated' })
    const s = summarizeSeat(got!.trip, got!.events)
    expect([s.minutesToFirstSeat, s.standingMinutes, s.final]).toEqual([6, 6, 'seated'])

    // 같은 내용으로 두 번 더 저장해도 하나
    await saveTrip(got!.trip, [{ time: '08:30', state: 'seated', place: '성균관대역', note: '자리가 남음' }], db)
    await saveTrip(got!.trip, [{ time: '08:30', state: 'seated', place: '성균관대역', note: '자리가 남음' }, { time: '08:30', state: 'seated', place: '성균관대역', note: '자리가 남음' }], db)
    expect((await getTripWithEvents(t.id, db))!.events).toHaveLength(1)

    // 수정
    await saveTrip(got!.trip, [{ time: '08:40', state: 'seated', place: null, note: null }], db)
    got = await getTripWithEvents(t.id, db)
    expect(got!.events[0]).toMatchObject({ time: '08:40', place: null })
    expect(summarizeSeat(got!.trip, got!.events).minutesToFirstSeat).toBe(16)

    // 삭제
    await saveTrip(got!.trip, [], db)
    expect((await getTripWithEvents(t.id, db))!.events).toHaveLength(0)
    // 기록 자체(승차·하차)는 그대로
    expect((await db.trips.get(t.id))!.alightTime).toBe('09:20')
  })

  it('시각이나 역을 몰라도 중간 착석을 비워서 저장할 수 있고, 계산값은 미확인으로 남는다', async () => {
    const db = newDb()
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: '08:00', alightTime: '08:30', initialSeat: 'standing', seatLogComplete: true }, [{ time: null, state: 'seated', place: null, note: null }], db)
    const got = (await getTripWithEvents(t.id, db))!
    expect(got.events).toHaveLength(1)
    const s = summarizeSeat(got.trip, got.events)
    expect(s.everSeated).toBe(true)
    expect(s.minutesToFirstSeat).toBeNull()
    expect(s.standingMinutes).toBeNull()
  })

  it('여러 번 좌석이 바뀐 경우 순서대로 정확히 저장된다', async () => {
    const db = newDb()
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: '10:00', alightTime: '11:00', initialSeat: 'standing', seatLogComplete: true }, [], db)
    await addSeatEvent(t.id, { time: '10:10', state: 'seated', place: '가역' }, db)
    await addSeatEvent(t.id, { time: '10:25', state: 'standing', place: null }, db)
    await addSeatEvent(t.id, { time: '10:40', state: 'seated', place: '나역', note: null }, db)
    const got = (await getTripWithEvents(t.id, db))!
    expect(got.events.map((e) => [e.time, e.state])).toEqual([
      ['10:10', 'seated'],
      ['10:25', 'standing'],
      ['10:40', 'seated'],
    ])
    // addSeatEvent 는 '기록 완결' 확인을 해제한다 → 최종 상태는 다시 확인 전까지 미확인
    expect(got.trip.seatLogComplete).toBeNull()
    const done = await saveTrip({ ...got.trip, seatLogComplete: true }, got.events.map(({ time, state, place, note }) => ({ time, state, place, note })), db)
    const s = summarizeSeat(done, (await getTripWithEvents(t.id, db))!.events)
    expect(s.final).toBe('seated')
    expect(s.standingMinutes).toBe(25) // 10분(탑승~10:10) + 15분(10:25~10:40)
  })

  it('이전 버전에서 저장한(note 필드가 없는) 이벤트도 그대로 읽히고 계산에 쓰인다', async () => {
    const db = newDb()
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '08:30', seatLogComplete: true })
    await db.trips.add(t)
    await db.seatEvents.add({ id: 'old1', tripId: t.id, time: '08:10', state: 'seated', place: '가역', createdAt: 1 }) // note 없음
    const got = (await getTripWithEvents(t.id, db))!
    expect(got.events[0].note).toBeUndefined()
    expect(summarizeSeat(got.trip, got.events).minutesToFirstSeat).toBe(10)
    // 수정 저장해도 값이 유지되고 note 는 null 로 정리
    await saveTrip(got.trip, got.events.map(({ time, state, place, note }) => ({ time, state, place, note })), db)
    expect((await getTripWithEvents(t.id, db))!.events[0]).toMatchObject({ time: '08:10', place: '가역', note: null })
  })

  it('note 가 없는 기존 JSON 백업을 그대로 읽는다', () => {
    const r = parseBackup(
      JSON.stringify({
        app: 'TransitLog',
        schemaVersion: 1,
        data: { trips: [mkTrip()], seatEvents: [{ id: 'e', tripId: 'x', time: null, state: 'seated', place: null, createdAt: 1 }], days: [], templates: [], settings: [] },
      }),
    )
    expect(r.ok).toBe(true)
  })
})
