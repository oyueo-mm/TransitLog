import { orderEvents } from './seat'
import { currentSeat } from './seatLog'
import { diffMinutes, formatDuration, parseHm } from './time'
import type { SeatEvent, SeatState, Trip } from './types'

/**
 * 하루 이동 타임라인의 계산 부분 (화면과 분리한 순수 함수).
 *
 * 좌표는 '그 날 00:00 으로부터의 분'이다. 자정을 넘겨 하차하면 1440 을 넘는 값(다음 날 연장 구간)이 된다.
 *
 * 원칙
 *  - 시각이 없는 값은 다른 날이나 다른 기록으로 추정해 채우지 않는다.
 *  - 승·하차 시각이 같으면 24시간 탑승으로 해석하지 않고 점으로 둔다.
 *  - 좌석 상태는 기록된 사실로 확인되는 구간만 '서서/앉아서'로, 나머지는 '미확인'으로 둔다.
 */
export type SeatSegState = SeatState | 'unknown'

export interface SeatSegment {
  start: number
  end: number
  state: SeatSegState
  /** 진행 중인 탑승의 '현재까지' 잠정 구간 */
  provisional?: boolean
}

export interface SeatTick {
  at: number
  state: SeatState
  /** 'HH:mm 착석 · 역' 같은 표시용 문장 */
  label: string
  eventId: string
}

export type TimelineKind =
  /** 승·하차 시각이 모두 있는 탑승 구간 */
  | 'span'
  /** 승차 시각만 있음 (하차 미기록) */
  | 'point-board'
  /** 하차 시각만 있음 (승차 미기록) */
  | 'point-alight'
  /** 승·하차 시각이 같음 (0분) */
  | 'point-same'
  /** 탑승 중: 확정 구간 + 현재까지의 잠정 구간 */
  | 'ongoing'
  /** 탑승하지 않은 기록(놓침·관찰)의 시각 */
  | 'skipped'

export interface TimelineItem {
  id: string
  trip: Trip
  /** 시간 순서(같은 분이면 입력 순서)로 정렬된 좌석 이벤트 */
  events: SeatEvent[]
  kind: TimelineKind
  isRide: boolean
  /** 막대·점의 시작/끝 (분). 점이면 start === end */
  start: number
  end: number
  /** 그래프 행을 묶는 이름: 노선(버스 번호) 또는 '비탑승' */
  group: string
  line: string
  segments: SeatSegment[]
  ticks: SeatTick[]
  crossesMidnight: boolean
  /** 확정된 탑승 시간(분). 구간이 아니면 null */
  durationMin: number | null
  notes: string[]
}

export interface TimelineModel {
  items: TimelineItem[]
  /** 그래프에 놓을 수 없는(시각이 없는) 기록 */
  untimed: TimelineItem[]
  /** 축의 끝(분): 24시간이거나, 자정을 넘긴 하차가 있으면 그 시각을 포함하도록 올림한 값 */
  axisEnd: number
  /** 실제 이동이 있는 시간대(확대 보기용). 그릴 것이 없으면 null */
  focus: { start: number; end: number } | null
}

const DAY = 1440
const LABEL_FALLBACK = '노선 미기록'

function lineOf(t: Trip): string {
  return t.line ?? (t.mode === 'bus' ? '버스 번호 미기록' : LABEL_FALLBACK)
}

/** 'HH:mm 착석 · 역' */
function tickLabel(e: SeatEvent): string {
  return [e.time ?? '시각 미기록', e.state === 'seated' ? '착석' : '일어섬', e.place].filter(Boolean).join(' · ')
}

/**
 * 한 탑승의 좌석 상태를 시간 구간으로 나눈다.
 *  - 탑승 시 좌석(initialSeat)은 승차 시각부터 첫 좌석 변화까지 유지된다 (탑승 시 좌석이 없으면 그 구간은 미확인).
 *  - 각 변화는 그 시각부터 다음 변화까지의 상태가 된다. 같은 분의 변화는 길이 0 구간이라 그려지지 않지만 눈금(tick)과 순서는 남는다.
 *  - 마지막 변화 이후는 '좌석 변화 기록 완결'이 확인된 경우에만 그 상태로 본다. 그렇지 않으면 미확인이다.
 *  - 시각이 없는 변화나 탑승 구간 밖의 변화를 만나면 거기서부터는 미확인으로 두고 이유를 notes 에 남긴다.
 *  - 진행 중(provisional)인 탑승은 현재 좌석 상태가 현재 시각까지 이어지는 잠정 구간으로 표시한다.
 */
