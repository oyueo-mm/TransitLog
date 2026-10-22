import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { addDays, dateStr, parseDate, todayStr, WEEKDAY_NAMES } from '../domain/time'
import { sortTrips } from '../db/repo'
import { KIND_LABEL, MODE_LABEL, PURPOSE_LABEL, type Mode, type Purpose, type RecordKind, type Trip } from '../domain/types'
import { Chip, Empty, Section, TripCard } from '../ui/common'
import { useAllEvents, useAllTrips } from '../ui/hooks'
import { DayView } from './DayView'

function monthGrid(year: number, month: number): Array<string | null> {
  const first = new Date(year, month, 1)
  const startOffset = first.getDay()
  const days = new Date(year, month + 1, 0).getDate()
  const cells: Array<string | null> = Array(startOffset).fill(null)
  for (let d = 1; d <= days; d++) cells.push(dateStr(new Date(year, month, d)))
  while (cells.length % 7) cells.push(null)
  return cells
}

function matches(t: Trip, q: string): boolean {
  if (!q) return true
  const hay = [t.line, t.boardPlace, t.alightPlace, t.trainOrigin, t.trainDestination, t.incident, t.note, t.date].filter(Boolean).join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w))
}

export function CalendarPage() {
  const nav = useNavigate()
  const trips = useAllTrips()
  const events = useAllEvents()
  const [view, setView] = useState<'cal' | 'list'>('cal')
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<Mode | null>(null)
  const [kind, setKind] = useState<RecordKind | null>(null)
  const [purpose, setPurpose] = useState<Purpose | null>(null)

  const byDate = useMemo(() => {
    const m = new Map<string, { ride: number; other: number }>()
    for (const t of trips ?? []) {
      const c = m.get(t.date) ?? { ride: 0, other: 0 }
      if (t.kind === 'ride') c.ride++
      else c.other++
      m.set(t.date, c)
    }
    return m
  }, [trips])
  const evByTrip = useMemo(() => {
    const m = new Map<string, NonNullable<typeof events>>()
    for (const e of events ?? []) m.set(e.tripId, [...(m.get(e.tripId) ?? []), e])
    return m
  }, [events])

  const filtered = useMemo(
    () =>
      sortTrips(
        (trips ?? []).filter(
          (t) => matches(t, q) && (!mode || t.mode === mode) && (!kind || t.kind === kind) && (!purpose || t.purpose === purpose),
        ),
      ).sort((a, b) => b.date.localeCompare(a.date)),
    [trips, q, mode, kind, purpose],
  )
  // sortTrips 는 시각 오름차순이므로 같은 날짜 안에서는 시각 오름차순을 유지한다
  const grouped = useMemo(() => {
    const g = new Map<string, Trip[]>()
    for (const t of filtered) g.set(t.date, [...(g.get(t.date) ?? []), t])
    return [...g.entries()]
  }, [filtered])

  const today = todayStr()
  const cells = monthGrid(cursor.y, cursor.m)
  const shift = (n: number) => {
    const d = new Date(cursor.y, cursor.m + n, 1)
    setCursor({ y: d.getFullYear(), m: d.getMonth() })
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>캘린더</h1>
      </header>
      <div className="seg" role="group" aria-label="보기 방식">
        <button className={`seg-btn ${view === 'cal' ? 'is-on' : ''}`} aria-pressed={view === 'cal'} onClick={() => setView('cal')}>
          달력
        </button>
        <button className={`seg-btn ${view === 'list' ? 'is-on' : ''}`} aria-pressed={view === 'list'} onClick={() => setView('list')}>
          검색·목록
        </button>
      </div>

      {view === 'cal' ? (
        <Section>
          <div className="datenav">
            <button className="btn-icon" aria-label="이전 달" onClick={() => shift(-1)}>
              ‹
            </button>
            <h2>
              {cursor.y}년 {cursor.m + 1}월
            </h2>
            <button className="btn-icon" aria-label="다음 달" onClick={() => shift(1)}>
              ›
            </button>
          </div>
          <div className="cal" role="grid" aria-label={`${cursor.y}년 ${cursor.m + 1}월 달력`}>
            {WEEKDAY_NAMES.map((w) => (
              <div key={w} className="cal-h" role="columnheader">
                {w}
              </div>
            ))}
            {cells.map((d, i) => {
              if (!d) return <div key={`e${i}`} className="cal-c empty" />
              const c = byDate.get(d)
              return (
                <button
                  key={d}
                  role="gridcell"
                  className={`cal-c ${d === today ? 'today' : ''} ${c ? 'has' : ''}`}
                  onClick={() => nav(`/day/${d}`)}
                  aria-label={`${parseDate(d).getMonth() + 1}월 ${parseDate(d).getDate()}일${c ? `, 탑승 ${c.ride}건${c.other ? `, 기타 ${c.other}건` : ''}` : ', 기록 없음'}`}
                >
                  <span className="n">{parseDate(d).getDate()}</span>
                  {c && <span className="dots">{c.ride > 0 ? c.ride : '·'}</span>}
                </button>
              )
            })}
          </div>
          <p className="hint">숫자는 그날의 탑승 횟수입니다(놓침·관찰 제외).</p>
          <div className="row-links">
            <button className="btn-text" onClick={() => nav(`/day/${today}`)}>
              오늘로 이동
            </button>
            <Link to={`/trip/new?date=${addDays(today, 0)}`}>+ 기록 추가</Link>
          </div>
        </Section>
      ) : (
        <Section>
          <div className="field">
            <label className="field-label" htmlFor="q">
              검색
            </label>
            <input id="q" type="search" placeholder="노선·역·행선지·비고" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="chips filter" role="group" aria-label="교통수단 필터">
            {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
              <Chip key={m} value={m} selected={mode === m} onSelect={() => setMode(mode === m ? null : m)} small>
                {MODE_LABEL[m]}
              </Chip>
            ))}
          </div>
          <div className="chips filter" role="group" aria-label="기록 종류 필터">
            {(Object.keys(KIND_LABEL) as RecordKind[]).map((k) => (
              <Chip key={k} value={k} selected={kind === k} onSelect={() => setKind(kind === k ? null : k)} small>
                {KIND_LABEL[k]}
              </Chip>
            ))}
          </div>
          <div className="chips filter" role="group" aria-label="목적 필터">
            {(Object.keys(PURPOSE_LABEL) as Purpose[]).map((p) => (
              <Chip key={p} value={p} selected={purpose === p} onSelect={() => setPurpose(purpose === p ? null : p)} small>
                {PURPOSE_LABEL[p]}
              </Chip>
            ))}
          </div>
          <p className="muted small">{filtered.length}건</p>
          {filtered.length === 0 ? (
            <Empty>조건에 맞는 기록이 없습니다.</Empty>
          ) : (
            grouped.slice(0, 40).map(([date, list]) => (
              <div key={date} className="group">
                <h3>
                  <Link to={`/day/${date}`}>
                    {date} ({WEEKDAY_NAMES[parseDate(date).getDay()]})
                  </Link>
                </h3>
                <div className="timeline">
                  {list.map((t) => (
                    <TripCard key={t.id} trip={t} events={evByTrip.get(t.id) ?? []} to={`/trip/${t.id}`} />
                  ))}
                </div>
              </div>
            ))
          )}
          {grouped.length > 40 && <p className="muted small">최근 40일치만 표시합니다. 검색어나 필터로 좁혀 보세요.</p>}
        </Section>
      )}
    </div>
  )
}

export function DayPage() {
  const { date } = useParams()
  return <DayView date={date ?? todayStr()} showNav />
}
