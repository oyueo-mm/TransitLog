import { describe, expect, it } from 'vitest'
import {
  EMPTY_FILTERS,
  activeFilterCount,
  groupByDate,
  inTimeRange,
  normalizeFilters,
  resolveDateRange,
  search,
  sortMatches,
  suggestionsFrom,
  toRecords,
  type SearchFilters,
} from '../src/domain/search'
import { averageDuration, rideRows, seatRatios } from '../src/domain/stats'
import type { SeatEvent, Trip } from '../src/domain/types'
import { mkEvent, mkTrip } from './helpers'

const F = (p: Partial<SearchFilters> = {}): SearchFilters => ({ ...EMPTY_FILTERS, ...p })
const TODAY = '2026-03-04' // 수요일

// 가상 데이터 (실제 기록이 아님)
const a = mkTrip({ date: '2026-03-02', line: '1호선', boardPlace: '가가역', alightPlace: '나나역', boardTime: '08:24', alightTime: '09:20', initialSeat: 'standing', seatLogComplete: true, car: 10, door: 3, side: 'left', waitOrder: 2, trainDestination: '다다행', crowding: 'crowded' })
const aEv = mkEvent(a.id, { time: '08:30', state: 'seated', place: '라라역', note: '자리 남' })
const b = mkTrip({ date: '2026-03-02', line: '2호선', boardPlace: '가가', alightPlace: '마마역', boardTime: '12:00', alightTime: '12:30', initialSeat: 'seated', crowding: 'free' })
const c = mkTrip({ date: '2026-03-03', line: '1호선', boardPlace: '나나역', alightPlace: '가가역', boardTime: '18:00', alightTime: '18:40', initialSeat: 'standing', seatLogComplete: true, delayMinutes: 5, incident: '신호 대기', car: 3, door: 1 })
const d = mkTrip({ date: '2026-03-04', line: '수인분당선', boardPlace: '바바역', boardTime: '07:30', note: '메모만 있음' })
const e = mkTrip({ date: '2026-03-04', kind: 'missed', line: '1호선', boardPlace: '가가역', boardTime: '07:50' })
const trips: Trip[] = [a, b, c, d, e]
const events: SeatEvent[] = [aEv]
const recs = toRecords(trips, events)
const ids = (f: SearchFilters) => search(recs, f, TODAY).map((m) => m.rec.trip.id)

describe('키워드 검색', () => {
  it('공백·대소문자를 무시하고 여러 키워드는 모두 맞아야 한다', () => {
    expect(ids(F({ q: '1 호 선' }))).toEqual([a.id, c.id, e.id])
    expect(ids(F({ q: '1호선 가가역' }))).toEqual([a.id, c.id, e.id])
    expect(ids(F({ q: '1호선 나나역' }))).toEqual([a.id, c.id])
  })

  it('역 이름 정규화: 가가 = 가가역 (저장된 표기와 달라도 같은 역으로 본다)', () => {
    expect(ids(F({ q: '가가' })).sort()).toEqual([a.id, b.id, c.id, e.id].sort())
    expect(ids(F({ q: '가가역' })).sort()).toEqual([a.id, b.id, c.id, e.id].sort())
    // 저장값이 '가가'(역 없음)인 b 도 '가가역' 검색에 걸린다
    expect(ids(F({ q: '가가역' }))).toContain(b.id)
  })

  it('동의어: 앉음/착석/앉아서, 서서/기립', () => {
    // a: 중간 착석 이벤트, b: 앉아서 탑승
    expect(ids(F({ q: '착석' })).sort()).toEqual([a.id, b.id].sort())
    expect(ids(F({ q: '앉음' })).sort()).toEqual([a.id, b.id].sort())
    expect(ids(F({ q: '기립' })).sort()).toEqual([a.id, c.id].sort())
    expect(ids(F({ q: '서서' })).sort()).toEqual([a.id, c.id].sort())
  })

  it('좌석 이벤트의 역·메모도 검색된다', () => {
    expect(ids(F({ q: '라라역' }))).toEqual([a.id])
    expect(ids(F({ q: '자리' }))).toEqual([a.id])
    expect(ids(F({ q: '08:30' }))).toEqual([a.id])
  })

  it('칸-문 토큰(10-3), 칸, 문, 번째', () => {
    expect(ids(F({ q: '10-3' }))).toEqual([a.id])
    expect(ids(F({ q: '3-1' }))).toEqual([c.id])
    expect(ids(F({ q: '10칸' }))).toEqual([a.id])
    expect(ids(F({ q: '2번째' }))).toEqual([a.id])
    // 날짜 문자열과 헷갈리지 않는다 (2026-03-02 에 '03-02' 가 들어 있어도 칸-문으로만 해석)
    expect(ids(F({ q: '03-02' }))).toEqual([])
  })

  it('날짜·요일·월일 표기', () => {
    expect(ids(F({ q: '2026-03-03' }))).toEqual([c.id])
    expect(ids(F({ q: '3월2일' })).sort()).toEqual([a.id, b.id].sort())
    expect(ids(F({ q: '화요일' }))).toEqual([c.id])
  })

  it('지연·사건·행선지(행 유무)·혼잡', () => {
    expect(ids(F({ q: '지연' }))).toEqual([c.id])
    expect(ids(F({ q: '5분' }))).toEqual([c.id])
    expect(ids(F({ q: '신호' }))).toEqual([c.id])
    expect(ids(F({ q: '다다행' }))).toEqual([a.id])
    expect(ids(F({ q: '다다' }))).toEqual([a.id])
    expect(ids(F({ q: '혼잡' }))).toEqual([a.id])
  })

  it('기록되지 않은 값을 추정해 맞추지 않는다', () => {
    // d 는 좌석을 기록하지 않았다 → 어떤 좌석 단어에도 맞지 않는다
    expect(ids(F({ q: '메모만' }))).toEqual([d.id])
    expect(ids(F({ q: '서서 메모만' }))).toEqual([])
    expect(ids(F({ q: '앉음 메모만' }))).toEqual([])
    // 지연을 기록하지 않은 기록은 '지연없음'에도 맞지 않는다
    expect(ids(F({ q: '지연없음' }))).toEqual([])
  })
})

