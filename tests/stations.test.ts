import { describe, expect, it } from 'vitest'
import { canonicalName, destLabel, formatTrainRoute, LINE_PRESETS, PRESET_LINES, presetFor, sameStation, stationKey } from '../src/domain/stations'
import {
  knownStations,
  knownTrainEnds,
  suggestSeatPlaces,
  suggestStations,
  suggestTrainEnds,
  suggestTrainPairs,
} from '../src/domain/suggest'
import { mkEvent, mkTrip } from './helpers'

const names = (l: Array<{ value: string }>) => l.map((x) => x.value)

describe('노선 프리셋', () => {
  it('노선 토글은 수인분당선, 1호선, 2호선 순서', () => {
    expect(PRESET_LINES).toEqual(['수인분당선', '1호선', '2호선'])
  })
  it('노선별 승·하차역 추천 순서', () => {
    expect(presetFor('수인분당선')!.stations).toEqual(['오목천역', '수원역', '고색역'])
    expect(presetFor('1호선')!.stations).toEqual(['수원역', '신도림역', '구로역'])
    expect(presetFor('2호선')!.stations).toEqual(['신도림역', '홍대입구역', '합정역'])
  })
  it('노선별 열차 운행 출발지·종착역 추천', () => {
    expect(presetFor('수인분당선')!.ends).toEqual(['인천', '왕십리'])
    expect(presetFor('수인분당선')!.pairs).toEqual([
      ['인천', '왕십리'],
      ['왕십리', '인천'],
    ])
    expect(presetFor('1호선')!.ends).toEqual(['서동탄', '천안', '신창', '청량리', '구로'])
    expect(presetFor('2호선')!.ends).toEqual(['성수', '신도림', '까치산'])
    expect(LINE_PRESETS).toHaveLength(3)
  })
  it('프리셋에 없는 노선은 프리셋이 없다', () => {
    expect(presetFor('가상선')).toBeUndefined()
    expect(presetFor(null)).toBeUndefined()
  })
})

describe('역 이름 일관성', () => {
  it('표기가 달라도 같은 역으로 본다', () => {
    expect(stationKey('수원역')).toBe(stationKey(' 수원 '))
    expect(sameStation('수원역', '수원')).toBe(true)
    expect(sameStation('수원역', '신도림역')).toBe(false)
    expect(sameStation(null, null)).toBe(false)
  })
  it('직접 입력한 이름은 이미 쓰는 표기로 맞추고, 모르는 이름은 그대로 둔다', () => {
    expect(canonicalName('수원', ['수원역', '구로역'])).toBe('수원역')
    expect(canonicalName('  성균관대역 ', ['수원역'])).toBe('성균관대역')
    expect(canonicalName('', ['수원역'])).toBeNull()
  })
  it('역 한 글자 이름은 접미사를 떼지 않는다', () => {
    expect(stationKey('역')).toBe('역')
  })
})

describe('열차 운행 구간 표시', () => {
  it('출발지 → 종착역행', () => {
    expect(formatTrainRoute('서동탄', '광운대')).toBe('서동탄 → 광운대행')
  })
  it('출발지와 종착역이 같은 순환 운행도 그대로 표시', () => {
    expect(formatTrainRoute('성수', '성수')).toBe('성수 → 성수행')
  })
  it('한쪽만 알아도 표시, 둘 다 없으면 null', () => {
    expect(formatTrainRoute('인천', null)).toBe('인천 출발')
    expect(formatTrainRoute(null, '왕십리')).toBe('왕십리행')
    expect(formatTrainRoute(null, null)).toBeNull()
    expect(formatTrainRoute('  ', '')).toBeNull()
  })
  it('이미 행/방향이 붙은 기존 값은 중복해서 붙이지 않는다', () => {
    expect(destLabel('광운대행')).toBe('광운대행')
    expect(destLabel('마마역 방향')).toBe('마마역 방향')
    expect(formatTrainRoute('서동탄', '마마역 방향')).toBe('서동탄 → 마마역 방향')
  })
})

