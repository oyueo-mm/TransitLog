import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { addDays, formatDuration, nowHm, parseDate, todayStr, weekdayKo } from '../domain/time'
import { dayTotals } from '../domain/seat'
import { sortTrips, saveDay } from '../db/repo'
import { PURPOSE_LABEL, type DayLog, type Purpose } from '../domain/types'
import { Chip, Empty, Section, TripCard } from '../ui/common'
import { useAllEvents, useDay, useTripsOn } from '../ui/hooks'

function dateTitle(date: string): string {
  const d = parseDate(date)
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${weekdayKo(date)})`
}

type DayField = 'homeDepart' | 'schoolArrive' | 'schoolDepart' | 'homeArrive'
const DAY_FIELDS: Array<{ key: DayField; label: string }> = [
  { key: 'homeDepart', label: '집 출발' },
  { key: 'schoolArrive', label: '학교 도착' },
  { key: 'schoolDepart', label: '학교 출발' },
  { key: 'homeArrive', label: '귀가(집 도착)' },
]

function DayTimes({ date, day }: { date: string; day: DayLog | undefined }) {
  return (
    <div className="daytimes">
      {DAY_FIELDS.map((f) => {
        const v = day?.[f.key] ?? null
        return (
          <div className="daytime" key={f.key}>
            <label htmlFor={`day-${f.key}`}>{f.label}</label>
            <div className="field-row">
              <input
                id={`day-${f.key}`}
                type="time"
                value={v ?? ''}
                onChange={(e) => void saveDay(date, { [f.key]: e.target.value || null })}
              />
              <button type="button" className="btn-small" onClick={() => void saveDay(date, { [f.key]: nowHm() })}>
                지금
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function DayView({ date, showNav }: { date: string; showNav?: boolean }) {
  const nav = useNavigate()
  const trips = useTripsOn(date)
  const events = useAllEvents()
  const day = useDay(date)
  const [purpose, setPurpose] = useState<Purpose | 'all'>('all')

  const sorted = useMemo(() => sortTrips(trips ?? []), [trips])
  const shown = purpose === 'all' ? sorted : sorted.filter((t) => t.purpose === purpose)
  const evByTrip = useMemo(() => {
    const m = new Map<string, NonNullable<typeof events>>()
    for (const e of events ?? []) m.set(e.tripId, [...(m.get(e.tripId) ?? []), e])
    return m
  }, [events])
  const totals = dayTotals(day, sorted)
  const isToday = date === todayStr()

  return (
    <div className="page">
      <header className="page-head">
        {showNav ? (
          <div className="datenav">
            <button className="btn-icon" aria-label="전날" onClick={() => nav(`/day/${addDays(date, -1)}`)}>
              ‹
            </button>
            <div>
              <h1>{dateTitle(date)}</h1>
              <div className="muted small">{date}</div>
            </div>
            <button className="btn-icon" aria-label="다음날" onClick={() => nav(`/day/${addDays(date, 1)}`)}>
              ›
            </button>
          </div>
        ) : (
          <>
            <h1>오늘의 기록</h1>
            <div className="muted">{dateTitle(date)}</div>
          </>
        )}
      </header>

      <Section title="하루 기록">
        <DayTimes date={date} day={day} />
        <dl className="totals">
          <div>
            <dt>등교 전체 이동</dt>
            <dd>{formatDuration(totals.toSchoolTotal)}</dd>
          </div>
          <div>
            <dt>하교 전체 이동</dt>
            <dd>{formatDuration(totals.fromSchoolTotal)}</dd>
          </div>
          <div>
            <dt>탑승 시간 합계</dt>
            <dd>
              {totals.ridesWithDuration > 0 ? formatDuration(totals.rideSum) : '—'}
              <span className="muted small"> ({totals.ridesWithDuration}/{totals.ridesTotal}건 소요 시간 확인)</span>
            </dd>
          </div>
        </dl>
        <p className="hint">
          전체 이동 시간에는 환승·대기·도보가 포함됩니다. 탑승 시간 합계는 승·하차 시각이 모두 기록된 탑승만 더한 값이라 둘은 같지 않습니다.
        </p>
      </Section>

      <Section
        title={`이동 기록 ${sorted.length ? `(${sorted.length})` : ''}`}
        action={
          <Link className="btn-small" to={`/trip/new?date=${date}`}>
            + 기록 추가
          </Link>
        }
      >
        {sorted.length > 0 && (
          <div className="chips filter" role="group" aria-label="목적 필터">
            <Chip value="all" selected={purpose === 'all'} onSelect={() => setPurpose('all')} small>
              전체
            </Chip>
            {(Object.keys(PURPOSE_LABEL) as Purpose[]).map((p) => (
              <Chip key={p} value={p} selected={purpose === p} onSelect={() => setPurpose(purpose === p ? 'all' : p)} small>
                {PURPOSE_LABEL[p]}
              </Chip>
            ))}
          </div>
        )}
        {trips === undefined ? (
          <Empty>불러오는 중…</Empty>
        ) : shown.length === 0 ? (
          <Empty>
            {sorted.length ? '조건에 맞는 기록이 없습니다.' : isToday ? '아직 오늘 기록이 없습니다. ‘빠른 기록’에서 탑승을 시작해 보세요.' : '이 날짜의 기록이 없습니다.'}
          </Empty>
        ) : (
          <div className="timeline">
            {shown.map((t) => (
              <TripCard key={t.id} trip={t} events={evByTrip.get(t.id) ?? []} to={`/trip/${t.id}`} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
