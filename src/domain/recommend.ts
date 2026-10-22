import { parseHm, weekdayIndex, diffMinutes } from './time'
import { sameStation } from './stations'
import type { Mode, RouteTemplate, Trip, TripDraft } from './types'

/**
 * 추천은 '제안'일 뿐이다. 이 모듈이 돌려주는 값은 화면에서 사용자가 누르기 전에는
 * 기록에 저장되지 않으며, 좌석 상태·혼잡도처럼 그 순간의 관측값은 절대 추천하지 않는다.
 */
export type SuggestedFields = Partial<
  Pick<
    TripDraft,
    | 'mode'
    | 'purpose'
    | 'line'
    | 'boardPlace'
    | 'alightPlace'
    | 'trainOrigin'
    | 'trainDestination'
    | 'service'
    | 'car'
    | 'door'
    | 'side'
    | 'busDoor'
  >
>

export interface RouteSuggestion {
  key: string
  label: string
  fields: SuggestedFields
  count: number
  score: number
  reasons: string[]
  templateId?: string
}

export interface RecommendContext {
  now: Date
  /** 'HH:mm' 현재 시각 */
  nowHm: string
  mode?: Mode
}

const rides = (trips: Trip[]) => trips.filter((t) => t.kind === 'ride')

function routeKey(t: Pick<Trip, 'mode' | 'line' | 'boardPlace' | 'alightPlace' | 'trainDestination'>): string {
  return [t.mode, t.line ?? '', t.boardPlace ?? '', t.alightPlace ?? '', t.trainDestination ?? ''].join('|')
}

export function routeLabel(t: SuggestedFields & Pick<Trip, 'mode'>): string {
  const parts: string[] = []
  if (t.line) parts.push(t.line)
  if (t.boardPlace || t.alightPlace) parts.push(`${t.boardPlace ?? '?'}→${t.alightPlace ?? '?'}`)
  if (t.trainDestination) parts.push(`${t.trainDestination}행`)
  return parts.join(' ') || (t.mode === 'subway' ? '지하철' : '버스')
}

function mostCommon<T>(values: Array<T | null>): T | null {
  const m = new Map<T, number>()
  for (const v of values) if (v !== null) m.set(v, (m.get(v) ?? 0) + 1)
  let best: T | null = null
  let n = 0
  for (const [k, c] of m) {
    if (c > n) {
      best = k
      n = c
    }
  }
  return best
}

/**
 * 같은 요일·비슷한 시간대에 자주 탄 경로를 우선하는 경로 추천.
 * 점수 = 이용 횟수 + 같은 요일 가산 + 현재 시각과 ±60분 이내 가산 + 최근성
 */
