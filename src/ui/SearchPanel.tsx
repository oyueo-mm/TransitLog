import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Clock3, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  EMPTY_FILTERS,
  activeFilterCount,
  groupByDate,
  groupByBoardTime,
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
  type TimeStep,
} from '../domain/search'
import { formatDuration, formatHm, parseDate, parseHm, todayStr, WEEKDAY_NAMES } from '../domain/time'
import { CROWDING_LABEL, KIND_LABEL, MODE_LABEL, PURPOSE_LABEL, SIDE_LABEL, type Crowding, type Mode, type Purpose, type RecordKind, type SeatEvent, type Side, type Trip } from '../domain/types'
import { Chip, Empty } from './common'
import { formatTrainRoute } from '../domain/stations'
import { TagPicker } from './TagPicker'

const PAGE = 30
const STORE_KEY = 'transitlog.search.v1'

interface Saved {
  filters: SearchFilters
  sort: SortKey
  shown: number
  open: boolean
  scrollY: number
  group: 'date' | 'time'
  step: TimeStep
  center: string
}

function load(): Saved {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null') as Partial<Saved> | null
    if (raw) {
      return {
        filters: normalizeFilters(raw.filters),
        sort: (['newest', 'oldest', 'timeAsc', 'timeDesc', 'durationDesc', 'durationAsc'] as SortKey[]).includes(raw.sort as SortKey) ? (raw.sort as SortKey) : 'newest',
        shown: typeof raw.shown === 'number' && raw.shown >= PAGE ? raw.shown : PAGE,
        open: !!raw.open,
        scrollY: typeof raw.scrollY === 'number' ? raw.scrollY : 0,
        group: raw.group === 'time' ? 'time' : 'date',
        step: ([5, 10, 15, 30, 60] as number[]).includes(raw.step as number) ? raw.step as TimeStep : 15,
        center: typeof raw.center === 'string' && parseHm(raw.center) !== null ? raw.center : '08:00',
      }
    }
  } catch {
    /* 저장소를 쓸 수 없으면 기본값으로 시작 */
  }
  return { filters: EMPTY_FILTERS, sort: 'newest', shown: PAGE, open: false, scrollY: 0, group: 'date', step: 15, center: '08:00' }
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

function SearchResultCard({ m }: { m: SearchMatch }) {
  const t = m.rec.trip
  const seat = m.rec.facts.summary
  const seatLabel = t.kind !== 'ride' ? KIND_LABEL[t.kind] :
    t.initialSeat === 'seated' ? '처음부터 착석' :
    t.initialSeat === 'standing' && seat.minutesToFirstSeat !== null ? `서서 탑승 → ${formatDuration(seat.minutesToFirstSeat)} 후 착석` :
    seat.everSeated === true ? '중간 착석 기록' :
    seat.everSeated === false ? '끝까지 서서 이동' :
    t.initialSeat === 'standing' ? '서서 탑승 · 이후 미확인' : '좌석 미기록'
  const position = [t.car !== null ? `${t.car}칸` : null, t.door !== null ? `${t.door}문` : null].filter(Boolean).join(' · ')
  return (
    <Link className="card search-card" to={`/trip/${t.id}`} state={{ from: '/calendar' }}>
      <div className="search-card-head">
        <strong className="search-card-time">{t.boardTime ?? '--:--'}</strong>
        <span className="muted small">{t.date}</span>
        {m.rec.duration !== null && <span className="search-card-duration">{formatDuration(m.rec.duration)}</span>}
      </div>
      <div className="search-card-route">
        <span className="badge mode">{t.line ?? (t.mode === 'subway' ? '지하철' : '버스')}</span>
        <strong>{t.boardPlace ?? '승차역 미기록'} → {t.alightPlace ?? '하차역 미기록'}</strong>
      </div>
      {formatTrainRoute(t.trainOrigin, t.trainDestination) && <div className="muted small">{formatTrainRoute(t.trainOrigin, t.trainDestination)}</div>}
      <div className="search-card-seat">{seatLabel}</div>
      {(position || t.purpose || t.crowding) && <div className="muted small">{[position, t.purpose ? PURPOSE_LABEL[t.purpose] : null, t.crowding ? CROWDING_LABEL[t.crowding] : null].filter(Boolean).join(' · ')}</div>}
      {(t.incident || (t.delayMinutes ?? 0) > 0) && <div className="card-sub warn">{[t.incident, t.delayMinutes ? `${t.delayMinutes}분 지연` : ''].filter(Boolean).join(' · ')}</div>}
      {t.note && <div className="card-note search-card-note">{t.note}</div>}
      <Highlight m={m} />
    </Link>
  )
}

