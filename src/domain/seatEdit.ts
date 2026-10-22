import type { SeatEventDraft } from './types'

/**
 * 좌석 변화 이벤트 편집 도우미.
 * '중간에 앉음' 입력은 항상 *첫 번째 착석 이벤트 하나*를 만들거나 고친다. 같은 버튼을 여러 번 눌러도 이벤트가 늘어나지 않고,
 * 여러 번 바뀌는 경우는 '좌석 변화 추가'로 따로 더한다.
 */
export function findFirstSeated(events: SeatEventDraft[]): number {
  return events.findIndex((e) => e.state === 'seated')
}

export function upsertFirstSeated(events: SeatEventDraft[], patch: Partial<SeatEventDraft> = {}): SeatEventDraft[] {
  const i = findFirstSeated(events)
  if (i < 0) return [...events, { time: null, place: null, note: null, ...patch, state: 'seated' as const }]
  return events.map((e, j) => (j === i ? { ...e, ...patch, state: 'seated' as const } : e))
}

export function removeFirstSeated(events: SeatEventDraft[]): SeatEventDraft[] {
  const i = findFirstSeated(events)
  return i < 0 ? events : events.filter((_, j) => j !== i)
}

const sig = (e: SeatEventDraft) => [e.time ?? '', e.state, e.place ?? '', e.note ?? ''].join('|')

/** 시각·상태·장소·비고가 모두 같은 이벤트는 하나로 합친다 (중복 생성 방지) */
export function dedupeEvents(events: SeatEventDraft[]): SeatEventDraft[] {
  const seen = new Set<string>()
  const out: SeatEventDraft[] = []
  for (const e of events) {
    const k = sig(e)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

/** 빈 문자열은 미기록(null)으로 */
export function cleanEvent(e: SeatEventDraft): SeatEventDraft {
  const t = (s: string | null | undefined) => {
    const v = s?.trim()
    return v ? v : null
  }
  return { ...e, time: e.time || null, place: t(e.place), note: t(e.note) }
}
