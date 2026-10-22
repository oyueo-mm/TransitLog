import { describe, expect, it } from 'vitest'
import { rankedValues, suggestBoardFromPrevAlight, suggestPositions, suggestRoutes } from '../src/domain/recommend'
import { mkTrip } from './helpers'

// 2026-03-02 는 월요일
const MON_8 = new Date(2026, 2, 9, 8, 5) // 2026-03-09 월요일 08:05
const ctx = { now: MON_8, nowHm: '08:05' }

describe('추천', () => {
  const mondayMorning = (n: number) =>
    Array.from({ length: n }, () =>
      mkTrip({ date: '2026-03-02', boardTime: '08:00', line: '1호선', boardPlace: '가역', trainDestination: '라', car: 7, door: 2, side: 'left' }),
    )
  const fridayEvening = (n: number) =>
    Array.from({ length: n }, () =>
      mkTrip({ date: '2026-03-06', boardTime: '18:30', line: '2호선', boardPlace: '나역', trainDestination: '마', car: 1, door: 1, side: 'right' }),
    )

  it('같은 요일·시간대에 자주 탄 경로를 우선', () => {
    const s = suggestRoutes([...fridayEvening(4), ...mondayMorning(3)], [], ctx)
    expect(s[0].fields.line).toBe('1호선')
    expect(s[0].reasons).toContain('같은 요일·시간대')
  })

  it('추천 값에는 좌석 상태·혼잡도 같은 관측값이 들어 있지 않다', () => {
    const trips = mondayMorning(3).map((t) => ({ ...t, initialSeat: 'seated' as const, crowding: 'free' as const, waitOrder: 1 }))
    const s = suggestRoutes(trips, [], ctx)
    const keys = Object.keys(s[0].fields)
    expect(keys).not.toContain('initialSeat')
    expect(keys).not.toContain('crowding')
    expect(keys).not.toContain('waitOrder')
  })

  it('탑승하지 않은 기록은 추천 근거에서 제외', () => {
    const s = suggestRoutes([mkTrip({ kind: 'missed', line: '9호선', boardPlace: '가역' })], [], ctx)
    expect(s).toHaveLength(0)
  })

  it('직전 하차역을 다음 승차역으로 추천 (오늘, 3시간 이내만)', () => {
    const t = mkTrip({ date: '2026-03-09', alightPlace: '나역', alightTime: '07:50' })
    expect(suggestBoardFromPrevAlight([t], '2026-03-09', '08:05')).toBe('나역')
    expect(suggestBoardFromPrevAlight([t], '2026-03-09', '12:00')).toBeNull()
    expect(suggestBoardFromPrevAlight([t], '2026-03-10', '08:05')).toBeNull()
  })

  it('자주 탄 위치와 최근 사용 값 순위', () => {
    const trips = [...mondayMorning(3), ...fridayEvening(1)]
    expect(suggestPositions(trips, '1호선', '가역')[0]).toMatchObject({ car: 7, door: 2, side: 'left', count: 3 })
    expect(rankedValues(trips, (t) => t.line)[0]).toEqual({ value: '1호선', count: 3 })
  })
})
