const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** 'HH:mm' → 하루 중 분(0~1439). 형식이 아니면 null */
export function parseHm(s: string | null | undefined): number | null {
  if (!s) return null
  const m = HM.exec(s.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export function formatHm(totalMinutes: number): string {
  const m = ((Math.round(totalMinutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 'H:mm' / 'HH:mm' → 'HH:mm'. 아니면 null */
export function normalizeHm(s: string | null | undefined): string | null {
  const v = parseHm(s)
  return v === null ? null : formatHm(v)
}

/**
 * from → to 사이의 분. 자정을 넘기면(to < from) 다음 날로 본다.
 * 둘 중 하나라도 없으면 null (추정하지 않는다).
 */
export function diffMinutes(from: string | null, to: string | null): number | null {
  const a = parseHm(from)
  const b = parseHm(to)
  if (a === null || b === null) return null
  return (b - a + 1440) % 1440
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function todayStr(): string {
  return dateStr(new Date())
}

export function nowHm(): string {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s)
  d.setDate(d.getDate() + n)
  return dateStr(d)
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
export function weekdayIndex(s: string): number {
  return parseDate(s).getDay()
}
export function weekdayKo(s: string): string {
  return WEEKDAYS[weekdayIndex(s)]
}
export const WEEKDAY_NAMES = WEEKDAYS

export function isValidDate(y: number, m: number, d: number): boolean {
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

export function formatDuration(min: number | null): string {
  if (min === null) return '—'
  if (min < 60) return `${min}분`
  const h = Math.floor(min / 60)
  const r = min % 60
  return r ? `${h}시간 ${r}분` : `${h}시간`
}

export function monthKey(date: string): string {
  return date.slice(0, 7)
}

/** 월요일 시작 주의 첫 날짜 */
export function weekStart(date: string): string {
  const idx = (weekdayIndex(date) + 6) % 7
  return addDays(date, -idx)
}

export function hourBucket(time: string | null): string | null {
  const m = parseHm(time)
  if (m === null) return null
  const h = Math.floor(m / 60)
  if (h < 6) return '새벽 (~06시)'
  if (h < 9) return '출근·등교 (06~09시)'
  if (h < 12) return '오전 (09~12시)'
  if (h < 15) return '낮 (12~15시)'
  if (h < 18) return '오후 (15~18시)'
  if (h < 21) return '저녁 (18~21시)'
  return '밤 (21시~)'
}
export const HOUR_BUCKETS = [
  '새벽 (~06시)',
  '출근·등교 (06~09시)',
  '오전 (09~12시)',
  '낮 (12~15시)',
  '오후 (15~18시)',
  '저녁 (18~21시)',
  '밤 (21시~)',
]
