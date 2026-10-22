import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { sampleNote, seatCoverage, MIN_SAMPLE } from '../domain/coverage'
import {
  EMPTY_FILTERS,
  activeFilterCount,
  groupByDate,
  normalizeFilters,
  search,
  sortMatches,
  suggestionsFrom,
  toRecords,
  type DelayFilter,
  type QuickRange,
  type SearchFilters,
  type SearchMatch,
  type SeatChange,
  type SeatFinal,
  type SeatInitial,
  type SortKey,
} from '../domain/search'
import { averageDuration, averageMinutesToFirstSeat, crowdingDistribution, rideRows, seatRatios } from '../domain/stats'
import { formatDuration, parseDate, todayStr, WEEKDAY_NAMES } from '../domain/time'
import { CROWDING_LABEL, KIND_LABEL, MODE_LABEL, PURPOSE_LABEL, SIDE_LABEL, type Crowding, type Mode, type Purpose, type RecordKind, type SeatEvent, type Side, type Trip } from '../domain/types'
import { Chip, Empty, TripCard } from './common'
import { Bars, SeatMetric } from './statBits'
import { TagPicker } from './TagPicker'

const PAGE = 30
const STORE_KEY = 'transitlog.search.v1'

interface Saved {
  filters: SearchFilters
  sort: SortKey
  shown: number
  open: boolean
  scrollY: number
}

function load(): Saved {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null') as Partial<Saved> | null
    if (raw) {
      return {
        filters: normalizeFilters(raw.filters),
        sort: (['newest', 'oldest', 'durationDesc', 'durationAsc'] as SortKey[]).includes(raw.sort as SortKey) ? (raw.sort as SortKey) : 'newest',
        shown: typeof raw.shown === 'number' && raw.shown >= PAGE ? raw.shown : PAGE,
        open: !!raw.open,
        scrollY: typeof raw.scrollY === 'number' ? raw.scrollY : 0,
      }
    }
  } catch {
    /* 저장소를 쓸 수 없으면 기본값으로 시작 */
  }
  return { filters: EMPTY_FILTERS, sort: 'newest', shown: PAGE, open: false, scrollY: 0 }
}

function save(s: Saved) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(s))
  } catch {
    /* 저장하지 못해도 화면은 동작한다 */
  }
}

const toggle = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

