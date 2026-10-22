import type { TimelineItem, TimelineModel } from './timeline'

/**
 * 타임라인 그림의 좌표 계산 (순수 함수).
 * x 좌표는 '분 × pxPerMin', 막대 위치·길이는 실제 승·하차 시각에 정확히 비례한다.
 */
export const MIN_TOUCH = 44
/** 한 행(레인)의 높이: 막대 위 레이블 + 막대. 터치 영역을 충분히 확보한다 */
export const LANE_H = 52
export const AXIS_H = 30

export const xOf = (minute: number, pxPerMin: number) => minute * pxPerMin

/** 컨테이너 너비에 [start, end] 분 범위가 꼭 맞는 배율 */
export function fitScale(containerPx: number, start: number, end: number): number {
  const span = Math.max(1, end - start)
  return Math.max(0.05, containerPx / span)
}

/** 눈금 간격(분): 눈금 사이가 minGapPx 이상이 되는 가장 작은 값 */
export function tickStep(pxPerMin: number, minGapPx = 48): number {
  for (const step of [15, 30, 60, 120, 180, 360, 720]) if (step * pxPerMin >= minGapPx) return step
  return 720
}

export interface Tick {
  minute: number
  label: string
  major: boolean
}

export function ticksFor(axisEnd: number, pxPerMin: number): Tick[] {
  const step = tickStep(pxPerMin)
  const out: Tick[] = []
  for (let m = 0; m <= axisEnd; m += step) {
    const day = Math.floor(m / 1440)
    const t = m % 1440
    const hh = String(Math.floor(t / 60)).padStart(2, '0')
    const mm = String(t % 60).padStart(2, '0')
    const base = step < 60 ? `${hh}:${mm}` : `${hh}시`
    out.push({ minute: m, label: day > 0 ? `익일 ${base}` : base, major: t % 60 === 0 })
  }
  return out
}

export interface LayoutItem {
  item: TimelineItem
  lane: number
  /** 막대(또는 점)의 실제 그림 영역 */
  x: number
  w: number
  /** 터치 영역(이웃 막대와 겹치지 않게 잘린 값, 최소 MIN_TOUCH) */
  hitX: number
  hitW: number
  labelW: number
}

export interface LayoutGroup {
  name: string
  lanes: number
  items: LayoutItem[]
}

/** 레이블 글자 폭 추정(px). 한글은 넓고 숫자·영문은 좁다 */
export function textWidth(s: string, fontPx = 12): number {
  let w = 0
  for (const ch of s) w += /[ㄱ-힣]/.test(ch) ? fontPx : /\s/.test(ch) ? fontPx * 0.35 : fontPx * 0.58
  return Math.ceil(w) + 4
}

/** 막대 위에 붙는 레이블: '1호선 08:24'. 한 시각만 아는 점은 부족한 정보를 레이블에 함께 적는다 */
export function labelOf(it: TimelineItem): string {
  const t = it.trip.boardTime ?? it.trip.alightTime ?? ''
  const suffix =
    it.kind === 'point-board'
      ? ' · 하차 미기록'
      : it.kind === 'point-alight'
        ? ' · 승차 미기록'
        : it.kind === 'point-same'
          ? ' · 0분'
          : it.kind === 'ongoing'
            ? ' · 진행 중'
            : it.kind === 'skipped'
              ? it.trip.kind === 'missed'
                ? ' · 놓침'
                : ' · 관찰'
              : ''
  return `${it.line} ${t}${suffix}`.trim()
}

const POINT_R = 11

/**
 * 같은 노선 행 안에서 겹치는 막대는 아래 레인으로 내려 모두 보이게 한다.
 * 레인 배치는 막대뿐 아니라 레이블이 차지하는 폭도 함께 고려해 글자가 겹치지 않게 한다.
 */
export function layoutTimeline(model: TimelineModel, pxPerMin: number): LayoutGroup[] {
  const groups = new Map<string, TimelineItem[]>()
  for (const it of model.items) {
    const arr = groups.get(it.group)
    if (arr) arr.push(it)
    else groups.set(it.group, [it])
  }
  const order = [...groups.keys()].sort((a, b) => {
    if (a === '비탑승') return 1
    if (b === '비탑승') return -1
    const first = (g: string) => Math.min(...groups.get(g)!.map((i) => i.start))
    return first(a) - first(b)
  })

  return order.map((name) => {
    const its = [...groups.get(name)!].sort((a, b) => a.start - b.start || a.end - b.end)
    const laneRight: number[] = []
    const placed: LayoutItem[] = []
    for (const it of its) {
      const isPoint = it.start === it.end
      const x = isPoint ? xOf(it.start, pxPerMin) - POINT_R : xOf(it.start, pxPerMin)
      const w = isPoint ? POINT_R * 2 : Math.max(2, xOf(it.end, pxPerMin) - xOf(it.start, pxPerMin))
      const labelW = textWidth(labelOf(it))
      const extent = Math.max(x + w, x + labelW) + 4
      let lane = laneRight.findIndex((r) => r <= x)
      if (lane < 0) {
        lane = laneRight.length
        laneRight.push(0)
      }
      laneRight[lane] = extent
      placed.push({ item: it, lane, x, w, hitX: x, hitW: w, labelW })
    }
    // 터치 영역: 최소 MIN_TOUCH 로 넓히되 같은 레인의 이웃 막대와 겹치지 않게 중간에서 나눈다
    const lanes = Math.max(1, laneRight.length)
    for (let l = 0; l < lanes; l++) {
      const row = placed.filter((p) => p.lane === l).sort((a, b) => a.x - b.x)
      row.forEach((p, i) => {
        const pad = Math.max(0, (MIN_TOUCH - p.w) / 2)
        let left = p.x - pad
        let right = p.x + p.w + pad
        const prev = row[i - 1]
        const next = row[i + 1]
        if (prev) left = Math.max(left, (prev.x + prev.w + p.x) / 2)
        if (next) right = Math.min(right, (p.x + p.w + next.x) / 2)
        p.hitX = Math.min(left, p.x)
        p.hitW = Math.max(right - p.hitX, Math.min(p.w, 1))
      })
    }
    return { name, lanes, items: placed }
  })
}

export function chartHeight(groups: LayoutGroup[]): number {
  return groups.reduce((h, g) => h + g.lanes * LANE_H, 0) + AXIS_H
}
