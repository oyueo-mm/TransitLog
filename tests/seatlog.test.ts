import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { TransitDB } from '../src/db/db'
import {
  addSeatEvent,
  captureSeatState,
  deleteSeatEvent,
  getTripWithEvents,
  restoreSeatState,
  saveTrip,
  setInitialSeat,
  startRide,
  updateSeatEvent,
} from '../src/db/repo'
import { MIN_COVERAGE, MIN_SAMPLE, sampleNote, seatCoverage } from '../src/domain/coverage'
import { orderEvents, summarizeSeat } from '../src/domain/seat'
import { currentSeat, nextCreatedAt, reconcileSeatLog, seatContentChanged } from '../src/domain/seatLog'
import { rideRows, seatRatios } from '../src/domain/stats'
import { emptyTripDraft, type SeatEvent } from '../src/domain/types'
import { mkEvent, mkTrip } from './helpers'

let n = 0
const newDb = () => new TransitDB(`seatlog-${++n}-${Math.random()}`)

async function ongoing(db: TransitDB, p: Partial<ReturnType<typeof emptyTripDraft>> = {}) {
  return startRide({ mode: 'subway', line: '1호선', boardTime: '17:23', initialSeat: 'standing', ...p }, [], db)
}
async function state(db: TransitDB, tripId: string) {
  const got = (await getTripWithEvents(tripId, db))!
  return { trip: got.trip, events: got.events, current: currentSeat(got.trip, got.events), summary: summarizeSeat(got.trip, got.events) }
}

describe('시나리오 1: 착석 이벤트 등록 → 수정 → 삭제 → 현재 상태 복구', () => {
  it('등록하면 현재 좌석이 바뀌고, 삭제하면 탑승 시 좌석 기준으로 되돌아온다', async () => {
    const db = newDb()
    const t = await ongoing(db)
    expect((await state(db, t.id)).current).toBe('standing')

    const ev = (await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db))!
    let s = await state(db, t.id)
    expect(s.current).toBe('seated')
    expect(s.summary.minutesToFirstSeat).toBe(7)
    expect(s.summary.everSeated).toBe(true)

    // 수정: 시각·역·비고 (식별자와 입력 순서는 그대로)
    const edited = (await updateSeatEvent(ev.id, { time: '17:32', place: '가역', note: '자리가 남음' }, db))!
    expect(edited).toMatchObject({ id: ev.id, createdAt: ev.createdAt, time: '17:32', place: '가역', note: '자리가 남음', state: 'seated' })
    s = await state(db, t.id)
    expect(s.summary.minutesToFirstSeat).toBe(9) // 첫 착석까지 걸린 시간도 즉시 갱신

    // 삭제 → 이벤트가 없어지고 탑승 시 좌석(서서)으로 복구
    const gone = (await deleteSeatEvent(ev.id, db))!
    expect(gone.id).toBe(ev.id)
    s = await state(db, t.id)
    expect(s.events).toHaveLength(0)
    expect(s.current).toBe('standing')
    expect(s.summary.minutesToFirstSeat).toBeNull()
    expect(s.summary.everSeated).toBeNull() // 끝까지 서 있었다는 확인은 없다
    // 탑승 기록 자체는 그대로
    expect(s.trip).toMatchObject({ id: t.id, line: '1호선', boardTime: '17:23', ongoing: true })
  })

  it('삭제는 해당 이벤트 하나만 지우고 다른 이벤트와 탑승 기록은 건드리지 않는다', async () => {
    const db = newDb()
    const t = await ongoing(db)
    const a = (await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: '가역', note: null }, db))!
    const b = (await addSeatEvent(t.id, { time: '17:40', state: 'standing', place: null, note: '혼잡' }, db))!
    await deleteSeatEvent(a.id, db)
    const s = await state(db, t.id)
    expect(s.events.map((e) => e.id)).toEqual([b.id])
    expect(s.events[0]).toMatchObject({ time: '17:40', state: 'standing', note: '혼잡' })
    expect(await db.trips.count()).toBe(1)
    expect(await deleteSeatEvent('없는-id', db)).toBeNull()
  })
})

