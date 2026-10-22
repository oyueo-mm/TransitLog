import { orderEvents, summarizeSeat, tripDuration, type SeatSummary } from './seat'
import { countMidSeats } from './timeline'
import { stationKey } from './stations'
import { addDays, parseHm, parseDate, weekdayIndex, weekStart, WEEKDAY_NAMES } from './time'
import {
  BUS_DOOR_LABEL,
  CROWDING_LABEL,
  KIND_LABEL,
  MODE_LABEL,
  PURPOSE_LABEL,
  SERVICE_LABEL,
  SIDE_LABEL,
  type Crowding,
  type Mode,
  type Purpose,
  type RecordKind,
  type SeatEvent,
  type Side,
  type Trip,
} from './types'

/**
 * 기록 검색 (순수 함수).
 *  - 조건 사이는 AND, 한 조건 안의 여러 값은 OR.
 *  - 기록되지 않은 값(null)은 어떤 값 조건에도 일치하지 않는다. 값을 추정해 일치시키지 않는다.
 *  - 좌석 이벤트(seatEvents)도 검색 대상이다.
 */

export type QuickRange = 'all' | 'today' | 'week' | 'month' | 'custom'
export type SeatInitial = 'seated' | 'standing' | 'unrecorded'
/** 탑승 중 좌석 변화: 중간 착석함 / 끝까지 서 있었음(확인) / 끝까지 앉아 있었음(확인) / 변화 기록 없음·완결 미확인 */
export type SeatChange = 'midSeat' | 'stoodAll' | 'seatedAll' | 'unconfirmed'
export type SeatFinal = 'seated' | 'standing' | 'unknown'
export type DelayFilter = 'yes' | 'no' | 'unrecorded'
export type SortKey = 'newest' | 'oldest' | 'durationDesc' | 'durationAsc'

export interface SearchFilters {
  q: string
  quick: QuickRange
  dateFrom: string | null
  dateTo: string | null
  weekdays: number[]
  boardFrom: string | null
  boardTo: string | null
  alightFrom: string | null
  alightTo: string | null
  durMin: number | null
  durMax: number | null
  modes: Mode[]
  kinds: RecordKind[]
  purposes: Purpose[]
  lines: string[]
  boardStations: string[]
  alightStations: string[]
  destinations: string[]
  origins: string[]
  cars: number[]
  doors: number[]
  sides: Side[]
  waitOrders: number[]
  seatInitial: SeatInitial[]
  seatChange: SeatChange[]
  seatFinal: SeatFinal[]
  crowding: Crowding[]
  delay: DelayFilter[]
}

export const EMPTY_FILTERS: SearchFilters = {
  q: '',
  quick: 'all',
  dateFrom: null,
  dateTo: null,
  weekdays: [],
  boardFrom: null,
  boardTo: null,
  alightFrom: null,
  alightTo: null,
  durMin: null,
  durMax: null,
  modes: [],
  kinds: [],
  purposes: [],
  lines: [],
  boardStations: [],
  alightStations: [],
  destinations: [],
  origins: [],
  cars: [],
  doors: [],
  sides: [],
  waitOrders: [],
  seatInitial: [],
  seatChange: [],
  seatFinal: [],
  crowding: [],
  delay: [],
}

/** 저장된 값(이전 버전·손상된 값 포함)을 안전하게 SearchFilters 로 만든다 */
export function normalizeFilters(raw: unknown): SearchFilters {
  const out: SearchFilters = { ...EMPTY_FILTERS }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const key of Object.keys(EMPTY_FILTERS) as Array<keyof SearchFilters>) {
    const def = EMPTY_FILTERS[key]
    const v = r[key]
    if (Array.isArray(def)) {
      if (Array.isArray(v)) (out as unknown as Record<string, unknown>)[key] = v.filter((x) => typeof x === 'string' || typeof x === 'number')
    } else if (typeof def === 'string') {
      if (typeof v === 'string') (out as unknown as Record<string, unknown>)[key] = v
    } else if (v === null || typeof v === 'string' || typeof v === 'number') {
      ;(out as unknown as Record<string, unknown>)[key] = v ?? null
    }
  }
  if (!['all', 'today', 'week', 'month', 'custom'].includes(out.quick)) out.quick = 'all'
  return out
}