export function seatSegments(
  trip: Pick<Trip, 'boardTime' | 'initialSeat' | 'seatLogComplete'>,
  ordered: SeatEvent[],
  start: number,
  end: number,
  provisional = false,
): { segments: SeatSegment[]; ticks: SeatTick[]; notes: string[] } {
  const segments: SeatSegment[] = []
  const ticks: SeatTick[] = []
  const notes: string[] = []
  let cursor = start
  let cur: SeatState | null = trip.initialSeat
  let broken = false

  const push = (a: number, b: number, state: SeatSegState, prov = false) => {
    if (b <= a) return
    const last = segments[segments.length - 1]
    if (last && last.state === state && last.end === a && !!last.provisional === prov) last.end = b
    else segments.push({ start: a, end: b, state, ...(prov ? { provisional: true } : {}) })
  }

  for (const e of ordered) {
    const off = diffMinutes(trip.boardTime, e.time)
    if (off === null) {
      notes.push('시각이 기록되지 않은 좌석 변화가 있어 그 이후 구간은 미확인으로 둡니다')
      broken = true
      break
    }
    const t = start + off
    if (t > end) {
      notes.push('좌석 변화 시각이 탑승 구간 밖이라 그 이후 구간은 미확인으로 둡니다')
      broken = true
      break
    }
    push(cursor, t, cur ?? 'unknown')
    ticks.push({ at: t, state: e.state, label: tickLabel(e), eventId: e.id })
    cursor = t
    cur = e.state
  }

  if (cursor < end) {
    if (broken) push(cursor, end, 'unknown')
    else if (provisional) push(cursor, end, cur ?? 'unknown', true)
    else if (trip.seatLogComplete === true) push(cursor, end, cur ?? 'unknown')
    else {
      push(cursor, end, 'unknown')
      if (ordered.length > 0 || trip.initialSeat !== null) notes.push('마지막 좌석 변화 이후 변화가 없다는 확인이 없어 그 구간은 미확인입니다')
    }
  }
  if (trip.initialSeat === null && ordered.length === 0) notes.push('좌석 상태가 기록되지 않았습니다')
  return { segments, ticks, notes }
}

export interface BuildOptions {
  /** 보고 있는 날짜가 오늘일 때만 현재 시각(분)을 준다. 진행 중인 탑승의 잠정 구간 끝이 된다 */
  nowMinute: number | null
}

