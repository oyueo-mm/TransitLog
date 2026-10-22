import { describe, expect, it } from 'vitest'
import {
  averageDuration,
  byCarDoor,
  byTrainDestination,
  byWeekday,
  crowdingDistribution,
  ratio,
  rideRows,
  seatRatios,
} from '../src/domain/stats'
import { mkEvent, mkTrip } from './helpers'

describe('통계', () => {
  const a = mkTrip({ initialSeat: 'seated', car: 10, door: 3, trainDestination: '가', boardTime: '08:00', alightTime: '08:30', crowding: 'free' })
  const b = mkTrip({ initialSeat: 'standing', seatLogComplete: true, car: 10, door: 3, trainDestination: '가', boardTime: '08:00', alightTime: '08:40' })
  const c = mkTrip({ initialSeat: 'standing', car: 5, door: 1, trainDestination: '나' })
  const d = mkTrip({ initialSeat: null, car: null, door: null }) // 좌석·위치 모두 미기록
  const missed = mkTrip({ kind: 'missed', initialSeat: 'seated' })
  const observed = mkTrip({ kind: 'observed', initialSeat: 'seated' })
  const evs = [mkEvent(c.id, { time: '08:10', state: 'seated' })]
  const rows = rideRows([a, b, c, d, missed, observed], evs)

  it('탑승하지 않은 기록은 이동 횟수와 착석률에서 제외', () => {
    expect(rows).toHaveLength(4)
  })
  it('즉시 착석률: 좌석이 기록된 탑승만 분모', () => {
    const s = seatRatios(rows)
    expect(s.immediate.den).toBe(3)
    expect(s.immediate.num).toBe(1)
  })
  it('한 번이라도 착석: 앉은 기록 + 끝까지 서 있음이 확인된 기록만 분모', () => {
    const s = seatRatios(rows)
    // a(앉음), b(끝까지 서서: false), c(중간 착석: true), d(미확인 제외)
    expect(s.everSeated.den).toBe(3)
    expect(s.everSeated.num).toBe(2)
  })
  it('최종 착석률은 기록이 완결된 탑승만', () => {
    expect(seatRatios(rows).final.den).toBe(1)
  })
  it('칸·문별 집계는 위치가 없는 기록을 제외', () => {
    const g = byCarDoor(rows)
    expect(g.map((x) => x.key).sort()).toEqual(['10-3', '5-1'])
    expect(g.find((x) => x.key === '10-3')!.count).toBe(2)
  })
  it('행선지별 집계', () => {
    expect(byTrainDestination(rows).map((x) => x.key)).toEqual(['가', '나'])
  })
  it('평균 탑승 시간은 시각이 있는 기록만 (표본 수 함께)', () => {
    const avg = averageDuration(rows)
    expect(avg.n).toBe(2)
    expect(avg.avg).toBe(35)
  })
  it('혼잡도 분포는 기록된 것만', () => {
    expect(crowdingDistribution(rows).n).toBe(1)
  })
  it('요일별 집계', () => {
    expect(byWeekday(rows)[0].key).toBe('월')
  })
  it('표본이 없으면 비율은 null', () => {
    expect(ratio(0, 0).pct).toBeNull()
  })
})