describe('승차역·하차역 추천', () => {
  it('기록이 없으면 노선별 프리셋 순서', () => {
    expect(names(suggestStations([], { line: '수인분당선', role: 'board' }))).toEqual(['오목천역', '수원역', '고색역'])
    expect(names(suggestStations([], { line: '1호선', role: 'board' }))).toEqual(['수원역', '신도림역', '구로역'])
    expect(names(suggestStations([], { line: '2호선', role: 'alight' }))).toEqual(['신도림역', '홍대입구역', '합정역'])
  })
  it('노선을 바꾸면 추천이 그 노선 것으로 바뀐다 (다른 노선 기록은 섞이지 않는다)', () => {
    const trips = [mkTrip({ line: '2호선', boardPlace: '성수역' }), mkTrip({ line: '1호선', boardPlace: '병점역' })]
    expect(names(suggestStations(trips, { line: '1호선', role: 'board' }))).toEqual(['수원역', '신도림역', '구로역', '병점역'])
    expect(names(suggestStations(trips, { line: '2호선', role: 'board' }))).toEqual(['신도림역', '홍대입구역', '합정역', '성수역'])
  })
  it('프리셋 밖의 노선은 기록으로만 추천', () => {
    const trips = [mkTrip({ line: '가상선', boardPlace: '가가역' }), mkTrip({ line: '가상선', boardPlace: '가가역' }), mkTrip({ line: '가상선', boardPlace: '나나역' })]
    expect(names(suggestStations(trips, { line: '가상선', role: 'board' }))).toEqual(['가가역', '나나역'])
    expect(suggestStations([], { line: '가상선', role: 'board' })).toEqual([])
  })
  it('선택한 승차역에서 자주 내린 하차역을 먼저 추천', () => {
    const trips = [
      mkTrip({ line: '1호선', boardPlace: '수원역', alightPlace: '구로역' }),
      mkTrip({ line: '1호선', boardPlace: '수원역', alightPlace: '구로역' }),
      mkTrip({ line: '1호선', boardPlace: '수원역', alightPlace: '다다역' }),
      mkTrip({ line: '1호선', boardPlace: '신도림역', alightPlace: '수원역' }),
    ]
    const s = suggestStations(trips, { line: '1호선', role: 'alight', boardPlace: '수원역', exclude: '수원역' })
    expect(s[0]).toMatchObject({ value: '구로역', source: 'frequent', count: 2 })
    expect(names(s).slice(0, 3)).toEqual(['구로역', '다다역', '신도림역'])
    expect(names(s)).not.toContain('수원역') // 이미 고른 승차역은 하차역 추천에서 제외
  })
  it('표기가 달라도 같은 역은 한 번만, 가장 많이 쓴 표기로', () => {
    const trips = [
      mkTrip({ line: '1호선', boardPlace: '수원' }),
      mkTrip({ line: '1호선', boardPlace: '수원' }),
      mkTrip({ line: '1호선', boardPlace: '수원역' }),
    ]
    const s = suggestStations(trips, { line: '1호선', role: 'board' })
    expect(names(s).filter((n) => sameStation(n, '수원'))).toHaveLength(1)
  })
  it('탑승하지 않은 기록(놓침·관찰)은 추천 근거가 아니다', () => {
    const trips = [mkTrip({ kind: 'observed', line: '1호선', boardPlace: '병점역' })]
    expect(names(suggestStations(trips, { line: '1호선', role: 'board' }))).not.toContain('병점역')
  })
  it('버스는 프리셋 없이 기록으로만 추천', () => {
    const trips = [mkTrip({ mode: 'bus', line: '1234', boardPlace: '가정류장' })]
    expect(names(suggestStations(trips, { mode: 'bus', line: '1234', role: 'board' }))).toEqual(['가정류장'])
  })
})