/** 하루 기록(한 날짜의 trips)과 좌석 이벤트로 타임라인 모델을 만든다 */
export function buildTimeline(trips: Trip[], events: SeatEvent[], opts: BuildOptions = { nowMinute: null }): TimelineModel {
  const byTrip = new Map<string, SeatEvent[]>()
  for (const e of events) {
    const arr = byTrip.get(e.tripId)
    if (arr) arr.push(e)
    else byTrip.set(e.tripId, [e])
  }
  const sorted = [...trips].sort((a, b) => {
    const am = parseHm(a.boardTime) ?? parseHm(a.alightTime) ?? Infinity
    const bm = parseHm(b.boardTime) ?? parseHm(b.alightTime) ?? Infinity
    return am - bm || a.createdAt - b.createdAt
  })

  const items: TimelineItem[] = []
  const untimed: TimelineItem[] = []

  for (const trip of sorted) {
    const ordered = orderEvents(trip, byTrip.get(trip.id) ?? [])
    const b = parseHm(trip.boardTime)
    const a = parseHm(trip.alightTime)
    const isRide = trip.kind === 'ride'
    const base = {
      id: trip.id,
      trip,
      events: ordered,
      isRide,
      line: lineOf(trip),
      segments: [] as SeatSegment[],
      ticks: [] as SeatTick[],
      crossesMidnight: false,
      durationMin: null as number | null,
      notes: [] as string[],
    }

    if (!isRide) {
      // 놓침·관찰: 탑승 구간이 아니므로 시각이 있으면 표시만 하고, 어떤 탑승 통계에도 넣지 않는다
      if (b === null) {
        untimed.push({ ...base, kind: 'skipped', start: 0, end: 0, group: '비탑승', notes: ['시각 미기록'] })
      } else {
        items.push({ ...base, kind: 'skipped', start: b, end: b, group: '비탑승' })
      }
      continue
    }

    if (trip.ongoing && b !== null && opts.nowMinute !== null) {
      const now = opts.nowMinute >= b ? opts.nowMinute : opts.nowMinute + DAY
      const seg = seatSegments(trip, ordered, b, now, true)
      items.push({
        ...base,
        kind: 'ongoing',
        start: b,
        end: now,
        group: base.line,
        segments: seg.segments,
        ticks: seg.ticks,
        notes: ['탑승 중 — 현재 시각까지는 잠정 구간입니다', ...seg.notes],
        crossesMidnight: now > DAY,
      })
      continue
    }

    if (b !== null && a !== null) {
      if (a === b) {
        items.push({ ...base, kind: 'point-same', start: b, end: b, group: base.line, durationMin: 0, notes: ['승차·하차 시각이 같아 구간 없이 한 점으로 표시합니다 (0분)'] })
        continue
      }
      const end = a > b ? a : a + DAY
      const seg = seatSegments(trip, ordered, b, end)
      const crosses = end > DAY
      items.push({
        ...base,
        kind: 'span',
        start: b,
        end,
        group: base.line,
        segments: seg.segments,
        ticks: seg.ticks,
        crossesMidnight: crosses,
        durationMin: end - b,
        notes: [...(crosses ? ['자정을 넘겨 다음 날에 하차했습니다'] : []), ...seg.notes],
      })
      continue
    }

    if (b !== null) {
      items.push({
        ...base,
        kind: 'point-board',
        start: b,
        end: b,
        group: base.line,
        notes: [trip.ongoing ? '탑승 중으로 기록된 이전 날짜의 탑승입니다 — 하차 미기록' : '하차 미기록'],
      })
      continue
    }
    if (a !== null) {
      items.push({ ...base, kind: 'point-alight', start: a, end: a, group: base.line, notes: ['승차 미기록'] })
      continue
    }
    const notes = ['시각 미기록']
    if (trip.reportedDurationMin !== null) notes.push(`원문에 소요 시간 ${trip.reportedDurationMin}분만 적혀 있습니다 (시각은 추정하지 않음)`)
    untimed.push({ ...base, kind: 'span', start: 0, end: 0, group: base.line, notes })
  }

  const maxEnd = items.reduce((m, i) => Math.max(m, i.end), DAY)
  const axisEnd = maxEnd > DAY ? Math.ceil(maxEnd / 60) * 60 : DAY
  let focus: TimelineModel['focus'] = null
  if (items.length > 0) {
    const lo = Math.min(...items.map((i) => i.start))
    const hi = Math.max(...items.map((i) => i.end))
    const start = Math.max(0, Math.floor((lo - 30) / 30) * 30)
    const end = Math.min(axisEnd, Math.max(start + 60, Math.ceil((hi + 30) / 30) * 30))
    focus = { start, end }
  }
  return { items, untimed, axisEnd, focus }
}

// ── 하루 요약 ────────────────────────────────────────────

export interface DaySummary {
  /** 실제 탑승 횟수 (놓침·관찰 제외) */
  rides: number
  subway: number
  bus: number
  /** 승·하차 시각이 모두 있어 소요 시간을 아는 탑승 수와 그 합계(분) */
  ridesWithDuration: number
  durationSum: number
  /** 구간 시각이 있는 탑승(확정 구간) 중 좌석 상태가 판정된/미확인 분 */
  standingMin: number
  seatedMin: number
  unknownMin: number
  /** 구간 시각이 있는 탑승 수와, 그중 모든 구간이 판정된 탑승 수 */
  spanRides: number
  fullyKnownRides: number
  /** 탑승 시 좌석이 기록된 탑승 수와 그중 앉아서 탑승한 수 (최초 착석) */
  initialKnown: number
  initialSeated: number
  /** 중간 착석(이미 앉아 있던 것이 아닌 상태에서의 착석 이벤트) 횟수와 그런 탑승 수 */
  midSeatEvents: number
  ridesWithMidSeat: number
  nonRide: number
  untimed: number
}

