import { presetFor, sameStation, stationKey } from './stations'
import type { Mode, Trip } from './types'

/**
 * 노선·승차역을 기준으로 한 역/운행 구간 추천.
 * 추천은 제안일 뿐이다 — 화면에서 누르기 전에는 기록에 저장되지 않으며, 좌석 상태·혼잡도 같은 관측값은 다루지 않는다.
 * 표기가 달라도 같은 역('수원'/'수원역')은 한 항목으로 묶어 이름을 일관되게 보여 준다.
 */
export type SuggestionSource = 'frequent' | 'preset' | 'history'

export interface PlaceSuggestion {
  value: string
  source: SuggestionSource
  /** 과거 기록에서 쓴 횟수 */
  count: number
}

interface Tally {
  display: Map<string, number>
  count: number
  last: number
}

const rides = (trips: Trip[]) => trips.filter((t) => t.kind === 'ride')

/** 이름별(같은 역은 한 항목) 횟수. 표시 이름은 가장 많이 쓴 표기 */
function tally(items: Array<{ name: string | null | undefined; at: number }>): Map<string, Tally> {
  const m = new Map<string, Tally>()
  for (const { name, at } of items) {
    const v = name?.trim()
    if (!v) continue
    const k = stationKey(v)
    const t = m.get(k) ?? { display: new Map(), count: 0, last: 0 }
    t.display.set(v, (t.display.get(v) ?? 0) + 1)
    t.count++
    t.last = Math.max(t.last, at)
    m.set(k, t)
  }
  return m
}
const bestDisplay = (t: Tally): string =>
  [...t.display.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0]
const byCount = (a: Tally, b: Tally) => b.count - a.count || b.last - a.last

function addUnique(out: PlaceSuggestion[], seen: Set<string>, value: string, source: SuggestionSource, count: number, limit: number) {
  const k = stationKey(value)
  if (!k || seen.has(k) || out.length >= limit) return
  seen.add(k)
  out.push({ value, source, count })
}

export interface StationOpts {
  mode?: Mode
  line: string | null
  role: 'board' | 'alight'
  /** 하차역 추천 때, 이 승차역에서 자주 내린 역을 앞에 둔다 */
  boardPlace?: string | null
  /** 추천에서 뺄 역 (예: 하차역 추천에서 이미 고른 승차역) */
  exclude?: string | null
  limit?: number
}

/**
 * 승차역·하차역 추천.
 *  하차역: (선택한 승차역에서 자주 내린 역) → 노선 프리셋 → 그 노선 기록에서 자주 쓴 역
 *  승차역: 노선 프리셋 → 그 노선 기록에서 자주 쓴 역
 * 노선이 프리셋에 없으면 기록 기반 추천만 한다.
 */
export function suggestStations(trips: Trip[], o: StationOpts): PlaceSuggestion[] {
  const limit = o.limit ?? 8
  const mode = o.mode ?? 'subway'
  const pool = rides(trips).filter((t) => t.mode === mode && (!o.line || t.line === o.line))
  const pickOf = (t: Trip) => (o.role === 'board' ? t.boardPlace : t.alightPlace)
  const all = tally(pool.map((t) => ({ name: pickOf(t), at: t.createdAt })))
  const out: PlaceSuggestion[] = []
  const seen = new Set<string>()
  if (o.exclude) seen.add(stationKey(o.exclude))

  if (o.role === 'alight' && o.boardPlace) {
    const sub = tally(pool.filter((t) => sameStation(t.boardPlace, o.boardPlace)).map((t) => ({ name: t.alightPlace, at: t.createdAt })))
    for (const t of [...sub.values()].sort(byCount).slice(0, 3)) addUnique(out, seen, bestDisplay(t), 'frequent', t.count, limit)
  }
  if (mode === 'subway') {
    for (const s of presetFor(o.line)?.stations ?? []) addUnique(out, seen, s, 'preset', all.get(stationKey(s))?.count ?? 0, limit)
  }
  for (const t of [...all.values()].sort(byCount)) addUnique(out, seen, bestDisplay(t), 'history', t.count, limit)
  return out
}

export interface EndOpts {
  line: string | null
  role: 'origin' | 'destination'
  /** 선택한 승차역과 함께 쓴 값을 프리셋 다음에 둔다 */
  boardPlace?: string | null
  limit?: number
}

/** 열차 운행 출발지·종착역 추천: 노선 프리셋 → (승차역과 함께 쓴) 기록의 값 → 기록의 다른 값. 출발지와 종착역은 서로 독립 */
export function suggestTrainEnds(trips: Trip[], o: EndOpts): PlaceSuggestion[] {
  const limit = o.limit ?? 10
  const pool = rides(trips).filter((t) => t.mode === 'subway' && (!o.line || t.line === o.line))
  const pickOf = (t: Trip) => (o.role === 'origin' ? t.trainOrigin : t.trainDestination)
  const near = o.boardPlace ? pool.filter((t) => sameStation(t.boardPlace, o.boardPlace)) : []
  const nearTally = tally(near.map((t) => ({ name: pickOf(t), at: t.createdAt })))
  const all = tally(pool.map((t) => ({ name: pickOf(t), at: t.createdAt })))
  const out: PlaceSuggestion[] = []
  const seen = new Set<string>()
  for (const s of presetFor(o.line)?.ends ?? []) addUnique(out, seen, s, 'preset', all.get(stationKey(s))?.count ?? 0, limit)
  for (const t of [...nearTally.values()].sort(byCount)) addUnique(out, seen, bestDisplay(t), 'frequent', t.count, limit)
  for (const t of [...all.values()].sort(byCount)) addUnique(out, seen, bestDisplay(t), 'history', t.count, limit)
  return out
}

