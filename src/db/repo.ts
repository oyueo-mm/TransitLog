import { db as defaultDb, type TransitDB } from './db'
import { nowHm, todayStr } from '../domain/time'
import { cleanEvent, dedupeEvents } from '../domain/seatEdit'
import {
  emptyTripDraft,
  type DayLog,
  type RouteTemplate,
  type SeatEvent,
  type SeatEventDraft,
  type Trip,
  type TripDraft,
} from '../domain/types'

export function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // 보안 컨텍스트가 아닌 개발 환경(LAN http) 대비
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/** 저장 전 정리: 빈 문자열은 null, 해당 없음 필드는 값이 비어 있도록 */
export function normalizeTrip(t: Trip): Trip {
  const clean = (s: string | null) => {
    const v = s?.trim()
    return v ? v : null
  }
  const out: Trip = {
    ...t,
    line: clean(t.line),
    boardPlace: clean(t.boardPlace),
    alightPlace: clean(t.alightPlace),
    trainOrigin: clean(t.trainOrigin),
    trainDestination: clean(t.trainDestination),
    incident: clean(t.incident),
    note: clean(t.note),
    boardTime: t.boardTime || null,
    alightTime: t.alightTime || null,
  }
  for (const k of out.naFields) {
    ;(out as unknown as Record<string, unknown>)[k] = null
  }
  if (out.mode === 'bus') {
    out.trainOrigin = null
    out.trainDestination = null
    out.service = null
    out.car = null
    out.door = null
    out.side = null
  } else {
    out.busDoor = null
  }
  return out
}

export async function saveTrip(
  input: TripDraft | Trip,
  events?: SeatEventDraft[],
  d: TransitDB = defaultDb,
): Promise<Trip> {
  const now = Date.now()
  const existing = 'id' in input ? await d.trips.get(input.id) : undefined
  const trip = normalizeTrip({
    ...input,
    id: 'id' in input ? input.id : newId(),
    createdAt: existing?.createdAt ?? ('createdAt' in input ? input.createdAt : now),
    updatedAt: now,
  })
  await d.transaction('rw', d.trips, d.seatEvents, async () => {
    await d.trips.put(trip)
    if (events) {
      await d.seatEvents.where('tripId').equals(trip.id).delete()
      await d.seatEvents.bulkAdd(
        dedupeEvents(events.map(cleanEvent)).map((e, i) => ({
          ...e,
          id: newId(),
          tripId: trip.id,
          createdAt: now + i,
        })),
      )
    }
  })
  return trip
}

export async function deleteTrip(id: string, d: TransitDB = defaultDb): Promise<void> {
  await d.transaction('rw', d.trips, d.seatEvents, async () => {
    await d.seatEvents.where('tripId').equals(id).delete()
    await d.trips.delete(id)
  })
}

export async function getTripWithEvents(id: string, d: TransitDB = defaultDb) {
  const trip = await d.trips.get(id)
  if (!trip) return undefined
  const events = await d.seatEvents.where('tripId').equals(id).sortBy('createdAt')
  return { trip, events }
}

export async function tripsOnDate(date: string, d: TransitDB = defaultDb): Promise<Trip[]> {
  const list = await d.trips.where('date').equals(date).toArray()
  return sortTrips(list)
}

/** 승차 시각순. 시각이 없는 기록은 뒤로 */
export function sortTrips<T extends Pick<Trip, 'boardTime' | 'createdAt'>>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.boardTime && b.boardTime) return a.boardTime.localeCompare(b.boardTime) || a.createdAt - b.createdAt
    if (a.boardTime) return -1
    if (b.boardTime) return 1
    return a.createdAt - b.createdAt
  })
}

// ── 빠른 탑승 ────────────────────────────────────────────

/** '지금 탑승': 현재 시각을 승차 시각으로 기록하고 탑승 중 상태로 만든다 */
export async function startRide(
  draft: Partial<TripDraft> & Pick<TripDraft, 'mode'>,
  initialEvents: SeatEventDraft[] = [],
  d: TransitDB = defaultDb,
): Promise<Trip> {
  const base = emptyTripDraft(draft.date ?? todayStr(), draft.mode)
  return saveTrip(
    { ...base, ...draft, kind: 'ride', ongoing: true, boardTime: draft.boardTime ?? nowHm() },
    initialEvents,
    d,
  )
}