/** 이 이벤트들 중 '중간 착석'(앉아 있지 않은 상태에서 앉음) 횟수 */
export function countMidSeats(trip: Pick<Trip, 'boardTime' | 'initialSeat'>, ordered: SeatEvent[]): number {
  let cur: SeatState | null = trip.initialSeat
  let n = 0
  for (const e of ordered) {
    if (e.state === 'seated' && cur !== 'seated') n++
    cur = e.state
  }
  return n
}

export function summarizeDay(model: TimelineModel): DaySummary {
  const s: DaySummary = {
    rides: 0,
    subway: 0,
    bus: 0,
    ridesWithDuration: 0,
    durationSum: 0,
    standingMin: 0,
    seatedMin: 0,
    unknownMin: 0,
    spanRides: 0,
    fullyKnownRides: 0,
    initialKnown: 0,
    initialSeated: 0,
    midSeatEvents: 0,
    ridesWithMidSeat: 0,
    nonRide: 0,
    untimed: model.untimed.length,
  }
  for (const it of [...model.items, ...model.untimed]) {
    if (!it.isRide) {
      s.nonRide++
      continue
    }
    s.rides++
    if (it.trip.mode === 'subway') s.subway++
    else s.bus++
    if (it.trip.initialSeat !== null) {
      s.initialKnown++
      if (it.trip.initialSeat === 'seated') s.initialSeated++
    }
    const mid = countMidSeats(it.trip, it.events)
    s.midSeatEvents += mid
    if (mid > 0) s.ridesWithMidSeat++
    if (it.kind === 'span' && it.durationMin !== null) {
      s.ridesWithDuration++
      s.durationSum += it.durationMin
      s.spanRides++
      let allKnown = true
      for (const g of it.segments) {
        const len = g.end - g.start
        if (g.state === 'standing') s.standingMin += len
        else if (g.state === 'seated') s.seatedMin += len
        else {
          s.unknownMin += len
          allKnown = false
        }
      }
      if (allKnown && it.segments.length > 0) s.fullyKnownRides++
    } else if (it.kind === 'point-same') {
      s.ridesWithDuration++
    }
  }
  return s
}

// ── 상세 설명 ────────────────────────────────────────────

const hm = (m: number) => {
  const t = ((m % DAY) + DAY) % DAY
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}
const STATE_TEXT: Record<SeatSegState, string> = { standing: '서서 이동', seated: '앉아서 이동', unknown: '좌석 미확인' }

/** 막대를 눌렀을 때 보여 줄 설명 (시간, 노선, 승하차역, 좌석 상태) */
export function describeItem(it: TimelineItem): { title: string; rows: Array<[string, string]>; segments: string[]; notes: string[] } {
  const t = it.trip
  const rows: Array<[string, string]> = []
  const times =
    it.kind === 'span'
      ? `${t.boardTime} → ${t.alightTime}${it.crossesMidnight ? ' (다음 날)' : ''}`
      : it.kind === 'ongoing'
        ? `${t.boardTime} → 진행 중`
        : it.kind === 'point-alight'
          ? `승차 미기록 → ${t.alightTime}`
          : it.kind === 'point-same'
            ? `${t.boardTime} (승·하차 동일)`
            : `${t.boardTime ?? '--:--'}${it.isRide ? ' → 하차 미기록' : ''}`
  rows.push(['시각', times])
  if (it.durationMin !== null) rows.push(['탑승 시간', formatDuration(it.durationMin)])
  if (t.boardPlace || t.alightPlace) rows.push(['승·하차', `${t.boardPlace ?? '미기록'} → ${t.alightPlace ?? '미기록'}`])
  if (t.trainOrigin || t.trainDestination) rows.push(['열차 운행', [t.trainOrigin, t.trainDestination].filter(Boolean).join(' → ')])
  if (it.isRide) {
    const cur = currentSeat(t, it.events)
    rows.push(['탑승 시 좌석', t.initialSeat === null ? '미기록' : t.initialSeat === 'seated' ? '앉아서' : '서서'])
    if (it.kind === 'ongoing') rows.push(['현재 좌석', cur === null ? '미기록' : cur === 'seated' ? '앉아 있음' : '서 있음'])
  }
  const segments = it.segments.map((g) => `${hm(g.start)}–${hm(g.end)} ${STATE_TEXT[g.state]}${g.provisional ? ' (잠정)' : ''} · ${formatDuration(g.end - g.start)}`)
  const title = `${it.line}${it.isRide ? '' : ' (탑승하지 않음)'}`
  return { title, rows, segments, notes: it.notes }
}