describe('시나리오 2: 착석 → 일어섬 → 마지막 이벤트 삭제 → 착석 상태 복구', () => {
  it('마지막 이벤트를 지우면 그 이전 이벤트 기준으로 현재 좌석이 다시 계산된다', async () => {
    const db = newDb()
    const t = await ongoing(db)
    await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db)
    const last = (await addSeatEvent(t.id, { time: '17:45', state: 'standing', place: null, note: null }, db))!
    expect((await state(db, t.id)).current).toBe('standing')
    await deleteSeatEvent(last.id, db)
    expect((await state(db, t.id)).current).toBe('seated')
  })
  it('이벤트를 수정해 마지막 상태가 달라지면 현재 좌석도 따라간다', async () => {
    const db = newDb()
    const t = await ongoing(db)
    await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db)
    const b = (await addSeatEvent(t.id, { time: '17:45', state: 'standing', place: null, note: null }, db))!
    await updateSeatEvent(b.id, { state: 'seated' }, db) // 잘못 누른 '일어섬'을 '착석'으로 바로잡음
    expect((await state(db, t.id)).current).toBe('seated')
  })
})

describe('시나리오 3: 같은 분의 이벤트는 입력 순서와 식별자를 보존', () => {
  it('17:30 착석 → 17:30 일어섬이 모두 저장되고, 서 있음이 현재 상태', async () => {
    const db = newDb()
    const t = await ongoing(db)
    const a = (await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db))!
    const b = (await addSeatEvent(t.id, { time: '17:30', state: 'standing', place: null, note: null }, db))!
    expect(a.id).not.toBe(b.id)
    expect(b.createdAt).toBeGreaterThan(a.createdAt) // 같은 밀리초에 만들어도 입력 순서가 뒤바뀌지 않는다
    const s = await state(db, t.id)
    expect(s.events).toHaveLength(2)
    expect(orderEvents(s.trip, s.events).map((e) => e.id)).toEqual([a.id, b.id])
    expect(s.current).toBe('standing')
    // 시각을 같은 분으로 고쳐도 순서는 유지
    await updateSeatEvent(a.id, { time: '17:30' }, db)
    expect(orderEvents(s.trip, (await state(db, t.id)).events).map((e) => e.id)).toEqual([a.id, b.id])
  })

  it('같은 분의 착석→일어섬→착석을 저장해도 하나로 합쳐지지 않는다', async () => {
    const db = newDb()
    const t = await saveTrip(
      { ...emptyTripDraft('2026-03-02'), boardTime: '17:23', initialSeat: 'standing' },
      [
        { time: '17:30', state: 'seated', place: null, note: null },
        { time: '17:30', state: 'standing', place: null, note: null },
        { time: '17:30', state: 'seated', place: null, note: null },
      ],
      db,
    )
    const s = await state(db, t.id)
    expect(s.events.map((e) => e.state)).toEqual(['seated', 'standing', 'seated'])
    expect(new Set(s.events.map((e) => e.id)).size).toBe(3)
    expect(s.current).toBe('seated')
  })

  it('기존 이벤트를 다시 저장해도 식별자가 유지된다', async () => {
    const db = newDb()
    const t = await ongoing(db)
    const a = (await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db))!
    const b = (await addSeatEvent(t.id, { time: '17:31', state: 'standing', place: null, note: null }, db))!
    const got = (await getTripWithEvents(t.id, db))!
    await saveTrip(got.trip, got.events.map(({ id, time, state: st, place, note }) => ({ id, time, state: st, place, note })), db)
    expect((await state(db, t.id)).events.map((e) => e.id)).toEqual([a.id, b.id])
  })

  it('같은 식별자가 두 번 들어오면 두 번째에는 새 식별자를 준다', async () => {
    const db = newDb()
    const t = await saveTrip(
      { ...emptyTripDraft('2026-03-02') },
      [
        { id: 'x', time: '17:30', state: 'seated', place: null },
        { id: 'x', time: '17:31', state: 'standing', place: null },
      ],
      db,
    )
    expect(new Set((await state(db, t.id)).events.map((e) => e.id)).size).toBe(2)
  })
})