/** '하차': 종료 시각을 기록. 소요 시간은 승차·하차 시각에서 계산된다 */
export async function endRide(
  id: string,
  patch: Partial<Trip> = {},
  d: TransitDB = defaultDb,
): Promise<Trip | undefined> {
  const t = await d.trips.get(id)
  if (!t) return undefined
  return saveTrip({ ...t, ...patch, ongoing: false, alightTime: patch.alightTime ?? nowHm() }, undefined, d)
}

export async function addSeatEvent(
  tripId: string,
  e: SeatEventDraft,
  d: TransitDB = defaultDb,
): Promise<SeatEvent> {
  const ev: SeatEvent = { ...e, id: newId(), tripId, createdAt: Date.now() }
  await d.seatEvents.add(ev)
  // 새 변화가 생기면 '기록 완료' 확인은 무효가 된다
  await d.trips.update(tripId, { seatLogComplete: null, updatedAt: Date.now() })
  return ev
}

export async function ongoingTrip(d: TransitDB = defaultDb): Promise<Trip | undefined> {
  // boolean 은 IndexedDB 키가 될 수 없으므로 인덱스 없이 필터링한다 (기록 수가 적어 충분히 빠름)
  const all = await d.trips.filter((t) => t.ongoing === true).toArray()
  return all.sort((a, b) => b.createdAt - a.createdAt)[0]
}

// ── 일지 ─────────────────────────────────────────────────

export async function saveDay(date: string, patch: Partial<DayLog>, d: TransitDB = defaultDb) {
  const cur = await d.days.get(date)
  const day: DayLog = {
    date,
    homeDepart: null,
    schoolDepart: null,
    schoolArrive: null,
    homeArrive: null,
    note: null,
    ...cur,
    ...patch,
    updatedAt: Date.now(),
  }
  await d.days.put(day)
  return day
}

// ── 템플릿 ───────────────────────────────────────────────

export function templateFromTrip(t: Trip, name?: string): RouteTemplate {
  return {
    id: newId(),
    name: name?.trim() || defaultTemplateName(t),
    mode: t.mode,
    purpose: t.purpose,
    line: t.line,
    boardPlace: t.boardPlace,
    alightPlace: t.alightPlace,
    trainOrigin: t.trainOrigin,
    trainDestination: t.trainDestination,
    service: t.service,
    car: t.car,
    door: t.door,
    side: t.side,
    busDoor: t.busDoor,
    useCount: 0,
    lastUsedAt: null,
    createdAt: Date.now(),
  }
}

export function defaultTemplateName(t: Pick<Trip, 'line' | 'boardPlace' | 'alightPlace' | 'trainDestination' | 'mode'>): string {
  const parts = [t.line, t.boardPlace && t.alightPlace ? `${t.boardPlace}→${t.alightPlace}` : t.boardPlace]
  if (t.trainDestination) parts.push(`${t.trainDestination}행`)
  const s = parts.filter(Boolean).join(' ')
  return s || (t.mode === 'subway' ? '지하철 경로' : '버스 경로')
}

export async function saveTemplate(t: RouteTemplate, d: TransitDB = defaultDb) {
  await d.templates.put(t)
  return t
}
export async function deleteTemplate(id: string, d: TransitDB = defaultDb) {
  await d.templates.delete(id)
}
export async function touchTemplate(id: string, d: TransitDB = defaultDb) {
  const t = await d.templates.get(id)
  if (t) await d.templates.put({ ...t, useCount: t.useCount + 1, lastUsedAt: Date.now() })
}

// ── 설정 ─────────────────────────────────────────────────

export async function getSetting<T>(key: string, fallback: T, d: TransitDB = defaultDb): Promise<T> {
  const s = await d.settings.get(key)
  return s ? (s.value as T) : fallback
}
export async function setSetting(key: string, value: unknown, d: TransitDB = defaultDb) {
  await d.settings.put({ key, value })
}

// ── 중복 ─────────────────────────────────────────────────

/** 같은 날짜·종류·승차 시각·노선·승하차 장소를 가진 기록이면 같은 기록으로 본다 */
export function tripFingerprint(t: Pick<Trip, 'date' | 'kind' | 'mode' | 'boardTime' | 'line' | 'boardPlace' | 'alightPlace' | 'trainDestination'>): string {
  const n = (s: string | null) => (s ?? '').replace(/\s+/g, '').toLowerCase()
  return [t.date, t.kind, t.mode, t.boardTime ?? '', n(t.line), n(t.boardPlace), n(t.alightPlace), n(t.trainDestination)].join('|')
}

export async function existingFingerprints(d: TransitDB = defaultDb): Promise<Set<string>> {
  const all = await d.trips.toArray()
  return new Set(all.map(tripFingerprint))
}