export function SearchPanel({ trips, events }: { trips: Trip[]; events: SeatEvent[] }) {
  const [urlParams] = useSearchParams()
  const [init] = useState(() => {
    const saved = load()
    if (urlParams.get('view') !== 'list') return saved
    const boardFrom = urlParams.get('boardFrom')
    const boardTo = urlParams.get('boardTo')
    const from = urlParams.get('dateFrom')
    const to = urlParams.get('dateTo')
    const line = urlParams.get('line')
    const useTime = boardFrom !== null || boardTo !== null
    const useDate = from !== null || to !== null
    if (!useTime && !useDate && !line) return saved
    return {
      ...saved,
      group: 'time' as const,
      filters: {
        ...EMPTY_FILTERS,
        boardFrom: boardFrom && parseHm(boardFrom) !== null ? boardFrom : null,
        boardTo: boardTo && parseHm(boardTo) !== null ? boardTo : null,
        quick: useDate ? 'custom' as const : 'all' as const,
        dateFrom: from || null,
        dateTo: to || null,
        lines: line ? [line] : [],
      },
      shown: PAGE,
      scrollY: 0,
    }
  })
  const [filters, setFilters] = useState<SearchFilters>(init.filters)
  const [sort, setSort] = useState<SortKey>(init.sort)
  const [shown, setShown] = useState(init.shown)
  const [open, setOpen] = useState(init.open)
  const [group, setGroup] = useState(init.group)
  const [step, setStep] = useState<TimeStep>(init.step)
  const [center, setCenter] = useState(init.center)
  const scrollRef = useRef(init.scrollY)
  const restored = useRef(false)

  const set = useCallback((p: Partial<SearchFilters>) => {
    setFilters((f) => ({ ...f, ...p }))
    setShown(PAGE)
  }, [])

  // 상태와 스크롤 위치를 보관해 상세 화면에서 돌아와도 그대로 보이게 한다
  useEffect(() => {
    save({ filters, sort, shown, open, scrollY: scrollRef.current, group, step, center })
  }, [filters, sort, shown, open, group, step, center])
  useEffect(() => {
    let t: number | undefined
    const onScroll = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        scrollRef.current = window.scrollY
        save({ filters, sort, shown, open, scrollY: window.scrollY, group, step, center })
      }, 120)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.clearTimeout(t)
    }
  }, [filters, sort, shown, open, group, step, center])

  const today = todayStr()
  const records = useMemo(() => toRecords(trips, events), [trips, events])
  const matches = useMemo(() => sortMatches(search(records, filters, today), sort), [records, filters, sort, today])
  const visible = matches.slice(0, shown)
  const grouped = useMemo(() => group === 'time' ? groupByBoardTime(visible, step) : groupByDate(visible), [visible, group, step])

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
  const applyTimeWindow = (minutes: number) => {
    const centerMinutes = parseHm(center)
    if (centerMinutes === null) return
    set({ boardFrom: formatHm(centerMinutes - minutes), boardTo: formatHm(centerMinutes + minutes) })
  }
  const timeActive = filters.boardFrom !== null || filters.boardTo !== null
  const activeLabels = [
    ...filters.lines.map((v) => ({ label: v, clear: () => set({ lines: filters.lines.filter((x) => x !== v) }) })),
    ...filters.boardStations.map((v) => ({ label: `승차 ${v}`, clear: () => set({ boardStations: filters.boardStations.filter((x) => x !== v) }) })),
    ...filters.destinations.map((v) => ({ label: `행선지 ${v}`, clear: () => set({ destinations: filters.destinations.filter((x) => x !== v) }) })),
    ...filters.seatInitial.map((v) => ({ label: v === 'standing' ? '서서 탑승' : v === 'seated' ? '처음부터 착석' : '좌석 미기록', clear: () => set({ seatInitial: filters.seatInitial.filter((x) => x !== v) }) })),
    ...(timeActive ? [{ label: `승차 ${filters.boardFrom ?? '00:00'}~${filters.boardTo ?? '23:59'}`, clear: () => set({ boardFrom: null, boardTo: null }) }] : []),
  ]

  return (
    <div data-testid="search-panel">
      <div className="time-search-panel">
        <div className="field-label"><Clock3 size={16} className="inline-icon" /> 탑승 시간</div>
        <Range label="승차 시각" kind="time" from={filters.boardFrom} to={filters.boardTo} onChange={(a, b) => set({ boardFrom: a, boardTo: b })} />
        <div className="chips filter" role="group" aria-label="시간 빠른 선택">
          <Chip value="morning" selected={filters.boardFrom === '06:00' && filters.boardTo === '10:00'} onSelect={() => set({ boardFrom: '06:00', boardTo: '10:00' })} small>아침 06~10시</Chip>
          <Chip value="evening" selected={filters.boardFrom === '16:00' && filters.boardTo === '21:00'} onSelect={() => set({ boardFrom: '16:00', boardTo: '21:00' })} small>저녁 16~21시</Chip>
          <button type="button" className="btn-small" onClick={() => set({ boardFrom: null, boardTo: null })} disabled={!timeActive}>시간 초기화</button>
        </div>
        <div className="time-center-row">
          <label className="field-label" htmlFor="time-center">기준 시각</label>
          <input type="time" id="time-center" value={center} onChange={(e) => setCenter(e.target.value)} />
          <div className="chips" role="group" aria-label="기준 시각 전후 검색">
            {([5, 10, 15] as const).map((minutes) => <button type="button" key={minutes} className="chip is-small" onClick={() => applyTimeWindow(minutes)}>±{minutes}분</button>)}
          </div>
        </div>
        <p className="hint">시간은 실제 탑승 시각 기준입니다. 자정을 넘는 범위도 검색할 수 있습니다.</p>
      </div>
      <div className="chips filter" role="group" aria-label="날짜">
        {quick.map(([v, l]) => <Chip key={v} value={v} selected={filters.quick === v} onSelect={(q) => set({ quick: q })} small>{l}</Chip>)}
      </div>
      {filters.quick === 'custom' && <Range label="날짜 범위" kind="date" from={filters.dateFrom} to={filters.dateTo} onChange={(a, b) => set({ dateFrom: a, dateTo: b })} />}
      <div className="search-primary">
        <TagPicker label="노선·버스 번호" values={filters.lines} suggestions={sug.lines} onChange={(lines) => set({ lines })} />
        <TagPicker label="승차역" values={filters.boardStations} suggestions={sug.board} onChange={(boardStations) => set({ boardStations })} />
        <TagPicker label="열차 행선지" values={filters.destinations} suggestions={sug.dest} onChange={(destinations) => set({ destinations })} />
        <Multi<number> label="요일" options={WEEKDAY_NAMES.map((w, i) => ({ value: i, label: w }))} values={filters.weekdays} onChange={(weekdays) => set({ weekdays })} />
        <Multi<SeatInitial>
          label="탑승 시 좌석"
          options={[{ value: 'seated', label: '처음부터 앉아서' }, { value: 'standing', label: '서서 탑승' }, { value: 'unrecorded', label: '미기록' }]}
          values={filters.seatInitial} onChange={(seatInitial) => set({ seatInitial })}
        />
        <Multi<SeatChange>
          label="탑승 중 좌석 변화"
          options={[{ value: 'midSeat', label: '중간 착석함' }, { value: 'stoodAll', label: '끝까지 서 있었음(확인)' }, { value: 'seatedAll', label: '끝까지 앉아 있었음(확인)' }, { value: 'unconfirmed', label: '변화 기록 없음·미확인' }]}
          values={filters.seatChange} onChange={(seatChange) => set({ seatChange })}
        />
      </div>
      {activeLabels.length > 0 && <div className="chips active-search-filters" aria-label="적용 중인 주요 조건">
        {activeLabels.map((item, i) => <button type="button" className="chip is-on is-small" key={i} onClick={item.clear}>{item.label} <X size={12} className="inline-icon" /></button>)}
      </div>}
      <div className="row-between">
        <button type="button" className="btn-small" aria-expanded={open} aria-controls="adv-filters" onClick={() => setOpen(!open)}>
          상세 조건 {open ? '접기' : '펼치기'}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button type="button" className="btn-small" onClick={reset} disabled={count === 0 && sort === 'newest'}>
          조건 초기화{count > 0 ? ` (${count})` : ''}
        </button>
      </div>

      {open && (
        <div id="adv-filters" className="adv" data-testid="adv-filters">
          <div className="field">
            <label className="field-label" htmlFor="q">키워드 검색</label>
            <input id="q" type="search" aria-label="검색" placeholder="노선·역·칸-문(10-3)·착석·메모" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
            <div className="hint">여러 단어는 모두 일치해야 합니다. 좌석 변화 이벤트의 시각·역·메모도 검색합니다.</div>
          </div>
          <Multi<Mode> label="교통수단" options={(Object.keys(MODE_LABEL) as Mode[]).map((v) => ({ value: v, label: MODE_LABEL[v] }))} values={filters.modes} onChange={(modes) => set({ modes })} />
          <Multi<RecordKind> label="기록 종류" options={(Object.keys(KIND_LABEL) as RecordKind[]).map((v) => ({ value: v, label: KIND_LABEL[v] }))} values={filters.kinds} onChange={(kinds) => set({ kinds })} />
          <Multi<Purpose> label="목적" options={(Object.keys(PURPOSE_LABEL) as Purpose[]).map((v) => ({ value: v, label: PURPOSE_LABEL[v] }))} values={filters.purposes} onChange={(purposes) => set({ purposes })} />

          <TagPicker label="하차역" values={filters.alightStations} suggestions={sug.alight} onChange={(alightStations) => set({ alightStations })} />
          <TagPicker label="열차 출발지" values={filters.origins} suggestions={sug.origin} onChange={(origins) => set({ origins })} />

          <Range label="하차 시각" kind="time" from={filters.alightFrom} to={filters.alightTo} onChange={(a, b) => set({ alightFrom: a, alightTo: b })} />
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
            <option value="timeAsc">탑승 시각 빠른 순</option>
            <option value="timeDesc">탑승 시각 늦은 순</option>
            <option value="durationDesc">소요 시간 긴 순</option>
            <option value="durationAsc">소요 시간 짧은 순</option>
          </select>
        </div>
      </div>
      <div className="search-result-options">
        <div className="seg" role="group" aria-label="결과 묶음">
          <button type="button" className={`seg-btn ${group === 'date' ? 'is-on' : ''}`} aria-pressed={group === 'date'} onClick={() => setGroup('date')}>날짜별</button>
          <button type="button" className={`seg-btn ${group === 'time' ? 'is-on' : ''}`} aria-pressed={group === 'time'} onClick={() => setGroup('time')}>시간대별</button>
        </div>
        {group === 'time' && <div className="field-row">
          <label className="field-label" htmlFor="time-step">간격</label>
          <select id="time-step" value={step} onChange={(e) => setStep(Number(e.target.value) as TimeStep)}>
            {[5, 10, 15, 30, 60].map((v) => <option key={v} value={v}>{v === 60 ? '1시간' : `${v}분`}</option>)}
          </select>
        </div>}
      </div>
      {(sort === 'durationDesc' || sort === 'durationAsc') && noDur > 0 && <p className="hint">소요 시간을 알 수 없는 {noDur}건은 순서와 관계없이 맨 뒤에 둡니다.</p>}

      {matches.length === 0 ? (
        <Empty>{trips.length === 0 ? '아직 기록이 없습니다.' : '조건에 맞는 기록이 없습니다. 조건을 줄이거나 초기화해 보세요.'}</Empty>
      ) : (
        grouped.map(([key, list]) => (
          <div key={key} className="group" data-testid="result-group">
            <h3>
              {group === 'date' ? <Link to={`/day/${key}`}>{key} ({WEEKDAY_NAMES[parseDate(key).getDay()]})</Link> : <span>{key}</span>}
              <span className="muted small"> · {list.length}건</span>
            </h3>
            <div className="search-result-list">
              {list.map((m) => <div key={m.rec.trip.id} className="result-item" data-trip-id={m.rec.trip.id}><SearchResultCard m={m} /></div>)}
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