describe('시나리오 4: 버튼 연타로 인한 중복 이벤트 방지', () => {
  it('동시에 같은 요청이 여러 번 들어와도 이벤트는 하나만 생긴다', async () => {
    const db = newDb()
    const t = await ongoing(db)
    const results = await Promise.all(Array.from({ length: 5 }, () => addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await state(db, t.id)).events).toHaveLength(1)
  })
  it('이미 앉아 있는데 또 앉았다를 눌러도 만들어지지 않고, 서 있을 때 일어섰다도 마찬가지', async () => {
    const db = newDb()
    const t = await ongoing(db)
    expect(await addSeatEvent(t.id, { time: '17:30', state: 'standing', place: null, note: null }, db)).toBeNull() // 이미 서 있음
    await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db)
    expect(await addSeatEvent(t.id, { time: '17:31', state: 'seated', place: null, note: null }, db)).toBeNull()
    expect((await state(db, t.id)).events).toHaveLength(1)
  })
  it('빠르게 번갈아 누른 서로 다른 동작은 모두 기록된다', async () => {
    const db = newDb()
    const t = await ongoing(db)
    await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db)
    await addSeatEvent(t.id, { time: '17:30', state: 'standing', place: null, note: null }, db)
    await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db)
    expect((await state(db, t.id)).events.map((e) => e.state)).toEqual(['seated', 'standing', 'seated'])
  })
  it('좌석 기록이 아직 없는 탑승은 앉았다/일어섰다 어느 쪽도 처음에는 기록할 수 있다', async () => {
    const db = newDb()
    const t = await startRide({ mode: 'subway', boardTime: '17:23' }, [], db)
    expect(await addSeatEvent(t.id, { time: '17:30', state: 'standing', place: null, note: null }, db)).not.toBeNull()
  })
})

describe('시나리오 5: 이벤트 수정·삭제 후 통계 재계산', () => {
  it('착석 이벤트를 지우면 한 번이라도 착석 통계에서 빠지고, 다시 복구하면 돌아온다', async () => {
    const db = newDb()
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: '17:23', alightTime: '18:00', initialSeat: 'standing', seatLogComplete: true }, [{ time: '17:30', state: 'seated', place: null, note: null }], db)
    const stats = async () => {
      const trips = await db.trips.toArray()
      const events = await db.seatEvents.toArray()
      return seatRatios(rideRows(trips, events))
    }
    let r = await stats()
    expect([r.everSeated.num, r.everSeated.den, r.final.num, r.final.den]).toEqual([1, 1, 1, 1])

    const snap = (await captureSeatState(t.id, db))!
    const ev = (await state(db, t.id)).events[0]
    await deleteSeatEvent(ev.id, db)
    r = await stats()
    // 삭제로 완결 확인이 해제되었으므로 '서서 갔다'로 추정하지 않고 표본에서 제외된다
    expect([r.everSeated.den, r.final.den, r.immediate.den]).toEqual([0, 0, 1])

    await restoreSeatState(snap, db)
    r = await stats()
    expect([r.everSeated.num, r.everSeated.den, r.final.num, r.final.den]).toEqual([1, 1, 1, 1])
  })

  it('시각을 수정하면 첫 착석까지·서서 이동 시간 통계가 바뀐다', async () => {
    const db = newDb()
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: '17:00', alightTime: '17:40', initialSeat: 'standing', seatLogComplete: true }, [{ time: '17:10', state: 'seated', place: null, note: null }], db)
    expect((await state(db, t.id)).summary).toMatchObject({ minutesToFirstSeat: 10, standingMinutes: 10 })
    const ev = (await state(db, t.id)).events[0]
    await updateSeatEvent(ev.id, { time: '17:25' }, db)
    const s = await state(db, t.id)
    expect(s.summary.minutesToFirstSeat).toBe(25)
    // 시각이 바뀌어 완결 확인이 해제되었으므로 서서 이동 시간은 미확인
    expect(s.summary.standingMinutes).toBeNull()
  })
})