function Multi<T extends string | number>({ label, options, values, onChange, hint }: { label: string; options: Array<{ value: T; label: string }>; values: T[]; onChange: (v: T[]) => void; hint?: string }) {
  if (options.length === 0) return null
  return (
    <div className="field" role="group" aria-label={label}>
      <div className="field-label">{label}</div>
      <div className="chips">
        {options.map((o) => (
          <Chip key={String(o.value)} value={o.value} selected={values.includes(o.value)} onSelect={(v) => onChange(toggle(values, v))} small>
            {o.label}
          </Chip>
        ))}
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

function Range({ label, from, to, onChange, kind }: { label: string; from: string | null; to: string | null; onChange: (a: string | null, b: string | null) => void; kind: 'time' | 'date' }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <div className="field-label">{label}</div>
      <div className="field-row">
        <input type={kind} aria-label={`${label} 시작`} value={from ?? ''} onChange={(e) => onChange(e.target.value || null, to)} />
        <span className="suffix" aria-hidden="true">
          ~
        </span>
        <input type={kind} aria-label={`${label} 끝`} value={to ?? ''} onChange={(e) => onChange(from, e.target.value || null)} />
      </div>
    </div>
  )
}

const num = (s: string): number | null => {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

/** 기록에서 나온 값(숫자)만 선택지로 */
const distinct = (vals: Array<number | null>): number[] => [...new Set(vals.filter((v): v is number => v !== null))].sort((a, b) => a - b)

function Highlight({ m }: { m: SearchMatch }) {
  const where = [...new Set(m.hits.flatMap((h) => h.where))]
  if (where.length === 0) return null
  return (
    <div className="match-tags" aria-label="일치한 항목">
      <span className="muted small">일치:</span>
      {where.slice(0, 6).map((w) => (
        <mark key={w}>{w}</mark>
      ))}
    </div>
  )
}

export function SearchPanel({ trips, events }: { trips: Trip[]; events: SeatEvent[] }) {
  const [init] = useState(load)
  const [filters, setFilters] = useState<SearchFilters>(init.filters)
  const [sort, setSort] = useState<SortKey>(init.sort)
  const [shown, setShown] = useState(init.shown)
  const [open, setOpen] = useState(init.open)
  const scrollRef = useRef(init.scrollY)
  const restored = useRef(false)

  const set = useCallback((p: Partial<SearchFilters>) => {
    setFilters((f) => ({ ...f, ...p }))
    setShown(PAGE)
  }, [])

  // 상태와 스크롤 위치를 보관해 상세 화면에서 돌아와도 그대로 보이게 한다
  useEffect(() => {
    save({ filters, sort, shown, open, scrollY: scrollRef.current })
  }, [filters, sort, shown, open])
  useEffect(() => {
    let t: number | undefined
    const onScroll = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        scrollRef.current = window.scrollY
        save({ filters, sort, shown, open, scrollY: window.scrollY })
      }, 120)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.clearTimeout(t)
    }
  }, [filters, sort, shown, open])

  const today = todayStr()
  const records = useMemo(() => toRecords(trips, events), [trips, events])
  const matches = useMemo(() => sortMatches(search(records, filters, today), sort), [records, filters, sort, today])
  const visible = matches.slice(0, shown)
  const grouped = useMemo(() => groupByDate(visible), [visible])

  // 처음 한 번, 보관한 스크롤 위치로 복원
  useEffect(() => {
    if (restored.current || records.length === 0) return
    restored.current = true
    if (scrollRef.current > 0) requestAnimationFrame(() => window.scrollTo(0, scrollRef.current))
  }, [records.length])

  // 자동 완성 후보: 저장된 기록에서만
  const sug = useMemo(
    () => ({
      lines: suggestionsFrom(trips.map((t) => t.line)),
      board: suggestionsFrom(trips.map((t) => t.boardPlace)),
      alight: suggestionsFrom(trips.map((t) => t.alightPlace)),
      dest: suggestionsFrom(trips.map((t) => t.trainDestination)),
      origin: suggestionsFrom(trips.map((t) => t.trainOrigin)),
      cars: distinct(trips.map((t) => t.car)),
      doors: distinct(trips.map((t) => t.door)),
      waits: distinct(trips.map((t) => t.waitOrder)),
      sides: [...new Set(trips.map((t) => t.side).filter((s): s is Side => !!s))],
    }),
    [trips],
  )

  const stat = useMemo(() => {
    const rows = rideRows(matches.map((m) => m.rec.trip), events)
    return { rows, seat: seatRatios(rows), cov: seatCoverage(rows), dur: averageDuration(rows), toSeat: averageMinutesToFirstSeat(rows), crowd: crowdingDistribution(rows), nonRide: matches.length - rows.length }
  }, [matches, events])

  const count = activeFilterCount(filters)
  const reset = () => {
    setFilters(EMPTY_FILTERS)
    setShown(PAGE)
    setSort('newest')
  }
  const quick: Array<[QuickRange, string]> = [
    ['all', '전체'],
    ['today', '오늘'],
    ['week', '이번 주'],
    ['month', '이번 달'],
    ['custom', '직접 지정'],
  ]
  const noDur = matches.filter((m) => m.rec.duration === null).length

  return (
    <div data-testid="search-panel">
      <div className="field">
        <label className="field-label" htmlFor="q">
          검색
        </label>
        <input id="q" type="search" placeholder="노선·역·행선지·칸-문(10-3)·앉음·메모" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
        <div className="hint">공백·대소문자는 무시하고, 여러 단어는 모두 맞아야 합니다. ‘수원’과 ‘수원역’은 같은 역으로 찾습니다.</div>
      </div>

      <div className="chips filter" role="group" aria-label="기간">
        {quick.map(([v, l]) => (
          <Chip key={v} value={v} selected={filters.quick === v} onSelect={(q) => set({ quick: q })} small>
            {l}
          </Chip>
        ))}
      </div>
      {filters.quick === 'custom' && <Range label="날짜 범위" kind="date" from={filters.dateFrom} to={filters.dateTo} onChange={(a, b) => set({ dateFrom: a, dateTo: b })} />}

      <div className="row-between">
        <button type="button" className="btn-small" aria-expanded={open} aria-controls="adv-filters" onClick={() => setOpen(!open)}>
          상세 조건 {open ? '접기 ▴' : '펼치기 ▾'}
        </button>
        <button type="button" className="btn-small" onClick={reset} disabled={count === 0 && sort === 'newest'}>
          조건 초기화{count > 0 ? ` (${count})` : ''}
        </button>
      </div>

      {open && (
        <div id="adv-filters" className="adv" data-testid="adv-filters">
          <Multi<Mode> label="교통수단" options={(Object.keys(MODE_LABEL) as Mode[]).map((v) => ({ value: v, label: MODE_LABEL[v] }))} values={filters.modes} onChange={(modes) => set({ modes })} />
          <Multi<RecordKind> label="기록 종류" options={(Object.keys(KIND_LABEL) as RecordKind[]).map((v) => ({ value: v, label: KIND_LABEL[v] }))} values={filters.kinds} onChange={(kinds) => set({ kinds })} />
          <Multi<Purpose> label="목적" options={(Object.keys(PURPOSE_LABEL) as Purpose[]).map((v) => ({ value: v, label: PURPOSE_LABEL[v] }))} values={filters.purposes} onChange={(purposes) => set({ purposes })} />
          <Multi<number> label="요일" options={WEEKDAY_NAMES.map((w, i) => ({ value: i, label: w }))} values={filters.weekdays} onChange={(weekdays) => set({ weekdays })} />

          <TagPicker label="노선·버스 번호" values={filters.lines} suggestions={sug.lines} onChange={(lines) => set({ lines })} />
          <TagPicker label="승차역" values={filters.boardStations} suggestions={sug.board} onChange={(boardStations) => set({ boardStations })} />
          <TagPicker label="하차역" values={filters.alightStations} suggestions={sug.alight} onChange={(alightStations) => set({ alightStations })} />
          <TagPicker label="열차 행선지" values={filters.destinations} suggestions={sug.dest} onChange={(destinations) => set({ destinations })} />
          <TagPicker label="열차 출발지" values={filters.origins} suggestions={sug.origin} onChange={(origins) => set({ origins })} />

          <Range label="승차 시각" kind="time" from={filters.boardFrom} to={filters.boardTo} onChange={(a, b) => set({ boardFrom: a, boardTo: b })} />
          <Range label="하차 시각" kind="time" from={filters.alightFrom} to={filters.alightTo} onChange={(a, b) => set({ alightFrom: a, alightTo: b })} />
          <div className="hint">시작이 끝보다 늦으면 자정을 넘는 범위(예: 22:00~02:00)로 봅니다. 시각이 기록되지 않은 기록은 시각 조건에서 빠집니다.</div>
          <div className="field" role="group" aria-label="소요 시간">
            <div className="field-label">소요 시간(분)</div>
            <div className="field-row">
              <input type="number" inputMode="numeric" min={0} aria-label="소요 시간 최소" placeholder="최소" value={filters.durMin ?? ''} onChange={(e) => set({ durMin: num(e.target.value) })} />
              <span className="suffix" aria-hidden="true">
                ~
              </span>
              <input type="number" inputMode="numeric" min={0} aria-label="소요 시간 최대" placeholder="최대" value={filters.durMax ?? ''} onChange={(e) => set({ durMax: num(e.target.value) })} />
            </div>
          </div>

          <Multi<SeatInitial>
            label="탑승 시 좌석"
            options={[
              { value: 'seated', label: '처음부터 앉아서' },
              { value: 'standing', label: '서서 탑승' },
              { value: 'unrecorded', label: '미기록' },
            ]}
            values={filters.seatInitial}
            onChange={(seatInitial) => set({ seatInitial })}
          />
          <Multi<SeatChange>
            label="탑승 중 좌석 변화"
            options={[
              { value: 'midSeat', label: '중간 착석함' },
              { value: 'stoodAll', label: '끝까지 서 있었음(확인)' },
              { value: 'seatedAll', label: '끝까지 앉아 있었음(확인)' },
              { value: 'unconfirmed', label: '변화 기록 없음·미확인' },
            ]}
            values={filters.seatChange}
            onChange={(seatChange) => set({ seatChange })}
            hint="‘끝까지’는 좌석 변화 기록을 완결로 확인한 탑승만 해당합니다."
          />
          <Multi<SeatFinal>
            label="최종 좌석 상태"
            options={[
              { value: 'seated', label: '앉음' },
              { value: 'standing', label: '서 있음' },
              { value: 'unknown', label: '미확인' },
            ]}
            values={filters.seatFinal}
            onChange={(seatFinal) => set({ seatFinal })}
            hint="완결로 확인된 탑승만 최종 상태를 압니다. 나머지는 ‘미확인’입니다."
          />

          <Multi<number> label="칸" options={sug.cars.map((v) => ({ value: v, label: `${v}칸` }))} values={filters.cars} onChange={(cars) => set({ cars })} />
          <Multi<number> label="문" options={sug.doors.map((v) => ({ value: v, label: `${v}문` }))} values={filters.doors} onChange={(doors) => set({ doors })} />
          <Multi<Side> label="좌우" options={sug.sides.map((v) => ({ value: v, label: SIDE_LABEL[v] }))} values={filters.sides} onChange={(sides) => set({ sides })} />
          <Multi<number> label="대기 순서" options={sug.waits.map((v) => ({ value: v, label: `${v}번째` }))} values={filters.waitOrders} onChange={(waitOrders) => set({ waitOrders })} />
          <Multi<Crowding> label="혼잡도" options={(Object.keys(CROWDING_LABEL) as Crowding[]).map((v) => ({ value: v, label: CROWDING_LABEL[v] }))} values={filters.crowding} onChange={(crowding) => set({ crowding })} />
          <Multi<DelayFilter>
            label="지연"
            options={[
              { value: 'yes', label: '지연 있음' },
              { value: 'no', label: '지연 없음(0분)' },
              { value: 'unrecorded', label: '미기록' },
            ]}
            values={filters.delay}
            onChange={(delay) => set({ delay })}
          />
        </div>
      )}

      <div className="result-head">
        <p className="muted small" role="status" data-testid="result-count">
          {matches.length === trips.length ? `전체 ${matches.length}건` : `${matches.length}건 일치 (전체 ${trips.length}건 중)`}
        </p>
        <div className="field-row sort-row">
          <label htmlFor="sort" className="field-label">
            정렬
          </label>
          <select id="sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="newest">최신순</option>
            <option value="oldest">오래된순</option>
            <option value="durationDesc">소요 시간 긴 순</option>
            <option value="durationAsc">소요 시간 짧은 순</option>
          </select>
        </div>
      </div>
      {(sort === 'durationDesc' || sort === 'durationAsc') && noDur > 0 && <p className="hint">소요 시간을 알 수 없는 {noDur}건은 순서와 관계없이 맨 뒤에 둡니다.</p>}

      {matches.length > 0 && (
        <details className="result-stats" data-testid="result-stats" open>
          <summary>검색 결과 통계</summary>
          <p className="hint">
            일치한 {matches.length}건 중 탑승 <strong>{stat.rows.length}건</strong>으로 계산합니다.{stat.nonRide > 0 ? ` 놓침·관찰 ${stat.nonRide}건은 제외.` : ''} 통계 화면과 같은 정의·함수를 씁니다.
          </p>
          {stat.rows.length === 0 ? (
            <Empty>탑승 기록이 없어 통계를 계산하지 않았습니다.</Empty>
          ) : (
            <>
              {stat.rows.length < MIN_SAMPLE && (
                <div className="notice" role="note">
                  ⚠ 일치한 탑승이 {stat.rows.length}건뿐이라 비율을 일반화하기에는 표본이 부족합니다.
                </div>
              )}
              <dl className="metrics">
                <SeatMetric title="즉시 착석률" num={stat.seat.immediate.num} den={stat.seat.immediate.den} total={stat.cov.total} def="탑승 시점에 이미 앉아 있던 비율 (탑승 시 좌석을 기록한 탑승만)" reasons={[['탑승 시 좌석 상태를 기록하지 않음', stat.cov.immediate.unknown]]} />
                <SeatMetric
                  title="한 번이라도 착석한 비율"
                  num={stat.seat.everSeated.num}
                  den={stat.seat.everSeated.den}
                  total={stat.cov.total}
                  def="앉은 것이 확인된 기록과 ‘끝까지 서 있었음’을 확인한 기록만 셉니다"
                  reasons={[
                    ['서서 탔지만 이후 앉았는지 확인하지 않음', stat.cov.ever.unconfirmedStanding],
                    ['좌석 정보가 없음', stat.cov.ever.unknown],
                  ]}
                />
                <div>
                  <dt>평균 탑승 시간</dt>
                  <dd data-testid="stat-duration">
                    {stat.dur.avg === null ? '—' : formatDuration(Math.round(stat.dur.avg))} <span className="muted">(표본 {stat.dur.n})</span>
                  </dd>
                  <dd className="def">승·하차 시각이 있는 탑승만</dd>
                  {stat.dur.n > 0 && sampleNote(stat.dur.n, stat.rows.length).insufficient && <dd className="caution">⚠ 표본 부족</dd>}
                </div>
                <div>
                  <dt>서서 탄 뒤 착석까지 평균</dt>
                  <dd data-testid="stat-toseat">
                    {stat.toSeat.avg === null ? '—' : formatDuration(Math.round(stat.toSeat.avg))} <span className="muted">(표본 {stat.toSeat.n})</span>
                  </dd>
                  <dd className="def">서서 탑승 → 첫 착석, 두 시각이 모두 있는 탑승만</dd>
                  {stat.toSeat.n > 0 && stat.toSeat.n < MIN_SAMPLE && <dd className="caution">⚠ 표본 부족</dd>}
                </div>
                <div>
                  <dt>혼잡도 분포</dt>
                  {stat.crowd.n === 0 ? (
                    <dd>—</dd>
                  ) : (
                    <dd>
                      <Bars items={(Object.keys(CROWDING_LABEL) as Crowding[]).map((c) => ({ key: CROWDING_LABEL[c], count: stat.crowd.dist[c] }))} max={stat.crowd.n} />
                      <span className="muted small">혼잡도가 기록된 {stat.crowd.n}건 기준 (탑승 {stat.rows.length}건 중)</span>
                    </dd>
                  )}
                </div>
              </dl>
            </>
          )}
        </details>
      )}

      {matches.length === 0 ? (
        <Empty>{trips.length === 0 ? '아직 기록이 없습니다.' : '조건에 맞는 기록이 없습니다. 조건을 줄이거나 초기화해 보세요.'}</Empty>
      ) : (
        grouped.map(([date, list]) => (
          <div key={date} className="group" data-testid="result-group">
            <h3>
              <Link to={`/day/${date}`}>
                {date} ({WEEKDAY_NAMES[parseDate(date).getDay()]})
              </Link>
              <span className="muted small"> · {list.length}건</span>
            </h3>
            <div className="timeline">
              {list.map((m) => (
                <div key={m.rec.trip.id} className="result-item" data-trip-id={m.rec.trip.id}>
                  <TripCard trip={m.rec.trip} events={m.rec.events} to={`/trip/${m.rec.trip.id}`} linkState={{ from: '/calendar' }} />
                  <Highlight m={m} />
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      {matches.length > shown && (
        <button type="button" className="btn-secondary" data-testid="more" onClick={() => setShown(shown + PAGE)}>
          더 보기 ({matches.length - shown}건 남음)
        </button>
      )}
      {matches.length > PAGE && matches.length <= shown && <p className="muted small">모든 결과를 표시했습니다 ({matches.length}건).</p>}
    </div>
  )
}
