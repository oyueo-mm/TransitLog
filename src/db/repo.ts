import { db as defaultDb, type TransitDB } from './db'
import { nowHm, todayStr } from '../domain/time'
import { cleanEvent, dedupeEvents } from '../domain/seatEdit'
import { currentSeat, nextCreatedAt, seatContentChanged } from '../domain/seatLog'
import {
  emptyTripDraft,
  type DayLog,
  type RouteTemplate,
  type SeatEvent,
  type SeatEventDraft,
  type SeatState,
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
  if (out.kind !== 'ride') out.ongoing = false
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
      const used = new Set<string>()
      await d.seatEvents.bulkAdd(
        dedupeEvents(events.map(cleanEvent)).map((e, i) => {
          // 기존 이벤트는 같은 식별자를 유지한다 (같은 id 가 두 번 나오면 두 번째에 새 id)
          const id = e.id && !used.has(e.id) ? e.id : newId()
          used.add(id)
          return { ...e, id, tripId: trip.id, createdAt: now + i }
        }),
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
  const alightTime = patch.alightTime ?? nowHm()
  // Serialize completion across rapid clicks and tabs; a second request cannot
  // overwrite the first completion or later edits made in the trip editor.
  return d.transaction('rw', d.trips, d.seatEvents, async () => {
    const t = await d.trips.get(id)
    if (!t || t.kind !== 'ride' || !t.ongoing) return undefined
    return saveTrip({ ...t, ...patch, ongoing: false, alightTime }, undefined, d)
  })
}

/**
 * 탑승 중 좌석 변화를 하나 더한다.
 *  - 현재 좌석과 같은 상태(앉아 있는데 또 '앉았다')는 중복 요청으로 보고 만들지 않는다 → null
 *  - 같은 분의 서로 다른 변화(착석→일어섬)는 그대로 모두 저장하고 입력 순서를 보존한다
 *  - 이벤트가 달라졌으므로 '기록 완결' 확인은 해제한다
 */
export async function addSeatEvent(tripId: string, e: SeatEventDraft, d: TransitDB = defaultDb): Promise<SeatEvent | null> {
  return d.transaction('rw', d.trips, d.seatEvents, async () => {
    const trip = await d.trips.get(tripId)
    if (!trip) return null
    const existing = await d.seatEvents.where('tripId').equals(tripId).sortBy('createdAt')
    if (currentSeat(trip, existing) === e.state) return null
    const ev: SeatEvent = { ...cleanEvent(e), id: newId(), tripId, createdAt: nextCreatedAt(existing) }
    await d.seatEvents.add(ev)
    await d.trips.update(tripId, { seatLogComplete: null, updatedAt: Date.now() })
    return ev
  })
}

export type SeatEventPatch = Partial<Pick<SeatEvent, 'state' | 'time' | 'place' | 'note'>>

/** 이벤트 하나만 고친다 (식별자·입력 순서 유지). 상태나 시각이 바뀌면 완결 확인을 해제한다 */
export async function updateSeatEvent(id: string, patch: SeatEventPatch, d: TransitDB = defaultDb): Promise<SeatEvent | null> {
  return d.transaction('rw', d.trips, d.seatEvents, async () => {
    const cur = await d.seatEvents.get(id)
    if (!cur) return null
    const next = { ...cur, ...cleanEvent({ time: cur.time, state: cur.state, place: cur.place, note: cur.note, ...patch }) }
    await d.seatEvents.put(next)
    const trip = await d.trips.get(cur.tripId)
    if (trip && seatContentChanged({ initialSeat: trip.initialSeat, events: [cur] }, { initialSeat: trip.initialSeat, events: [next] })) {
      await d.trips.update(trip.id, { seatLogComplete: null, updatedAt: Date.now() })
    } else if (trip) {
      await d.trips.update(trip.id, { updatedAt: Date.now() })
    }
    return next
  })
}

/** 좌석 이벤트 *하나*만 지운다. 탑승 기록과 다른 이벤트는 그대로 두고 완결 확인은 해제한다 */
export async function deleteSeatEvent(id: string, d: TransitDB = defaultDb): Promise<SeatEvent | null> {
  return d.transaction('rw', d.trips, d.seatEvents, async () => {
    const cur = await d.seatEvents.get(id)
    if (!cur) return null
    await d.seatEvents.delete(id)
    await d.trips.update(cur.tripId, { seatLogComplete: null, updatedAt: Date.now() })
    return cur
  })
}

/** 탑승 시 좌석을 지정·변경한다(완결 확인은 해제) */
export async function setInitialSeat(tripId: string, seat: SeatState | null, d: TransitDB = defaultDb): Promise<void> {
  await d.transaction('rw', d.trips, async () => {
    const t = await d.trips.get(tripId)
    if (!t || t.initialSeat === seat) return
    await d.trips.update(tripId, { initialSeat: seat, seatLogComplete: null, updatedAt: Date.now() })
  })
}

/** 실행 취소용: 한 탑승의 좌석 관련 상태(이벤트 전체 + 탑승 시 좌석 + 완결 확인)를 그대로 저장해 둔다 */
export interface SeatSnapshot {
  tripId: string
  initialSeat: SeatState | null
  seatLogComplete: boolean | null
  events: SeatEvent[]
}

export async function captureSeatState(tripId: string, d: TransitDB = defaultDb): Promise<SeatSnapshot | null> {
  const t = await d.trips.get(tripId)
  if (!t) return null
  const events = await d.seatEvents.where('tripId').equals(tripId).sortBy('createdAt')
  return { tripId, initialSeat: t.initialSeat, seatLogComplete: t.seatLogComplete, events }
}

/** 저장해 둔 상태로 되돌린다. 같은 식별자·입력 순서로 이벤트를 복원하며 탑승 기록의 다른 값은 건드리지 않는다 */
export async function restoreSeatState(snap: SeatSnapshot, d: TransitDB = defaultDb): Promise<void> {
  await d.transaction('rw', d.trips, d.seatEvents, async () => {
    if (!(await d.trips.get(snap.tripId))) return
    await d.seatEvents.where('tripId').equals(snap.tripId).delete()
    await d.seatEvents.bulkAdd(snap.events)
    await d.trips.update(snap.tripId, { initialSeat: snap.initialSeat, seatLogComplete: snap.seatLogComplete, updatedAt: Date.now() })
  })
}

export async function ongoingTrip(d: TransitDB = defaultDb): Promise<Trip | undefined> {
  // boolean 은 IndexedDB 키가 될 수 없으므로 인덱스 없이 필터링한다 (기록 수가 적어 충분히 빠름)
  const all = await d.trips.filter((t) => t.kind === 'ride' && t.ongoing === true).toArray()
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
