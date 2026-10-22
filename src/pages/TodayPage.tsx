import { Link } from 'react-router-dom'
import { todayStr } from '../domain/time'
import { DayView } from './DayView'
import { useAllTrips, useNow, useOngoing, useSetting } from '../ui/hooks'

const WEEK_MS = 7 * 86_400_000

/** 데이터가 있는데 최근 백업이 없으면 눈에 띄게 알린다 */
export function BackupBanner() {
  const trips = useAllTrips()
  const [last] = useSetting<number | null>('lastBackupAt', null)
  const now = useNow(60_000).getTime()
  if (!trips || trips.length === 0) return null
  const stale = last === null || now - last > WEEK_MS
  if (!stale) return null
  return (
    <Link to="/settings" className="banner warn">
      <strong>백업이 필요해요.</strong>{' '}
      {last === null ? '아직 백업한 적이 없습니다.' : `마지막 백업이 ${Math.floor((now - last) / 86_400_000)}일 전입니다.`} 기기를 바꾸거나 브라우저 데이터를
      지우면 기록이 사라질 수 있어요. ›
    </Link>
  )
}

export function TodayPage() {
  const ongoing = useOngoing()
  return (
    <>
      {ongoing?.trip && (
        <Link to="/quick" className="banner live">
          <strong>탑승 중</strong> · {ongoing.trip.line ?? '노선 미기록'} {ongoing.trip.boardTime}~ — 하차를 기록하려면 눌러 주세요 ›
        </Link>
      )}
      <BackupBanner />
      <DayView date={todayStr()} />
    </>
  )
}
