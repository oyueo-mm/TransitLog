import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { addDays, dateStr, parseDate, todayStr, WEEKDAY_NAMES } from '../domain/time'
import { Empty, Section } from '../ui/common'
import { SearchPanel } from '../ui/SearchPanel'
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

export function CalendarPage() {
  const nav = useNavigate()
  const trips = useAllTrips()
  const events = useAllEvents()
  // 상세 화면에서 돌아오면 보던 탭(달력/검색)으로 복귀
  const [view, setViewState] = useState<'cal' | 'list'>(() => {
    try {
      return sessionStorage.getItem('transitlog.calview') === 'list' ? 'list' : 'cal'
    } catch {
      return 'cal'
    }
  })
  const setView = (v: 'cal' | 'list') => {
    setViewState(v)
    try {
      sessionStorage.setItem('transitlog.calview', v)
    } catch {
      /* 저장하지 못해도 동작한다 */
    }
  }
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })

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
          <div className="cal" role="group" aria-label={`${cursor.y}년 ${cursor.m + 1}월 달력`}>
            {WEEKDAY_NAMES.map((w) => (
              <div key={w} className="cal-h" aria-hidden="true">
                {w}
              </div>
            ))}
            {cells.map((d, i) => {
              if (!d) return <div key={`e${i}`} className="cal-c empty" aria-hidden="true" />
              const c = byDate.get(d)
              const dt = parseDate(d)
              return (
                <button key={d} type="button" className={`cal-c ${d === today ? 'today' : ''} ${c ? 'has' : ''}`} onClick={() => nav(`/day/${d}`)}>
                  <span className="n" aria-hidden="true">
                    {dt.getDate()}
                  </span>
                  <span className="sr-only">
                    {dt.getMonth() + 1}월 {dt.getDate()}일, {c ? `탑승 ${c.ride}건${c.other ? `, 기타 ${c.other}건` : ''}` : '기록 없음'}
                  </span>
                  {c && (
                    <span className="dots" aria-hidden="true">
                      {c.ride > 0 ? c.ride : '·'}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="hint">숫자는 그날의 탑승 횟수입니다(놓침·관찰 제외).</p>
          <div className="row-links">
            <button className="btn-text" onClick={() => nav(`/day/${today}`)}>
              오늘로 이동
            </button>
            <Link className="btn-small" to={`/trip/new?date=${addDays(today, 0)}`}>
              + 기록 추가
            </Link>
          </div>
        </Section>
      ) : (
        <Section>
          {trips && events ? <SearchPanel trips={trips} events={events} /> : <Empty>불러오는 중…</Empty>}
        </Section>
      )}
    </div>
  )
}

export function DayPage() {
  const { date } = useParams()
  return <DayView date={date ?? todayStr()} showNav />
}