export interface PairSuggestion {
  origin: string | null
  destination: string | null
  source: SuggestionSource
  count: number
}

/** 자주 쓴 운행 구간(출발지·종착역) 조합. 승차역과 함께 쓴 조합을 앞에 두고, 수인분당선은 대표 조합을 기본으로 보여 준다 */
export function suggestTrainPairs(trips: Trip[], o: { line: string | null; boardPlace?: string | null; limit?: number }): PairSuggestion[] {
  const limit = o.limit ?? 4
  const pool = rides(trips).filter((t) => t.mode === 'subway' && (!o.line || t.line === o.line) && (t.trainOrigin || t.trainDestination))
  const m = new Map<string, PairSuggestion & { near: boolean }>()
  for (const t of pool) {
    const k = `${stationKey(t.trainOrigin)}>${stationKey(t.trainDestination)}`
    const near = !!o.boardPlace && sameStation(t.boardPlace, o.boardPlace)
    const cur = m.get(k)
    if (cur) {
      cur.count++
      cur.near = cur.near || near
    } else m.set(k, { origin: t.trainOrigin, destination: t.trainDestination, source: 'history', count: 1, near })
  }
  const hist = [...m.values()].sort((a, b) => Number(b.near) - Number(a.near) || b.count - a.count)
  const out: PairSuggestion[] = hist
    .slice(0, limit)
    .map((p) => ({ origin: p.origin, destination: p.destination, source: p.near ? ('frequent' as const) : ('history' as const), count: p.count }))
  for (const [a, b] of presetFor(o.line)?.pairs ?? []) {
    if (out.length >= limit) break
    if (!out.some((p) => stationKey(p.origin) === stationKey(a) && stationKey(p.destination) === stationKey(b))) {
      out.push({ origin: a, destination: b, source: 'preset', count: 0 })
    }
  }
  return out
}

/** 중간 착석 역 추천: 그 노선의 프리셋 역 + 기록(좌석 변화 장소, 승·하차역)에서 자주 쓴 역 */
export function suggestSeatPlaces(
  trips: Trip[],
  events: Array<{ tripId: string; place: string | null }>,
  o: { line: string | null; mode?: Mode; limit?: number },
): PlaceSuggestion[] {
  const limit = o.limit ?? 10
  const mode = o.mode ?? 'subway'
  const pool = trips.filter((t) => t.mode === mode && (!o.line || t.line === o.line))
  const ids = new Set(pool.map((t) => t.id))
  const items: Array<{ name: string | null; at: number }> = []
  for (const e of events) if (ids.has(e.tripId)) items.push({ name: e.place, at: 0 })
  for (const t of pool) items.push({ name: t.boardPlace, at: t.createdAt }, { name: t.alightPlace, at: t.createdAt })
  const all = tally(items)
  const out: PlaceSuggestion[] = []
  const seen = new Set<string>()
  if (mode === 'subway') for (const s of presetFor(o.line)?.stations ?? []) addUnique(out, seen, s, 'preset', all.get(stationKey(s))?.count ?? 0, limit)
  for (const t of [...all.values()].sort(byCount)) addUnique(out, seen, bestDisplay(t), 'history', t.count, limit)
  return out
}

function uniqueNames(first: string[], rest: Array<string | null | undefined>): string[] {
  const names = new Map<string, string>()
  for (const n of [...first, ...rest]) {
    const v = n?.trim()
    if (v && !names.has(stationKey(v))) names.set(stationKey(v), v)
  }
  return [...names.values()]
}

/** 입력 칸 검색(자동완성) 후보: 프리셋 역 + 기록·좌석 변화에 나온 모든 역. 직접 입력한 이름을 이 표기로 맞추는 데도 쓴다 */
export function knownStations(trips: Trip[], events: Array<{ place: string | null }> = []): string[] {
  const presets = ['수인분당선', '1호선', '2호선'].flatMap((p) => presetFor(p)?.stations ?? [])
  return uniqueNames(presets, [...trips.flatMap((t) => [t.boardPlace, t.alightPlace]), ...events.map((e) => e.place)])
}

export function knownTrainEnds(trips: Trip[]): string[] {
  const presets = ['수인분당선', '1호선', '2호선'].flatMap((p) => presetFor(p)?.ends ?? [])
  return uniqueNames(presets, trips.flatMap((t) => [t.trainOrigin, t.trainDestination]))
}
