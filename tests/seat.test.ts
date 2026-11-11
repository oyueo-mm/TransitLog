import { describe, expect, it } from 'vitest'
import { dayTotals, isSeatLogComplete, summarizeSeat, tripDuration } from '../src/domain/seat'
import { mkEvent, mkTrip } from './helpers'

describe('좌석 변화 계산', () => {
  it('서서 탑승 → 중간 착석 → 하차: 모든 지표를 계산', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:24', alightTime: '09:20', seatLogComplete: true })
    const s = summarizeSeat(t, [mkEvent(t.id, { time: '08:30', state: 'seated', place: '가역' })])
    expect(s.immediate).toBe(false)
    expect(s.everSeated).toBe(true)
    expect(s.final).toBe('seated')
    expect(s.minutesToFirstSeat).toBe(6)
    expect(s.standingMinutes).toBe(6)
  })

  it('하차 후에 기록된 착석 이벤트는 착석까지 소요 시간에서 제외한다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '08:30' })
    const result = summarizeSeat(t, [mkEvent(t.id, { time: '08:45', state: 'seated' })])
    expect(result.minutesToFirstSeat).toBeNull()
  })
  it('앉았다 일어선 경우 서서 이동한 시간은 서 있던 구간의 합', () => {
    const t = mkTrip({ initialSeat: 'seated', boardTime: '10:00', alightTime: '10:40', seatLogComplete: true })
    const s = summarizeSeat(t, [
      mkEvent(t.id, { time: '10:10', state: 'standing' }),
      mkEvent(t.id, { time: '10:25', state: 'seated' }),
    ])
    expect(s.immediate).toBe(true)
    expect(s.final).toBe('seated')
    expect(s.standingMinutes).toBe(15)
    expect(s.minutesToFirstSeat).toBeNull() // 서서 탑승이 아니므로 해당 없음
  })

  it('자정을 넘기는 탑승의 서서 이동 시간', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '23:40', alightTime: '00:30', seatLogComplete: true })
    const s = summarizeSeat(t, [mkEvent(t.id, { time: '23:55', state: 'seated' })])
    expect(s.minutesToFirstSeat).toBe(15)
    expect(s.standingMinutes).toBe(15)
  })

  it('좌석 정보가 없으면 서서 감으로 단정하지 않는다', () => {
    const s = summarizeSeat(mkTrip({ boardTime: '08:00', alightTime: '08:30' }), [])
    expect(s.immediate).toBeNull()
    expect(s.everSeated).toBeNull()
    expect(s.final).toBeNull()
  })

  it('하차가 아직 확인되지 않은 서서 탑승은 끝까지 서서 갔다고 보지 않는다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: null, ongoing: true })
    const s = summarizeSeat(t, [])
    expect(s.immediate).toBe(false)
    expect(s.everSeated).toBeNull()
    expect(s.final).toBeNull()
    expect(s.standingMinutes).toBeNull()
  })

  it('과거 기록도 하차 완료 시 자동으로 좌석 로그가 완결된다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '08:30', seatLogComplete: null })
    const s = summarizeSeat(t, [])
    expect(isSeatLogComplete(t)).toBe(true)
    expect(s).toMatchObject({ immediate: false, everSeated: false, final: 'standing', standingMinutes: 30 })
    const seated = mkTrip({ initialSeat: 'seated', boardTime: '08:00', alightTime: '08:30', seatLogComplete: false })
    expect(summarizeSeat(seated, []).final).toBe('seated')
    const ongoing = mkTrip({ ongoing: true, initialSeat: 'standing', alightTime: '08:30' })
    expect(isSeatLogComplete(ongoing)).toBe(false)
    expect(summarizeSeat(ongoing, []).everSeated).toBeNull()
  })

  it('하차 시각이 없는 종료 기록도 마지막 좌석 상태를 유지한다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '21:54', alightTime: null, ongoing: false, seatLogComplete: null, reportedDurationMin: 35 })
    expect(isSeatLogComplete(t)).toBe(true)
    expect(summarizeSeat(t, [])).toMatchObject({ immediate: false, everSeated: false, final: 'standing', standingMinutes: null })
    const sitting = mkTrip({ initialSeat: 'seated', ongoing: false, alightTime: null, seatLogComplete: false })
    expect(summarizeSeat(sitting, [])).toMatchObject({ everSeated: true, final: 'seated' })
  })

  it('변화 없음이 확인되면 끝까지 서서 감', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '08:30', seatLogComplete: true })
    const s = summarizeSeat(t, [])
    expect(s.everSeated).toBe(false)
    expect(s.final).toBe('standing')
    expect(s.standingMinutes).toBe(30)
  })

  it('필요한 시각이 빠져 있으면 계산값도 미확인으로 남긴다', () => {
    const noAlight = mkTrip({ initialSeat: 'standing', boardTime: '08:00', seatLogComplete: true })
    expect(summarizeSeat(noAlight, [mkEvent(noAlight.id, { time: '08:10' })]).standingMinutes).toBeNull()

    const noEventTime = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '08:30', seatLogComplete: true })
    const s = summarizeSeat(noEventTime, [mkEvent(noEventTime.id, { time: null })])
    expect(s.everSeated).toBe(true)
    expect(s.minutesToFirstSeat).toBeNull()
    expect(s.standingMinutes).toBeNull()
  })

  it('아직 하차하지 않았다면 좌석 이벤트가 있어도 최종 상태는 미확인', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: null, ongoing: true })
    const s = summarizeSeat(t, [mkEvent(t.id, { time: '08:10' })])
    expect(s.everSeated).toBe(true)
    expect(s.final).toBeNull()
  })
})

describe('소요 시간·하루 합계', () => {
  it('승차 시각만 있으면 하차 시각과 소요 시간은 비워 둔다', () => {
    expect(tripDuration(mkTrip({ boardTime: '08:00' }))).toBeNull()
  })
  it('원문에 적힌 소요 시간은 시각이 없을 때만 보조로 사용', () => {
    expect(tripDuration(mkTrip({ reportedDurationMin: 40 }))).toBe(40)
    expect(tripDuration(mkTrip({ boardTime: '08:00', alightTime: '08:30', reportedDurationMin: 99 }))).toBe(30)
  })
  it('놓침·관찰 기록은 소요 시간이 없다', () => {
    expect(tripDuration(mkTrip({ kind: 'missed', boardTime: '08:00', alightTime: '08:10' }))).toBeNull()
  })
  it('하루 전체 이동 시간과 개별 탑승 시간의 합을 구분', () => {
    const trips = [
      mkTrip({ boardTime: '08:10', alightTime: '08:40' }),
      mkTrip({ boardTime: '08:50', alightTime: '09:20' }),
      mkTrip({ boardTime: '09:30' }), // 하차 시각 없음 → 합계에서 제외
      mkTrip({ kind: 'observed', boardTime: '09:40' }),
    ]
    const day = { date: '2026-03-02', homeDepart: '07:50', schoolArrive: '09:45', schoolDepart: null, homeArrive: '19:00', note: null, updatedAt: 0 }
    const d = dayTotals(day, trips)
    expect(d.toSchoolTotal).toBe(115) // 환승·대기·도보 포함
    expect(d.rideSum).toBe(60) // 탑승 시간만
    expect(d.ridesWithDuration).toBe(2)
    expect(d.ridesTotal).toBe(3)
    expect(d.fromSchoolTotal).toBeNull() // 학교 출발 시각이 없으면 계산하지 않음
  })
})
