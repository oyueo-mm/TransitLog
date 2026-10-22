/**
 * 노선별 프리셋(자주 쓰는 역·열차 운행 출발지/종착역)과 이름 정규화.
 *
 * 이 값은 '추천 목록의 기본 순서'일 뿐이다. 선택하기 전에는 기록에 들어가지 않고,
 * 목록에 없는 역·노선도 언제든 직접 입력할 수 있다. 사용자가 바꾸고 싶으면 이 파일의 표만 고치면 된다.
 */
export interface LinePreset {
  line: string
  /** 승차역·하차역 추천 순서 */
  stations: string[]
  /** 열차 운행 출발지·종착역 추천 순서 (역 접미사 없이 쓴다) */
  ends: string[]
  /** 대표적인 운행 조합 [출발지, 종착역] */
  pairs: Array<[string, string]>
}

export const LINE_PRESETS: LinePreset[] = [
  {
    line: '수인분당선',
    stations: ['오목천역', '수원역', '고색역'],
    ends: ['인천', '왕십리'],
    pairs: [
      ['인천', '왕십리'],
      ['왕십리', '인천'],
    ],
  },
  {
    line: '1호선',
    stations: ['수원역', '신도림역', '구로역'],
    ends: ['서동탄', '천안', '신창', '청량리', '구로'],
    pairs: [],
  },
  {
    line: '2호선',
    stations: ['신도림역', '홍대입구역', '합정역'],
    ends: ['성수', '신도림', '까치산'],
    pairs: [],
  },
]

export const PRESET_LINES = LINE_PRESETS.map((p) => p.line)

export function presetFor(line: string | null | undefined): LinePreset | undefined {
  return LINE_PRESETS.find((p) => p.line === line)
}

/**
 * 같은 역을 같게 보기 위한 비교 키. 공백을 없애고 끝의 '역'을 뗀다 ('수원역' = '수원' = ' 수원 역').
 * 저장하는 값은 바꾸지 않고, 추천·중복 판단 때만 쓴다.
 */
export function stationKey(name: string | null | undefined): string {
  const s = (name ?? '').normalize('NFC').replace(/\s+/g, '')
  return s.length > 2 && s.endsWith('역') ? s.slice(0, -1) : s
}

export function sameStation(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = stationKey(a)
  return ka !== '' && ka === stationKey(b)
}

/**
 * 직접 입력한 이름을 이미 쓰는 표기로 맞춘다. 알려진 표기가 없으면 입력한 그대로(앞뒤 공백만 정리) 둔다.
 * 예: '수원' → 알려진 목록에 '수원역'이 있으면 '수원역'
 */
export function canonicalName(input: string | null | undefined, known: string[]): string | null {
  const v = (input ?? '').normalize('NFC').trim()
  if (!v) return null
  const hit = known.find((k) => sameStation(k, v))
  return hit ?? v
}

/** '행'을 붙여 읽기 좋게 (이미 '행'이나 '방향'으로 끝나면 그대로) */
export function destLabel(d: string | null | undefined): string {
  if (!d) return ''
  return /(행|방향)$/.test(d) ? d : `${d}행`
}

/**
 * 열차 운행 구간 표시. 한쪽만 알아도 표시하고, 출발지와 종착역이 같아도(순환 운행) 그대로 보여 준다.
 *   서동탄 → 광운대행 / 성수 → 성수행 / 인천 출발 / 왕십리행
 */
export function formatTrainRoute(origin: string | null | undefined, destination: string | null | undefined): string | null {
  const o = origin?.trim() || null
  const d = destination?.trim() || null
  if (o && d) return `${o} → ${destLabel(d)}`
  if (o) return `${o} 출발`
  if (d) return destLabel(d)
  return null
}
