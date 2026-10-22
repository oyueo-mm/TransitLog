import { diffMinutes } from './time'
import type { DayLog, SeatEvent, SeatState, Trip } from './types'

/**
 * 좌석 지표 정의 (서로 다른 지표를 혼동하지 않기 위해 분리)
 *  - immediate : 탑승 시점에 앉아 있었는가 (initialSeat)
 *  - everSeated: 탑승 중 한 번이라도 앉았는가
 *  - final     : 하차 직전 상태
 * 근거가 부족하면 모두 null(미확인)로 남긴다.
 */
export interface SeatSummary {
  immediate: boolean | null
  everSeated: boolean | null
  final: SeatState | null
  /** 서서 탄 뒤 처음 앉기까지 걸린 분 (서서 탑승 → 이후 착석, 두 시각이 모두 있을 때만) */
  minutesToFirstSeat: number | null
  /** 서서 이동한 분 (좌석 기록이 완결이고 모든 시각이 있을 때만) */
  standingMinutes: number | null
}

/** 시각이 모두 있으면 탑승 시각 기준 경과 분으로 정렬, 아니면 입력 순서 유지 */
export function orderEvents(trip: Pick<Trip, 'boardTime'>, events: SeatEvent[]): SeatEvent[] {
  const byCreated = [...events].sort((a, b) => a.createdAt - b.createdAt)
  const allTimed = byCreated.every((e) => e.time) && !!trip.boardTime
  if (!allTimed) return byCreated
  return [...byCreated].sort(
    (a, b) => (diffMinutes(trip.boardTime, a.time) ?? 0) - (diffMinutes(trip.boardTime, b.time) ?? 0),
  )
}

export function summarizeSeat(trip: Trip, rawEvents: SeatEvent[]): SeatSummary {
  const events = orderEvents(trip, rawEvents)
  const initial = trip.initialSeat

  const immediate = initial === null ? null : initial === 'seated'

  let everSeated: boolean | null
  if (initial === 'seated' || events.some((e) => e.state === 'seated')) everSeated = true
  else if (initial === 'standing' && trip.seatLogComplete === true) everSeated = false
  else everSeated = null

  let final: SeatState | null = null
  if (events.length > 0) {
    // 마지막 변화 이후 기록이 더 없다는 확인이 있어야 최종 상태로 인정
    if (trip.seatLogComplete === true) final = events[events.length - 1].state
  } else if (trip.seatLogComplete === true) {
    final = initial
  }

  let minutesToFirstSeat: number | null = null
  if (initial === 'standing') {
    const first = events.find((e) => e.state === 'seated')
    if (first) minutesToFirstSeat = diffMinutes(trip.boardTime, first.time)
  }

  return {
    immediate,
    everSeated,
    final,
    minutesToFirstSeat,
    standingMinutes: standingMinutes(trip, events),
  }
}

function standingMinutes(trip: Trip, events: SeatEvent[]): number | null {
  if (trip.seatLogComplete !== true || trip.initialSeat === null) return null
  const total = tripDuration(trip, false)
  if (total === null || !trip.boardTime) return null
  let cur: SeatState = trip.initialSeat
  let t = 0
  let standing = 0
  for (const e of events) {
    const off = diffMinutes(trip.boardTime, e.time)
    if (off === null || off < t || off > total) return null
    if (cur === 'standing') standing += off - t
    cur = e.state
    t = off
  }
  if (cur === 'standing') standing += total - t
  return standing
}

/**
 * 개별 탑승 시간(분). 승차·하차 시각이 모두 있으면 계산, 없으면 원문에 적힌 값(허용 시), 아니면 null.
 */
export function tripDuration(trip: Trip, allowReported = true): number | null {
  if (trip.kind !== 'ride') return null
  const computed = diffMinutes(trip.boardTime, trip.alightTime)
  if (computed !== null) return computed
  return allowReported ? trip.reportedDurationMin : null
}

export interface DayTotals {
  /** 등교: 집 출발→학교 도착, 하교: 학교 출발→귀가. 환승·대기·도보 포함 */
  toSchoolTotal: number | null
  fromSchoolTotal: number | null
  /** 개별 탑승 시간의 합 (소요 시간을 알 수 있는 탑승만) */
  rideSum: number
  ridesWithDuration: number
  ridesTotal: number
}

export function dayTotals(day: DayLog | undefined, trips: Trip[]): DayTotals {
  const rides = trips.filter((t) => t.kind === 'ride')
  let rideSum = 0
  let ridesWithDuration = 0
  for (const r of rides) {
    const d = tripDuration(r)
    if (d !== null) {
      rideSum += d
      ridesWithDuration++
    }
  }
  return {
    toSchoolTotal: day ? diffMinutes(day.homeDepart, day.schoolArrive) : null,
    fromSchoolTotal: day ? diffMinutes(day.schoolDepart, day.homeArrive) : null,
    rideSum,
    ridesWithDuration,
    ridesTotal: rides.length,
  }
}
