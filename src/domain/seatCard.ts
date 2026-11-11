import { orderEvents, summarizeSeat, type SeatSummary } from './seat'
import { currentSeat } from './seatLog'
import type { SeatEvent, Trip } from './types'

export type SeatCardTone = 'seated' | 'mid' | 'standing' | 'unknown'
export interface SeatCardInfo { label: string; tone: SeatCardTone; detail: string | null }

/** 카드에서는 관찰 사실만 강조하고, 기록되지 않은 착석 여부는 추정하지 않는다. */
export function seatCardInfo(trip: Trip, events: SeatEvent[], summary: SeatSummary = summarizeSeat(trip, events)): SeatCardInfo | null {
  if (trip.kind !== 'ride') return null
  if (trip.ongoing) {
    const current = currentSeat(trip, events)
    if (current === 'seated') return { label: '현재 앉아 있음', tone: 'seated', detail: null }
    if (current === 'standing') return { label: '현재 서 있음', tone: 'standing', detail: null }
    return { label: '좌석 미기록', tone: 'unknown', detail: null }
  }
  if (trip.initialSeat === 'seated') return { label: '처음부터 착석', tone: 'seated', detail: null }
  if (trip.initialSeat === 'standing') {
    if (summary.minutesToFirstSeat !== null) return { label: `${summary.minutesToFirstSeat}분 후 착석`, tone: 'mid', detail: '중간 착석' }
    if (events.some((e) => e.state === 'seated')) return { label: '중간 착석', tone: 'mid', detail: '착석 소요 시간 미확인' }
    if (summary.everSeated === false) return { label: '끝까지 서서 이동', tone: 'standing', detail: null }
    return { label: '서서 탑승 · 이후 미확인', tone: 'unknown', detail: null }
  }
  if (summary.everSeated === true) return { label: '착석 기록 있음', tone: 'mid', detail: '탑승 시 좌석 미기록' }
  return { label: '좌석 미기록', tone: 'unknown', detail: null }
}

/** 두 번 이상 상태가 바뀐 경우에만 간단한 변화 흐름을 부가 표시한다. */
export function seatChangePath(trip: Trip, events: SeatEvent[]): string | null {
  if (trip.kind !== 'ride' || events.length < 2) return null
  const states = [trip.initialSeat, ...orderEvents(trip, events).map((e) => e.state)]
  const labels = states.map((s, i) => s === null ? '좌석 미기록' : s === 'standing' ? (i === 0 ? '서서' : '기립') : '착석')
  return labels.join(' → ')
}
