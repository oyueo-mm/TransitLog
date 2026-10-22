import { hourBucket, HOUR_BUCKETS, monthKey, weekStart, WEEKDAY_NAMES, weekdayIndex } from './time'
import { summarizeSeat, tripDuration, type SeatSummary } from './seat'
import type { Crowding, SeatEvent, Trip } from './types'

/**
 * 통계. 실제 탑승(kind === 'ride')만 대상으로 하고, 값이 없는(null) 기록은
 * 해당 지표의 표본에서 제외한다. 모든 비율은 분자/분모(표본 수)와 함께 반환한다.
 */
export interface Ratio {
  num: number
  den: number
  /** 0~100. 표본이 없으면 null */
  pct: number | null
}
export function ratio(num: number, den: number): Ratio {
  return { num, den, pct: den === 0 ? null : (num / den) * 100 }
}

export interface Avg {
  avg: number | null
  n: number
}
export function average(values: Array<number | null>): Avg {
  const v = values.filter((x): x is number => x !== null)
  return { avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, n: v.length }
}

export interface RideRow {
  trip: Trip
  seat: SeatSummary
}

export function rideRows(trips: Trip[], events: SeatEvent[]): RideRow[] {
  const byTrip = new Map<string, SeatEvent[]>()
  for (const e of events) {
    const arr = byTrip.get(e.tripId)
    if (arr) arr.push(e)
    else byTrip.set(e.tripId, [e])
  }
  return trips
    .filter((t) => t.kind === 'ride')
    .map((trip) => ({ trip, seat: summarizeSeat(trip, byTrip.get(trip.id) ?? []) }))
}

export interface SeatRatios {
  immediate: Ratio
  everSeated: Ratio
  final: Ratio
}
export function seatRatios(rows: RideRow[]): SeatRatios {
  const imm = rows.filter((r) => r.seat.immediate !== null)
  const ever = rows.filter((r) => r.seat.everSeated !== null)
  const fin = rows.filter((r) => r.seat.final !== null)
  return {
    immediate: ratio(imm.filter((r) => r.seat.immediate).length, imm.length),
    everSeated: ratio(ever.filter((r) => r.seat.everSeated).length, ever.length),
    final: ratio(fin.filter((r) => r.seat.final === 'seated').length, fin.length),
  }
}

export interface Group {
  key: string
  count: number
  seat: SeatRatios
}

/** 키 함수로 묶어 그룹별 탑승 수와 착석 지표를 계산. 키가 null이면 그룹에서 제외 */
export function groupBy(rows: RideRow[], keyOf: (r: RideRow) => string | null): Group[] {
  const map = new Map<string, RideRow[]>()
  for (const r of rows) {
    const k = keyOf(r)
    if (k === null) continue
    const arr = map.get(k)
    if (arr) arr.push(r)
    else map.set(k, [r])
  }
  return [...map.entries()]
    .map(([key, rs]) => ({ key, count: rs.length, seat: seatRatios(rs) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'ko'))
}

export const byWeekday = (rows: RideRow[]) => {
  const g = groupBy(rows, (r) => WEEKDAY_NAMES[weekdayIndex(r.trip.date)])
  const order = ['월', '화', '수', '목', '금', '토', '일']
  return g.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
}
export const byHourBucket = (rows: RideRow[]) =>
  groupBy(rows, (r) => hourBucket(r.trip.boardTime)).sort(
    (a, b) => HOUR_BUCKETS.indexOf(a.key) - HOUR_BUCKETS.indexOf(b.key),
  )
export const byTrainDestination = (rows: RideRow[]) =>
  groupBy(rows.filter((r) => r.trip.mode === 'subway'), (r) => r.trip.trainDestination)
export const byCarDoor = (rows: RideRow[]) =>
  groupBy(rows.filter((r) => r.trip.mode === 'subway'), (r) =>
    r.trip.car !== null && r.trip.door !== null ? `${r.trip.car}-${r.trip.door}` : null,
  )
export const byCar = (rows: RideRow[]) =>
  groupBy(rows.filter((r) => r.trip.mode === 'subway'), (r) =>
    r.trip.car !== null ? `${r.trip.car}칸` : null,
  )
export const byLine = (rows: RideRow[]) => groupBy(rows, (r) => r.trip.line)
export const byRoute = (rows: RideRow[]) =>
  groupBy(rows, (r) =>
    r.trip.boardPlace && r.trip.alightPlace ? `${r.trip.boardPlace} → ${r.trip.alightPlace}` : null,
  )
export const byMode = (rows: RideRow[]) =>
  groupBy(rows, (r) => (r.trip.mode === 'subway' ? '지하철' : '버스'))

export function countBy(trips: Trip[], keyOf: (t: Trip) => string): Array<{ key: string; count: number }> {
  const map = new Map<string, number>()
  for (const t of trips) {
    const k = keyOf(t)
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key))
}
export const ridesPerDay = (rows: RideRow[]) => countBy(rows.map((r) => r.trip), (t) => t.date)
export const ridesPerWeek = (rows: RideRow[]) => countBy(rows.map((r) => r.trip), (t) => weekStart(t.date))
export const ridesPerMonth = (rows: RideRow[]) => countBy(rows.map((r) => r.trip), (t) => monthKey(t.date))

export function crowdingDistribution(rows: RideRow[]): { dist: Record<Crowding, number>; n: number } {
  const dist: Record<Crowding, number> = { free: 0, normal: 0, crowded: 0, very_crowded: 0 }
  let n = 0
  for (const r of rows) {
    if (r.trip.crowding) {
      dist[r.trip.crowding]++
      n++
    }
  }
  return { dist, n }
}

export function averageDuration(rows: RideRow[]): Avg {
  return average(rows.map((r) => tripDuration(r.trip)))
}
export function averageMinutesToFirstSeat(rows: RideRow[]): Avg {
  return average(rows.map((r) => r.seat.minutesToFirstSeat))
}
export function averageStandingMinutes(rows: RideRow[]): Avg {
  return average(rows.map((r) => r.seat.standingMinutes))
}

export function activityCounts(trips: Trip[]) {
  return {
    ride: trips.filter((t) => t.kind === 'ride').length,
    missed: trips.filter((t) => t.kind === 'missed').length,
    observed: trips.filter((t) => t.kind === 'observed').length,
  }
}