describe('시나리오 6: 좌석 기록 완결 여부(seatLogComplete)가 부정확하게 남지 않는다', () => {
  const confirmed = async (db: TransitDB) => {
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: '17:00', alightTime: '17:40', initialSeat: 'standing', seatLogComplete: true }, [{ time: '17:10', state: 'seated', place: '가역', note: null }], db)
    return { t, ev: (await state(db, t.id)).events[0] }
  }
  it('이벤트를 추가·삭제하면 해제', async () => {
    const db = newDb()
    const { t, ev } = await confirmed(db)
    await addSeatEvent(t.id, { time: '17:20', state: 'standing', place: null, note: null }, db)
    expect((await state(db, t.id)).trip.seatLogComplete).toBeNull()
    await saveTrip({ ...(await state(db, t.id)).trip, seatLogComplete: true }, undefined, db)
    await deleteSeatEvent(ev.id, db)
    expect((await state(db, t.id)).trip.seatLogComplete).toBeNull()
  })
  it('상태나 시각을 고치면 해제, 역·비고만 고치면 유지', async () => {
    const db = newDb()
    const { t, ev } = await confirmed(db)
    await updateSeatEvent(ev.id, { place: '나역', note: '메모' }, db)
    expect((await state(db, t.id)).trip.seatLogComplete).toBe(true)
    await updateSeatEvent(ev.id, { time: '17:12' }, db)
    expect((await state(db, t.id)).trip.seatLogComplete).toBeNull()
    await saveTrip({ ...(await state(db, t.id)).trip, seatLogComplete: true }, undefined, db)
    await updateSeatEvent(ev.id, { state: 'standing' }, db)
    expect((await state(db, t.id)).trip.seatLogComplete).toBeNull()
  })
  it('탑승 시 좌석을 바꾸면 해제', async () => {
    const db = newDb()
    const { t } = await confirmed(db)
    await setInitialSeat(t.id, 'seated', db)
    expect((await state(db, t.id)).trip).toMatchObject({ initialSeat: 'seated', seatLogComplete: null })
  })
  it('순수 규칙: 내용이 달라졌을 때만 확인을 해제', () => {
    const ev = [{ time: '17:10', state: 'seated' as const }]
    const prev = { initialSeat: 'standing' as const, events: ev, seatLogComplete: true as boolean | null }
    expect(reconcileSeatLog(prev, { initialSeat: 'standing', events: [...ev] })).toBe(true)
    expect(reconcileSeatLog(prev, { initialSeat: 'standing', events: [] })).toBeNull()
    expect(reconcileSeatLog(prev, { initialSeat: 'standing', events: [{ time: '17:11', state: 'seated' }] })).toBeNull()
    expect(reconcileSeatLog(prev, { initialSeat: 'seated', events: ev })).toBeNull()
    expect(reconcileSeatLog({ ...prev, seatLogComplete: false }, { initialSeat: 'standing', events: ev })).toBe(false)
    expect(seatContentChanged({ initialSeat: null, events: [] }, { initialSeat: null, events: [] })).toBe(false)
  })
})