describe('조건 필터', () => {
  it('노선·역은 복수 선택(OR)이고 조건 사이는 AND', () => {
    expect(ids(F({ lines: ['1호선', '2호선'] })).sort()).toEqual([a.id, b.id, c.id, e.id].sort())
    expect(ids(F({ lines: ['1호선'], boardStations: ['가가'] }))).toEqual([a.id, e.id])
    expect(ids(F({ lines: ['1호선'], boardStations: ['가가역'], kinds: ['ride'] }))).toEqual([a.id])
  })

  it('복합 예: 1호선 + 07:00~09:00 승차 + 가가역 승차 + 서서 탑승 + 중간 착석', () => {
    const f = F({ lines: ['1호선'], boardFrom: '07:00', boardTo: '09:00', boardStations: ['가가역'], seatInitial: ['standing'], seatChange: ['midSeat'] })
    expect(ids(f)).toEqual([a.id])
    expect(ids({ ...f, boardTo: '08:00' })).toEqual([])
    expect(ids({ ...f, lines: ['2호선'] })).toEqual([])
  })

  it('시각 범위: 자정을 넘는 범위와 시각 없는 기록', () => {
    expect(inTimeRange('23:30', '22:00', '02:00')).toBe(true)
    expect(inTimeRange('01:00', '22:00', '02:00')).toBe(true)
    expect(inTimeRange('12:00', '22:00', '02:00')).toBe(false)
    expect(inTimeRange(null, '00:00', '23:59')).toBe(false)
    expect(inTimeRange('10:00', '09:00', null)).toBe(true)
    // 승차 시각이 없는 기록은 승차 시각 조건에서 빠진다
    const x = mkTrip({ date: '2026-03-04', alightTime: '10:00' })
    const r = toRecords([x], [])
    expect(search(r, F({ boardFrom: '00:00', boardTo: '23:59' }), TODAY)).toHaveLength(0)
    expect(search(r, F({ alightFrom: '09:00', alightTo: '11:00' }), TODAY)).toHaveLength(1)
  })

  it('소요 시간 범위: 시간을 모르는 기록은 제외', () => {
    expect(ids(F({ durMin: 40 }))).toEqual([a.id, c.id])
    expect(ids(F({ durMin: 40, durMax: 50 }))).toEqual([c.id])
    expect(ids(F({ durMax: 30 }))).toEqual([b.id])
  })

  it('좌석 조건: 처음부터 앉아서 / 서서 / 중간 착석 / 끝까지 서 있었음 / 최종 / 미확인', () => {
    expect(ids(F({ seatInitial: ['seated'] }))).toEqual([b.id])
    expect(ids(F({ seatInitial: ['standing'] })).sort()).toEqual([a.id, c.id].sort())
    expect(ids(F({ seatInitial: ['unrecorded'] }))).toEqual([d.id])
    expect(ids(F({ seatChange: ['midSeat'] }))).toEqual([a.id])
    // c: 서서 탔고 완결 확인 + 앉은 기록 없음 → 끝까지 서 있었음
    expect(ids(F({ seatChange: ['stoodAll'] }))).toEqual([c.id])
    expect(ids(F({ seatFinal: ['seated'] }))).toEqual([a.id])
    expect(ids(F({ seatFinal: ['standing'] }))).toEqual([c.id])
    // 최종 상태 미확인: 완결 확인이 없는 b, d
    expect(ids(F({ seatFinal: ['unknown'] })).sort()).toEqual([b.id, d.id].sort())
    // 비탑승은 좌석 조건에 걸리지 않는다
    expect(ids(F({ seatFinal: ['unknown', 'seated', 'standing'] }))).not.toContain(e.id)
  })

  it('위치·혼잡·지연', () => {
    expect(ids(F({ cars: [10] }))).toEqual([a.id])
    expect(ids(F({ doors: [3, 1] })).sort()).toEqual([a.id, c.id].sort())
    expect(ids(F({ sides: ['left'] }))).toEqual([a.id])
    expect(ids(F({ waitOrders: [2] }))).toEqual([a.id])
    expect(ids(F({ crowding: ['free', 'crowded'] })).sort()).toEqual([a.id, b.id].sort())
    expect(ids(F({ delay: ['yes'] }))).toEqual([c.id])
    expect(ids(F({ delay: ['no'] }))).toEqual([])
    expect(ids(F({ delay: ['unrecorded'] })).sort()).toEqual([a.id, b.id, d.id, e.id].sort())
  })

  it('기간: 빠른 선택(오늘/이번 주/이번 달)과 직접 지정, 요일', () => {
    expect(resolveDateRange(F({ quick: 'week' }), TODAY)).toEqual({ from: '2026-03-02', to: '2026-03-08' })
    expect(ids(F({ quick: 'today' })).sort()).toEqual([d.id, e.id].sort())
    expect(ids(F({ quick: 'week' })).length).toBe(5)
    expect(ids(F({ quick: 'custom', dateFrom: '2026-03-03', dateTo: '2026-03-03' }))).toEqual([c.id])
    expect(ids(F({ weekdays: [1] })).sort()).toEqual([a.id, b.id].sort()) // 월요일
  })

  it('조건 수 세기·초기화 값·손상된 저장값 복구', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0)
    expect(activeFilterCount(F({ q: 'x', lines: ['1호선'], boardFrom: '07:00' }))).toBe(3)
    expect(normalizeFilters(null)).toEqual(EMPTY_FILTERS)
    expect(normalizeFilters({ lines: 'oops', q: 3, quick: 'zzz', cars: [1, 'x', {}] }).lines).toEqual([])
    expect(normalizeFilters({ quick: 'zzz' }).quick).toBe('all')
  })
})

