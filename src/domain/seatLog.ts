import { orderEvents } from './seat'
import type { SeatEvent, SeatEventDraft, SeatState, Trip } from './types'

/**
 * 좌석 변화 기록의 정합성 규칙 (순수 함수).
 *
 * seatLogComplete(= '좌석 변화 기록이 완결됨')는 *그 시점의 이벤트 목록*에 대한 확인이다.
 * 이벤트의 개수·상태·시각이 바뀌거나 탑승 시 좌석이 바뀌면 이전 확인은 더 이상 사실이 아니므로
 * 미확인(null)으로 되돌린다. 역·비고만 고친 경우는 완결 여부와 무관하므로 유지한다.
 */
type Sig = Pick<SeatEventDraft, 'state' | 'time'>

const sig = (events: Sig[]) => events.map((e) => `${e.state}@${e.time ?? ''}`).join('|')

export function seatContentChanged(
  prev: { initialSeat: SeatState | null; events: Sig[] },
  next: { initialSeat: SeatState | null; events: Sig[] },
): boolean {
  return prev.initialSeat !== next.initialSeat || sig(prev.events) !== sig(next.events)
}

/** 이벤트·초기 좌석이 바뀌었으면 완결 확인을 해제한 값을 돌려준다 */
export function reconcileSeatLog(
  prev: { initialSeat: SeatState | null; events: Sig[]; seatLogComplete: boolean | null },
  next: { initialSeat: SeatState | null; events: Sig[] },
): boolean | null {
  return seatContentChanged(prev, next) ? null : prev.seatLogComplete
}

/**
 * 탑승 중 시점의 현재 좌석: 시간순(같은 분이면 입력 순서)으로 마지막 이벤트의 상태,
 * 이벤트가 없으면 탑승 시 좌석. 이벤트를 지우거나 고친 뒤에도 같은 규칙으로 다시 계산된다.
 */
export function currentSeat(trip: Pick<Trip, 'boardTime' | 'initialSeat'>, events: SeatEvent[]): SeatState | null {
  const o = orderEvents(trip, events)
  return o.length ? o[o.length - 1].state : trip.initialSeat
}

/** 같은 탑승의 이벤트 중 가장 늦은 createdAt 다음 값. 같은 밀리초에 만들어도 입력 순서가 뒤바뀌지 않게 한다 */
export function nextCreatedAt(existing: Array<Pick<SeatEvent, 'createdAt'>>, now = Date.now()): number {
  const max = existing.reduce((m, e) => Math.max(m, e.createdAt), 0)
  return Math.max(now, max + 1)
}