describe('실행 취소 (스냅숏 복원)', () => {
  it('삭제를 취소하면 같은 식별자·순서·완결 상태로 복원되고 다른 이벤트는 그대로다', async () => {
    const db = newDb()
    const t = await saveTrip({ ...emptyTripDraft('2026-03-02'), boardTime: '17:00', initialSeat: 'standing', seatLogComplete: true }, [
      { time: '17:10', state: 'seated', place: '가역', note: '메모' },
      { time: '17:20', state: 'standing', place: null, note: null },
    ], db)
    const before = (await state(db, t.id)).events
    const snap = (await captureSeatState(t.id, db))!
    await deleteSeatEvent(before[0].id, db)
    await restoreSeatState(snap, db)
    const after = await state(db, t.id)
    expect(after.events).toEqual(before) // id, createdAt, 내용 모두 동일
    expect(after.trip.seatLogComplete).toBe(true)
  })
  it('수정·추가를 취소하면 이전 상태로 돌아가고, 탑승 기록의 다른 값은 건드리지 않는다', async () => {
    const db = newDb()
    const t = await ongoing(db, { note: '탑승 메모' })
    const a = (await addSeatEvent(t.id, { time: '17:30', state: 'seated', place: null, note: null }, db))!
    const snap1 = (await captureSeatState(t.id, db))!
    await updateSeatEvent(a.id, { time: '17:50', note: '바꿈' }, db)
    await restoreSeatState(snap1, db)
    expect((await state(db, t.id)).events[0]).toMatchObject({ id: a.id, time: '17:30', note: null })

    const snap2 = (await captureSeatState(t.id, db))!
    await addSeatEvent(t.id, { time: '17:40', state: 'standing', place: null, note: null }, db)
    await restoreSeatState(snap2, db)
    const s = await state(db, t.id)
    expect(s.events).toHaveLength(1)
    expect(s.current).toBe('seated')
    expect(s.trip.note).toBe('탑승 메모')
  })
  it('삭제된 탑승에는 복원하지 않는다', async () => {
    const db = newDb()
    const t = await ongoing(db)
    const snap = (await captureSeatState(t.id, db))!
    await db.trips.delete(t.id)
    await restoreSeatState(snap, db)
    expect(await db.seatEvents.count()).toBe(0)
  })
})

describe('순서 번호', () => {
  it('nextCreatedAt 은 같은 밀리초에도 항상 앞선 이벤트보다 크다', () => {
    const e = [{ createdAt: 100 }, { createdAt: 105 }]
    expect(nextCreatedAt(e, 90)).toBe(106)
    expect(nextCreatedAt(e, 200)).toBe(200)
    expect(nextCreatedAt([], 50)).toBe(50)
  })
})

describe('판정 가능 표본과 해석 주의', () => {
  const row = (p: Partial<ReturnType<typeof mkTrip>>, ev: Array<Partial<SeatEvent>> = []) => {
    const t = mkTrip({ boardTime: '08:00', alightTime: '08:30', ...p })
    return { t, ev: ev.map((e) => mkEvent(t.id, e)) }
  }
  it('지표마다 판정된 건수와 제외 사유를 센다 (미확인을 어느 쪽으로도 추정하지 않는다)', () => {
    const list = [
      row({ initialSeat: 'seated' }), // 즉시 ✓ 한번이라도 ✓ 최종 ✗
      row({ initialSeat: 'standing', seatLogComplete: true }, [{ time: '08:10', state: 'seated' }]), // ✓ ✓ ✓
      row({ initialSeat: 'standing', seatLogComplete: true }), // ✓ 끝까지 서서 ✓
      row({ initialSeat: 'standing' }), // 즉시 ✓, 한번이라도 제외(확인 안 함), 최종 제외
      row({ initialSeat: null }), // 전부 제외
      row({ kind: 'missed', initialSeat: 'seated' }), // 탑승 아님
    ]
    const rows = rideRows(list.map((x) => x.t), list.flatMap((x) => x.ev))
    const c = seatCoverage(rows)
    expect(c.total).toBe(5)
    expect(c.immediate).toEqual({ known: 4, unknown: 1 })
    expect(c.ever).toEqual({ seated: 2, stoodAll: 1, unconfirmedStanding: 1, unknown: 1 })
    expect(c.final).toEqual({ known: 2, unconfirmed: 3 })
  })
  it('표본이 적은 100%(1/1)는 표본 부족, 일부만 판정된 비율은 일부 판정으로 알린다', () => {
    expect(sampleNote(1, 1)).toMatchObject({ insufficient: true, excluded: 0 })
    expect(sampleNote(1, 220)).toMatchObject({ insufficient: true, excluded: 219 })
    expect(sampleNote(96, 210)).toMatchObject({ insufficient: false, partial: true, excluded: 114, coveragePct: 46 })
    expect(sampleNote(68, 210).partial).toBe(true)
    expect(sampleNote(MIN_SAMPLE, MIN_SAMPLE * 2)).toMatchObject({ insufficient: false, partial: false })
    expect(sampleNote(0, 5)).toMatchObject({ insufficient: false, partial: false, excluded: 5 })
    expect(MIN_COVERAGE).toBe(0.5)
  })
})
