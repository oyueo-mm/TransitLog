import type { Mode } from './types'

/**
 * 노선 색상. 공개된 서울 지하철 노선 색을 쓰고, 목록에 없는 노선·버스는 이름으로 고른 팔레트 색을 쓴다.
 * 색은 '노선'을 구분하는 용도이고, 좌석 상태는 색이 아니라 채움·줄무늬·점선 패턴으로 구분한다.
 */
const KNOWN: Record<string, string> = {
  '1호선': '#0052A4',
  '2호선': '#00842F',
  '3호선': '#C25A00',
  '4호선': '#007CAE',
  '5호선': '#8250A0',
  '6호선': '#A8610F',
  '7호선': '#5F6700',
  '8호선': '#D0124F',
  '9호선': '#7A6E4F',
  수인분당선: '#B07A00',
  분당선: '#B07A00',
  신분당선: '#B8002F',
  공항철도: '#0079B8',
  경춘선: '#0B7A5B',
  경강선: '#0A5EA8',
}
const BUS_PALETTE = ['#B33A3A', '#8E3FB5', '#1F7A8C', '#A05A00', '#4F6D1D', '#9A3B6B']
const SUBWAY_PALETTE = ['#3D5A99', '#6B4E9B', '#2C7A6B', '#9A5B2A', '#7A3E5B']

function hash(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

export function lineColor(line: string | null, mode: Mode): string {
  if (line && KNOWN[line]) return KNOWN[line]
  if (!line) return mode === 'bus' ? '#8A5A5A' : '#5B6577'
  const pal = mode === 'bus' ? BUS_PALETTE : SUBWAY_PALETTE
  return pal[hash(line) % pal.length]
}

/** SVG id 에 쓸 수 있는 안전한 키 */
export function colorKey(color: string): string {
  return color.replace('#', 'c')
}