describe('정렬·묶기', () => {
  it('최신순/오래된순, 같은 날짜 안은 승차 시각순', () => {
    const newest = sortMatches(search(recs, F(), TODAY), 'newest').map((m) => m.rec.trip.id)
    expect(newest).toEqual([d.id, e.id, c.id, a.id, b.id]) // 03-04 안에서는 07:30(d) → 07:50(e)
    const oldest = sortMatches(search(recs, F(), TODAY), 'oldest').map((m) => m.rec.trip.id)
    expect(oldest).toEqual([a.id, b.id, c.id, d.id, e.id])
  })
  it('소요 시간순: 시간을 모르는 기록은 항상 뒤', () => {
    const asc = sortMatches(search(recs, F(), TODAY), 'durationAsc').map((m) => m.rec.trip.id)
    expect(asc.slice(0, 3)).toEqual([b.id, c.id, a.id])
    expect(new Set(asc.slice(3))).toEqual(new Set([d.id, e.id]))
    const desc = sortMatches(search(recs, F(), TODAY), 'durationDesc').map((m) => m.rec.trip.id)
    expect(desc.slice(0, 3)).toEqual([a.id, c.id, b.id])
    expect(new Set(desc.slice(3))).toEqual(new Set([d.id, e.id]))
  })
  it('날짜별 묶음', () => {
    const g = groupByDate(sortMatches(search(recs, F(), TODAY), 'newest'))
    expect(g.map(([date, list]) => [date, list.length])).toEqual([['2026-03-04', 2], ['2026-03-03', 1], ['2026-03-02', 2]])
  })
})

describe('결과 통계와 통계 화면의 일관성', () => {
  it('조건이 없으면 검색 결과의 통계는 전체 통계와 같고, 조건이 있으면 결과 기록만으로 같은 함수를 쓴다', () => {
    const all = rideRows(trips, events)
    const matchedAll = rideRows(search(recs, F(), TODAY).map((m) => m.rec.trip), events)
    expect(seatRatios(matchedAll)).toEqual(seatRatios(all))
    expect(averageDuration(matchedAll)).toEqual(averageDuration(all))
    const only1 = search(recs, F({ lines: ['1호선'] }), TODAY).map((m) => m.rec.trip)
    const rows = rideRows(only1, events)
    expect(rows).toHaveLength(2) // 놓침(e)은 탑승 통계에서 제외
    expect(seatRatios(rows).immediate).toEqual({ num: 0, den: 2, pct: 0 })
    expect(seatRatios(rows).everSeated.den).toBe(2)
  })
})

describe('자동 완성 후보', () => {
  it('저장된 값만, 많이 쓴 순이고 같은 역의 표기 차이를 합친다', () => {
    const s = suggestionsFrom(['가가역', '가가', '가가역', '나나역', null, '', '  '])
    expect(s).toEqual(['가가역', '나나역'])
  })
})
