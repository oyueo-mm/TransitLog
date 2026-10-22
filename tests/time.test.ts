import { describe, expect, it } from 'vitest'
import { addDays, diffMinutes, formatHm, hourBucket, normalizeHm, parseHm, weekStart, weekdayKo } from '../src/domain/time'

describe('시간 계산', () => {
  it('HH:mm 을 분으로 바꾸고 형식이 아니면 null', () => {
    expect(parseHm('08:30')).toBe(510)
    expect(parseHm('8:05')).toBe(485)
    expect(parseHm('25:00')).toBeNull()
    expect(parseHm('08:3')).toBeNull()
    expect(parseHm(null)).toBeNull()
    expect(normalizeHm('8:05')).toBe('08:05')
  })
  it('같은 날 소요 시간', () => {
    expect(diffMinutes('08:24', '09:20')).toBe(56)
  })
  it('자정을 넘기는 이동은 다음 날로 계산', () => {
    expect(diffMinutes('23:50', '00:10')).toBe(20)
    expect(diffMinutes('23:59', '00:00')).toBe(1)
  })
  it('시각이 하나라도 없으면 추정하지 않고 null', () => {
    expect(diffMinutes('08:24', null)).toBeNull()
    expect(diffMinutes(null, '09:20')).toBeNull()
    expect(diffMinutes(null, null)).toBeNull()
  })
  it('분을 HH:mm 으로 되돌릴 때 하루를 순환', () => {
    expect(formatHm(1450)).toBe('00:10')
  })
  it('날짜 계산·요일·주 시작(월요일)', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(weekdayKo('2026-03-02')).toBe('월')
    expect(weekStart('2026-03-08')).toBe('2026-03-02')
    expect(weekStart('2026-03-02')).toBe('2026-03-02')
  })
  it('시간대 구간', () => {
    expect(hourBucket('08:10')).toBe('출근·등교 (06~09시)')
    expect(hourBucket(null)).toBeNull()
  })
})