export function suggestRoutes(trips: Trip[], templates: RouteTemplate[], ctx: RecommendContext, limit = 6): RouteSuggestion[] {
  const nowMin = parseHm(ctx.nowHm)
  const wd = weekdayIndex(
    `${ctx.now.getFullYear()}-${String(ctx.now.getMonth() + 1).padStart(2, '0')}-${String(ctx.now.getDate()).padStart(2, '0')}`,
  )
  const groups = new Map<string, Trip[]>()
  for (const t of rides(trips)) {
    if (ctx.mode && t.mode !== ctx.mode) continue
    if (!t.line && !t.boardPlace && !t.trainDestination) continue
    const k = routeKey(t)
    const g = groups.get(k)
    if (g) g.push(t)
    else groups.set(k, [t])
  }
  const out: RouteSuggestion[] = []
  const nowMs = ctx.now.getTime()
  for (const [key, g] of groups) {
    let sameWd = 0
    let sameTime = 0
    for (const t of g) {
      if (weekdayIndex(t.date) === wd) sameWd++
      const gap = nowMin === null ? null : diffMinutes(t.boardTime, ctx.nowHm)
      if (gap !== null && (gap <= 60 || gap >= 1380)) sameTime++
    }
    const latest = g.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
    const ageDays = Math.max(0, (nowMs - latest.createdAt) / 86_400_000)
    const recency = Math.max(0, 1 - ageDays / 60)
    const score = g.length + sameWd * 2 + sameTime * 2 + recency * 2
    const reasons: string[] = []
    if (sameWd && sameTime) reasons.push('같은 요일·시간대')
    else if (sameTime) reasons.push('비슷한 시간대')
    else if (sameWd) reasons.push('같은 요일')
    reasons.push(`${g.length}회 이용`)
    const s = g[0]
    const fields: SuggestedFields = {
      mode: s.mode,
      line: s.line,
      boardPlace: s.boardPlace,
      alightPlace: s.alightPlace,
      trainDestination: s.trainDestination,
      trainOrigin: mostCommon(g.map((t) => t.trainOrigin)),
      service: mostCommon(g.map((t) => t.service)),
      car: mostCommon(g.map((t) => t.car)),
      door: mostCommon(g.map((t) => t.door)),
      side: mostCommon(g.map((t) => t.side)),
      busDoor: mostCommon(g.map((t) => t.busDoor)),
      purpose: mostCommon(g.map((t) => t.purpose)),
    }
    out.push({ key, label: routeLabel(fields as SuggestedFields & Pick<Trip, 'mode'>), fields, count: g.length, score, reasons })
  }
  for (const tpl of templates) {
    if (ctx.mode && tpl.mode !== ctx.mode) continue
    const fields: SuggestedFields = {
      mode: tpl.mode,
      purpose: tpl.purpose,
      line: tpl.line,
      boardPlace: tpl.boardPlace,
      alightPlace: tpl.alightPlace,
      trainOrigin: tpl.trainOrigin,
      trainDestination: tpl.trainDestination,
      service: tpl.service,
      car: tpl.car,
      door: tpl.door,
      side: tpl.side,
      busDoor: tpl.busDoor,
    }
    const existing = out.find((o) => o.key === routeKey({ ...tpl, trainDestination: tpl.trainDestination }))
    // 저장해 둔 템플릿은 가산점(직접 만든 경로이므로)
    if (existing) {
      existing.score += 3
      existing.templateId = tpl.id
      existing.label = tpl.name
      existing.reasons.unshift('저장한 경로')
    } else {
      out.push({
        key: `tpl:${tpl.id}`,
        label: tpl.name,
        fields,
        count: tpl.useCount,
        score: 3 + tpl.useCount,
        reasons: ['저장한 경로'],
        templateId: tpl.id,
      })
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

export interface Ranked {
  value: string
  count: number
}

/** 최근·자주 쓴 값 순위 (빠른 선택 칩용) */
export function rankedValues(
  trips: Trip[],
  pick: (t: Trip) => string | null,
  filter: (t: Trip) => boolean = () => true,
  limit = 8,
): Ranked[] {
  const m = new Map<string, { count: number; last: number }>()
  for (const t of trips) {
    if (!filter(t)) continue
    const v = pick(t)
    if (!v) continue
    const cur = m.get(v)
    m.set(v, { count: (cur?.count ?? 0) + 1, last: Math.max(cur?.last ?? 0, t.createdAt) })
  }
  return [...m.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .slice(0, limit)
    .map(([value, { count }]) => ({ value, count }))
}

/** 직전 하차역을 다음 승차역으로 제안. 오늘 하차 기록이 있는 가장 최근 탑승만 사용 */
export function suggestBoardFromPrevAlight(trips: Trip[], today: string, nowHm: string, withinMinutes = 180): string | null {
  const todays = rides(trips).filter((t) => t.date === today && t.alightPlace && t.alightTime)
  let best: Trip | null = null
  for (const t of todays) {
    const gap = diffMinutes(t.alightTime, nowHm)
    if (gap === null || gap > withinMinutes) continue
    if (!best || (t.alightTime ?? '') > (best.alightTime ?? '')) best = t
  }
  return best?.alightPlace ?? null
}

/** 선택한 노선·승차 장소에서 자주 쓴 탑승 위치(칸-문, 좌우) */
export function suggestPositions(trips: Trip[], line: string | null, boardPlace: string | null, limit = 4) {
  const m = new Map<string, { car: number; door: number; side: Trip['side']; count: number }>()
  for (const t of rides(trips)) {
    if (t.mode !== 'subway' || t.car === null || t.door === null) continue
    if (line && t.line !== line) continue
    if (boardPlace && !sameStation(t.boardPlace, boardPlace)) continue
    const k = `${t.car}-${t.door}-${t.side ?? ''}`
    const cur = m.get(k)
    if (cur) cur.count++
    else m.set(k, { car: t.car, door: t.door, side: t.side, count: 1 })
  }
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, limit)
}
