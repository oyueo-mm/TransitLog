import { emptyTripDraft, type SeatEvent, type Trip } from '../src/domain/types'

let n = 0
/** 테스트용 가상 기록 (실제 개인 기록이 아님) */
export function mkTrip(p: Partial<Trip> = {}): Trip {
  n++
  return {
    ...emptyTripDraft('2026-03-02'),
    id: `t${n}`,
    createdAt: 1000 + n,
    updatedAt: 1000 + n,
    ...p,
  }
}
export function mkEvent(tripId: string, p: Partial<SeatEvent> = {}): SeatEvent {
  n++
  return { id: `e${n}`, tripId, time: null, state: 'seated', place: null, createdAt: 2000 + n, ...p }
}