describe('열차 운행 출발지·종착역 추천', () => {
  it('프리셋 다음에 기록의 값(광운대·병점·동묘앞 등)이 추천된다', () => {
    const trips = [
      mkTrip({ line: '1호선', trainOrigin: '서동탄', trainDestination: '광운대' }),
      mkTrip({ line: '1호선', trainOrigin: '서동탄', trainDestination: '광운대' }),
      mkTrip({ line: '1호선', trainOrigin: '병점', trainDestination: '동묘앞' }),
    ]
    const dest = suggestTrainEnds(trips, { line: '1호선', role: 'destination' })
    expect(names(dest).slice(0, 5)).toEqual(['서동탄', '천안', '신창', '청량리', '구로'])
    expect(names(dest).slice(5)).toEqual(['광운대', '동묘앞'])
    expect(names(dest)).toEqual(expect.arrayContaining(['광운대', '동묘앞']))
    const origin = suggestTrainEnds(trips, { line: '1호선', role: 'origin' })
    expect(names(origin)).toEqual(expect.arrayContaining(['서동탄', '병점']))
  })
  it('출발지와 종착역 추천은 서로 독립적이다', () => {
    const trips = [mkTrip({ line: '2호선', trainOrigin: '성수', trainDestination: '성수' })]
    expect(names(suggestTrainEnds(trips, { line: '2호선', role: 'origin' }))).toEqual(['성수', '신도림', '까치산'])
    expect(names(suggestTrainEnds(trips, { line: '2호선', role: 'destination' }))).toEqual(['성수', '신도림', '까치산'])
  })
  it('노선 변경 시 추천 목록이 바뀐다', () => {
    expect(names(suggestTrainEnds([], { line: '수인분당선', role: 'destination' }))).toEqual(['인천', '왕십리'])
    expect(names(suggestTrainEnds([], { line: '2호선', role: 'destination' }))).toEqual(['성수', '신도림', '까치산'])
  })
  it('자주 쓴 조합: 기록 → 수인분당선 대표 조합', () => {
    const trips = [
      mkTrip({ line: '1호선', boardPlace: '수원역', trainOrigin: '서동탄', trainDestination: '광운대' }),
      mkTrip({ line: '1호선', boardPlace: '수원역', trainOrigin: '서동탄', trainDestination: '광운대' }),
      mkTrip({ line: '1호선', boardPlace: '구로역', trainOrigin: '천안', trainDestination: '청량리' }),
    ]
    const p = suggestTrainPairs(trips, { line: '1호선', boardPlace: '구로역' })
    expect(p[0]).toMatchObject({ origin: '천안', destination: '청량리', source: 'frequent' }) // 승차역과 함께 쓴 조합 우선
    expect(p[1]).toMatchObject({ origin: '서동탄', destination: '광운대', count: 2 })
    const suin = suggestTrainPairs([], { line: '수인분당선' })
    expect(suin.map((x) => `${x.origin}>${x.destination}`)).toEqual(['인천>왕십리', '왕십리>인천'])
    expect(suin.every((x) => x.source === 'preset')).toBe(true)
    expect(suggestTrainPairs([], { line: '1호선' })).toEqual([])
  })
  it('한쪽만 기록된 구간도 조합에 포함', () => {
    const p = suggestTrainPairs([mkTrip({ line: '1호선', trainOrigin: null, trainDestination: '신창' })], { line: '1호선' })
    expect(p[0]).toMatchObject({ origin: null, destination: '신창' })
  })
})

describe('중간 착석 역 추천과 자동완성 후보', () => {
  it('노선 프리셋 역 + 기록(좌석 변화 장소 포함)', () => {
    const t = mkTrip({ line: '1호선', boardPlace: '수원역', alightPlace: '신도림역' })
    const ev = [mkEvent(t.id, { place: '성균관대역' }), mkEvent('다른탑승', { place: '남의역' })]
    const s = suggestSeatPlaces([t], ev, { line: '1호선' })
    expect(names(s).slice(0, 3)).toEqual(['수원역', '신도림역', '구로역'])
    expect(names(s)).toContain('성균관대역')
    expect(names(s)).not.toContain('남의역')
  })
  it('검색 후보에는 모든 프리셋 역과 기록의 역이 들어 있다', () => {
    const k = knownStations([mkTrip({ boardPlace: '가역', alightPlace: '수원' })], [{ place: '나역' }])
    expect(k).toEqual(expect.arrayContaining(['오목천역', '합정역', '가역', '나역']))
    expect(k.filter((x) => sameStation(x, '수원'))).toHaveLength(1)
    expect(knownTrainEnds([mkTrip({ trainOrigin: '다', trainDestination: '라' })])).toEqual(expect.arrayContaining(['인천', '성수', '다', '라']))
  })
})
