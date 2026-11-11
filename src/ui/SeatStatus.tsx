import { seatCardInfo } from '../domain/seatCard'
import { summarizeSeat, type SeatSummary } from '../domain/seat'
import type { SeatEvent, Trip } from '../domain/types'

/** 오늘/캘린더/검색에서 같은 착석 요약과 색상을 사용한다. */
export function SeatStatus({ trip, events, summary }: { trip: Trip; events: SeatEvent[]; summary?: SeatSummary }) {
  const info = seatCardInfo(trip, events, summary ?? summarizeSeat(trip, events))
  if (!info) return null
  return (
    <div className={`seat-status seat-status-${info.tone}`} data-testid="seat-status" aria-label={`착석 상태: ${info.label}`}>
      <span className="seat-status-label">{info.label}</span>
      {info.detail && <span className="seat-status-detail">{info.detail}</span>}
    </div>
  )
}