/** 켜진 조건의 수 (초기화 버튼·배지용) */
export function activeFilterCount(f: SearchFilters): number {
  let n = f.q.trim() ? 1 : 0
  if (f.quick !== 'all' || f.dateFrom || f.dateTo) n++
  const groups: unknown[][] = [
    f.weekdays, f.modes, f.kinds, f.purposes, f.lines, f.boardStations, f.alightStations, f.destinations, f.origins,
    f.cars, f.doors, f.sides, f.waitOrders, f.seatInitial, f.seatChange, f.seatFinal, f.crowding, f.delay,
  ]
  for (const g of groups) if (g.length) n++
  if (f.boardFrom || f.boardTo) n++
  if (f.alightFrom || f.alightTo) n++
  if (f.durMin !== null || f.durMax !== null) n++
  return n
}

export function resolveDateRange(f: SearchFilters, today: string): { from: string | null; to: string | null } {
  if (f.quick === 'today') return { from: today, to: today }
  if (f.quick === 'week') {
    const s = weekStart(today)
    return { from: s, to: addDays(s, 6) }
  }
  if (f.quick === 'month') return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-31` }
  if (f.quick === 'custom') return { from: f.dateFrom, to: f.dateTo }
  return { from: null, to: null }
}

// ── 키워드 ───────────────────────────────────────────────

/** 공백·대소문자 무시 비교용 정규화 */
export function norm(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, '')
}

/** 같은 뜻으로 보는 말 묶음. 기록된 값에서 만든 '파생 단어'와만 맞춘다 (기록에 없는 값을 만들어 내지 않는다) */
const SYNONYMS: string[][] = [
  ['앉음', '착석', '앉아서', '앉았', '앉아', '앉았음'],
  ['서서', '기립', '서있', '서있음', '서있었'],
  ['일어섬', '일어남', '일어났', '일어서'],
  ['지연', '연착'],
]
const synonymsOf = (w: string): string[] => {
  for (const g of SYNONYMS) if (g.includes(w)) return g
  return [w]
}

export interface TripIndex {
  /** 자유 문장 필드(부분 일치) */
  text: string
  /** 파생 단어(정확히 일치) */
  words: Set<string>
  stations: Set<string>
  times: string[]
  date: string
  car: number | null
  door: number | null
  waitOrder: number | null
  fields: Array<{ label: string; value: string; n: string }>
}

const SEAT_WORDS = {
  seated: ['앉음', '착석', '앉아서', '앉았'],
  standing: ['서서', '기립', '서있'],
  rose: ['일어섬', '일어남'],
}

export function buildIndex(trip: Trip, events: SeatEvent[]): TripIndex {
  const ordered = orderEvents(trip, events)
  const words = new Set<string>()
  const add = (...w: string[]) => w.forEach((x) => words.add(norm(x)))
  const fields: TripIndex['fields'] = []
  const field = (label: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === '') return
    const v = String(value)
    fields.push({ label, value: v, n: norm(v) })
  }
  field('노선', trip.line)
  field('승차역', trip.boardPlace)
  field('하차역', trip.alightPlace)
  field('열차 출발지', trip.trainOrigin)
  field('행선지', trip.trainDestination)
  field('사건', trip.incident)
  field('메모', trip.note)
  for (const e of ordered) {
    field('좌석 이벤트 역', e.place)
    field('좌석 이벤트 메모', e.note)
  }

  add(MODE_LABEL[trip.mode], KIND_LABEL[trip.kind])
  if (trip.kind === 'ride') add('탑승')
  if (trip.purpose) add(PURPOSE_LABEL[trip.purpose])
  if (trip.crowding) {
    add(CROWDING_LABEL[trip.crowding])
    if (trip.crowding === 'very_crowded') add('혼잡')
    if (trip.crowding === 'free') add('여유')
  }
  if (trip.side) add(SIDE_LABEL[trip.side])
  if (trip.busDoor) add(BUS_DOOR_LABEL[trip.busDoor])
  if (trip.service) add(SERVICE_LABEL[trip.service])
  if (trip.car !== null) add(`${trip.car}칸`)
  if (trip.door !== null) add(`${trip.door}문`, `${trip.door}번문`)
  if (trip.waitOrder !== null) add(`${trip.waitOrder}번째`)
  if (trip.delayMinutes !== null) {
    if (trip.delayMinutes > 0) add('지연', '연착', `${trip.delayMinutes}분`, `${trip.delayMinutes}분지연`)
    else add('지연없음')
  }
  const dur = tripDuration(trip)
  if (dur !== null) add(`${dur}분`, `소요${dur}분`)
  add(`${WEEKDAY_NAMES[weekdayIndex(trip.date)]}요일`)

  if (trip.initialSeat === 'seated') add(...SEAT_WORDS.seated, '처음부터앉아서')
  if (trip.initialSeat === 'standing') add(...SEAT_WORDS.standing, '서서탑승')
  for (const e of ordered) {
    if (e.state === 'seated') add(...SEAT_WORDS.seated, '중간착석')
    else add(...SEAT_WORDS.rose, ...SEAT_WORDS.standing)
  }
  if (trip.kind === 'ride' && trip.seatLogComplete === true && trip.initialSeat === 'standing' && !ordered.some((e) => e.state === 'seated')) add('끝까지서있음')

  const stations = new Set<string>()
  for (const p of [trip.boardPlace, trip.alightPlace, trip.trainOrigin, trip.trainDestination, ...ordered.map((e) => e.place)]) if (p) stations.add(stationKey(p))

  const times = [trip.boardTime, trip.alightTime, ...ordered.map((e) => e.time)].filter((t): t is string => !!t).map(padTime)
  return {
    text: fields.map((f) => f.n).join(' '),
    words,
    stations,
    times,
    date: trip.date,
    car: trip.car,
    door: trip.door,
    waitOrder: trip.waitOrder,
    fields,
  }
}

function padTime(t: string): string {
  const [h, m] = t.split(':')
  return `${h.padStart(2, '0')}:${m ?? ''}`
}

export interface KeywordHit {
  token: string
  /** 일치한 위치 설명 (결과 카드의 '일치 항목'에 보여 줌) */
  where: string[]
}

/** 검색어 한 토큰이 이 기록과 맞는지. 맞으면 어디와 맞았는지 돌려준다 */
export function matchToken(raw: string, idx: TripIndex): string[] | null {
  const token = norm(raw)
  if (!token) return []
  const where: string[] = []

  // 날짜: 2026 / 2026-03 / 2026-03-02 / 3월 / 3월2일 / 2일
  const ymd = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(token)
  if (ymd) {
    const [, y, m, d] = ymd
    const want = [y, m?.padStart(2, '0'), d?.padStart(2, '0')].filter(Boolean).join('-')
    return idx.date.startsWith(want) ? ['날짜'] : null
  }
  const md = /^(\d{1,2})월(?:(\d{1,2})일)?$/.exec(token)
  if (md) {
    const [, m, d] = md
    const [, dm, dd] = idx.date.split('-')
    return Number(dm) === Number(m) && (d === undefined || Number(dd) === Number(d)) ? ['날짜'] : null
  }
  // 칸-문: 10-3
  const cd = /^(\d{1,2})-(\d{1,2})$/.exec(token)
  if (cd) return idx.car === Number(cd[1]) && idx.door === Number(cd[2]) ? ['칸-문'] : null
  // 시각: 08:30 (정확히) · 08: (시 전체)
  const tm = /^(\d{1,2}):(\d{0,2})$/.exec(token)
  if (tm) {
    const want = `${tm[1].padStart(2, '0')}:${tm[2]}`
    return idx.times.some((t) => t.startsWith(want)) ? ['시각'] : null
  }

  // 동의어는 '파생 단어'와만 맞춘다. 자유 문장(text)에는 입력한 말 그대로(와 '행' 뗀 말)만 부분 일치시킨다
  const syn = new Set<string>([token, ...synonymsOf(token)])
  const literal = [token]
  if (token.length > 2 && /(행|방향)$/.test(token)) literal.push(token.replace(/(행|방향)$/, ''))
  let hit = false
  for (const v of syn) {
    if (idx.words.has(v)) {
      hit = true
      where.push(v)
      break
    }
  }
  const sk = stationKey(token)
  const base = literal.find((v) => v.length > 0 && idx.text.includes(v))
  if (base !== undefined) {
    hit = true
    for (const f of idx.fields) if (f.n.includes(base)) where.push(`${f.label}: ${f.value}`)
  }
  if (idx.stations.has(sk) || idx.stations.has(stationKey(token.replace(/(행|방향)$/, '')))) {
    hit = true
    for (const f of idx.fields) if (['승차역', '하차역', '열차 출발지', '행선지', '좌석 이벤트 역'].includes(f.label) && stationKey(f.value) === sk) where.push(`${f.label}: ${f.value}`)
  }
  return hit ? [...new Set(where)] : null
}

export function matchKeywords(q: string, idx: TripIndex): KeywordHit[] | null {
  const tokens = q.split(/[\s,]+/).filter(Boolean)
  const hits: KeywordHit[] = []
  for (const t of tokens) {
    const w = matchToken(t, idx)
    if (w === null) return null
    hits.push({ token: t, where: w })
  }
  return hits
}

// ── 필터 ─────────────────────────────────────────────────

/** 시각 범위 포함 여부. 시작 > 끝이면 자정을 넘는 범위(22:00~02:00)로 본다. 시각이 없으면 불일치 */
export function inTimeRange(time: string | null, from: string | null, to: string | null): boolean {
  const t = parseHm(time)
  if (t === null) return false
  const a = parseHm(from)
  const b = parseHm(to)
  if (a === null && b === null) return true
  if (a !== null && b === null) return t >= a
  if (a === null && b !== null) return t <= b
  if (a! <= b!) return t >= a! && t <= b!
  return t >= a! || t <= b!
}

export interface RideFacts {
  summary: SeatSummary
  ordered: SeatEvent[]
  midSeat: number
}

export function seatGroups(trip: Trip, f: RideFacts) {
  const { summary, ordered } = f
  const hasEvents = ordered.length > 0
  const initial: SeatInitial | null = trip.kind !== 'ride' ? null : trip.initialSeat === 'seated' ? 'seated' : trip.initialSeat === 'standing' ? 'standing' : 'unrecorded'
  const change: SeatChange[] = []
  if (trip.kind === 'ride') {
    if (f.midSeat > 0) change.push('midSeat')
    if (summary.everSeated === false) change.push('stoodAll')
    if (trip.initialSeat === 'seated' && trip.seatLogComplete === true && !ordered.some((e) => e.state === 'standing')) change.push('seatedAll')
    if (!hasEvents && trip.seatLogComplete !== true) change.push('unconfirmed')
  }
  const final: SeatFinal | null = trip.kind !== 'ride' ? null : summary.final === 'seated' ? 'seated' : summary.final === 'standing' ? 'standing' : 'unknown'
  return { initial, change, final }
}

const anyOf = <T,>(sel: T[], v: T | null) => sel.length === 0 || (v !== null && sel.includes(v))

export interface SearchRecord {
  trip: Trip
  events: SeatEvent[]
  index: TripIndex
  facts: RideFacts
  duration: number | null
}

export function toRecords(trips: Trip[], events: SeatEvent[]): SearchRecord[] {
  const by = new Map<string, SeatEvent[]>()
  for (const e of events) {
    const a = by.get(e.tripId)
    if (a) a.push(e)
    else by.set(e.tripId, [e])
  }
  return trips.map((trip) => {
    const evs = by.get(trip.id) ?? []
    const ordered = orderEvents(trip, evs)
    return {
      trip,
      events: evs,
      index: buildIndex(trip, evs),
      facts: { summary: summarizeSeat(trip, evs), ordered, midSeat: countMidSeats(trip, ordered) },
      duration: tripDuration(trip),
    }
  })
}

export interface SearchMatch {
  rec: SearchRecord
  /** 키워드가 일치한 위치 */
  hits: KeywordHit[]
  /** 좌석 조건 등 필터가 일치한 항목 설명 */
  tags: string[]
}

export function matchRecord(rec: SearchRecord, f: SearchFilters, today: string): SearchMatch | null {
  const t = rec.trip
  const range = resolveDateRange(f, today)
  if (range.from && t.date < range.from) return null
  if (range.to && t.date > range.to) return null
  if (f.weekdays.length && !f.weekdays.includes(parseDate(t.date).getDay())) return null
  if (!anyOf(f.modes, t.mode) || !anyOf(f.kinds, t.kind)) return null
  if (f.purposes.length && !anyOf(f.purposes, t.purpose)) return null
  if (f.lines.length && !(t.line && f.lines.some((l) => norm(l) === norm(t.line!)))) return null
  const st = (sel: string[], v: string | null) => sel.length === 0 || (!!v && sel.some((s) => stationKey(s) === stationKey(v)))
  if (!st(f.boardStations, t.boardPlace) || !st(f.alightStations, t.alightPlace) || !st(f.destinations, t.trainDestination) || !st(f.origins, t.trainOrigin)) return null
  if (!anyOf(f.cars, t.car) || !anyOf(f.doors, t.door) || !anyOf(f.sides, t.side) || !anyOf(f.waitOrders, t.waitOrder)) return null
  if (f.boardFrom || f.boardTo) if (!inTimeRange(t.boardTime, f.boardFrom, f.boardTo)) return null
  if (f.alightFrom || f.alightTo) if (!inTimeRange(t.alightTime, f.alightFrom, f.alightTo)) return null
  if (f.durMin !== null || f.durMax !== null) {
    if (rec.duration === null) return null
    if (f.durMin !== null && rec.duration < f.durMin) return null
    if (f.durMax !== null && rec.duration > f.durMax) return null
  }
  if (f.crowding.length && !anyOf(f.crowding, t.crowding)) return null
  if (f.delay.length) {
    const d: DelayFilter = t.delayMinutes === null ? 'unrecorded' : t.delayMinutes > 0 ? 'yes' : 'no'
    if (!f.delay.includes(d)) return null
  }
  const tags: string[] = []
  if (f.seatInitial.length || f.seatChange.length || f.seatFinal.length) {
    const g = seatGroups(t, rec.facts)
    if (f.seatInitial.length && !(g.initial && f.seatInitial.includes(g.initial))) return null
    if (f.seatChange.length && !f.seatChange.some((c) => g.change.includes(c))) return null
    if (f.seatFinal.length && !(g.final && f.seatFinal.includes(g.final))) return null
  }
  let hits: KeywordHit[] = []
  if (f.q.trim()) {
    const h = matchKeywords(f.q, rec.index)
    if (h === null) return null
    hits = h
  }
  return { rec, hits, tags }
}

export function search(records: SearchRecord[], f: SearchFilters, today: string): SearchMatch[] {
  const out: SearchMatch[] = []
  for (const r of records) {
    const m = matchRecord(r, f, today)
    if (m) out.push(m)
  }
  return out
}

/** 같은 날짜 안에서는 승차 시각순(시각 없는 기록은 뒤). 날짜 순서와 소요 시간 정렬은 sort 로 정한다 */
export function sortMatches(ms: SearchMatch[], sort: SortKey): SearchMatch[] {
  const time = (m: SearchMatch) => parseHm(m.rec.trip.boardTime) ?? parseHm(m.rec.trip.alightTime)
  const byTime = (a: SearchMatch, b: SearchMatch) => {
    const ta = time(a)
    const tb = time(b)
    if (ta === null && tb === null) return a.rec.trip.createdAt - b.rec.trip.createdAt
    if (ta === null) return 1
    if (tb === null) return -1
    return ta - tb || a.rec.trip.createdAt - b.rec.trip.createdAt
  }
  const arr = [...ms]
  if (sort === 'durationDesc' || sort === 'durationAsc') {
    const dir = sort === 'durationDesc' ? -1 : 1
    return arr.sort((a, b) => {
      const da = a.rec.duration
      const db = b.rec.duration
      // 소요 시간을 모르는 기록은 항상 맨 뒤
      if (da === null && db === null) return b.rec.trip.date.localeCompare(a.rec.trip.date) || byTime(a, b)
      if (da === null) return 1
      if (db === null) return -1
      return (da - db) * dir || b.rec.trip.date.localeCompare(a.rec.trip.date) || byTime(a, b)
    })
  }
  const dir = sort === 'newest' ? -1 : 1
  return arr.sort((a, b) => a.rec.trip.date.localeCompare(b.rec.trip.date) * dir || byTime(a, b))
}

export function groupByDate(ms: SearchMatch[]): Array<[string, SearchMatch[]]> {
  const g = new Map<string, SearchMatch[]>()
  for (const m of ms) {
    const a = g.get(m.rec.trip.date)
    if (a) a.push(m)
    else g.set(m.rec.trip.date, [m])
  }
  return [...g.entries()]
}

/** 자동 완성 후보: 저장된 값만, 많이 쓴 순 (같은 역의 표기 차이는 가장 많이 쓴 표기로 합침) */
export function suggestionsFrom(values: Array<string | null | undefined>, limit = 12): string[] {
  const m = new Map<string, Map<string, number>>()
  for (const v of values) {
    const s = v?.trim()
    if (!s) continue
    const k = stationKey(s)
    const forms = m.get(k) ?? new Map<string, number>()
    forms.set(s, (forms.get(s) ?? 0) + 1)
    m.set(k, forms)
  }
  return [...m.values()]
    .map((forms) => {
      const total = [...forms.values()].reduce((a, b) => a + b, 0)
      const best = [...forms.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))[0][0]
      return { best, total }
    })
    .sort((a, b) => b.total - a.total || a.best.localeCompare(b.best, 'ko'))
    .slice(0, limit)
    .map((x) => x.best)
}
