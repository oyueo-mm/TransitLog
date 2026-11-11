import { formatDuration } from '../domain/time'
import { tripDuration } from '../domain/seat'
import type { Trip } from '../domain/types'

/** 좌석 배지와 별도로 실제 기록된 승·하차 시각을 표시한다. */
export function RideTimes({ trip, showDate = false }: { trip: Trip; showDate?: boolean }) {
  const duration = tripDuration(trip)
  return (
    <div className="ride-times" data-testid="ride-times">
      {showDate && <span className="ride-times-date">{trip.date}</span>}
      {trip.kind === 'ride' ? (
        <>
          <span className="ride-times-part">승차 <strong>{trip.boardTime ?? '시각 미기록'}</strong></span>
          <span className="ride-times-arrow" aria-hidden="true">→</span>
          <span className="ride-times-part">하차 <strong className={trip.ongoing ? 'live' : ''}>{trip.ongoing ? '탑승 중' : trip.alightTime ?? '시각 미기록'}</strong></span>
          {duration !== null && <span className="ride-times-duration">· {formatDuration(duration)}{!trip.alightTime && <span className="ride-times-reported"> (소요 시간만 기록)</span>}</span>}
        </>
      ) : (
        <span className="ride-times-part">{trip.kind === 'observed' ? '관찰' : '놓침'} <strong>{trip.boardTime ?? '시각 미기록'}</strong></span>
      )}
    </div>
  )
}
