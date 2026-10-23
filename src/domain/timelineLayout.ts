import type { TimelineItem, TimelineModel } from './timeline'

/**
 * 타임라인 그림의 좌표 계산 (순수 함수).
 * x 좌표는 '분 × pxPerMin', 막대 위치·길이는 실제 승·하차 시각에 정확히 비례한다.
 */
export const MIN_TOUCH = 44
/** Labels share the bar row; preserve a 44px touch target vertically. */
export const LANE_H = 44
export const AXIS_H = 30

export const xOf = (minute: number, pxPerMin: number) => minute * pxPerMin

/** 컨테이너 너비에 [start, end] 분 범위가 꼭 맞는 배율 */
export function fitScale(containerPx: number, start: number, end: number): number {
  const span = Math.max(1, end - start)
  return Math.max(0.05, containerPx / span)
}

/** 눈금 간격(분): 눈금 사이가 minGapPx 이상이 되는 가장 작은 값 */
export function tickStep(pxPerMin: number, minGapPx = 88): number {
  for (const step of [1, 5, 10, 30, 60, 180, 360, 720, 1440]) if (step * pxPerMin >= minGapPx) return step
  return 1440
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

/** Keep edge labels inside the viewport-sized SVG, even on a next-day axis. */
export function placeTickLabels(ticks: Tick[], pxPerMin: number, width: number, measure: (s: string) => number = textWidth): (Tick & { labelX: number })[] {
  let right = -Infinity
  return ticks.flatMap(t => {
    const labelW = measure(t.label)
    const labelX = Math.max(3, Math.min(xOf(t.minute, pxPerMin) + 3, width - labelW - 3))
    if (labelX < right + 8) return []
    right = labelX + labelW
    return [{ ...t, labelX }]
  })
}

export interface LayoutItem {
  item: TimelineItem
  lane: number
  /** 막대(또는 점)의 실제 그림 영역 */
  x: number
  w: number
  /** 터치 영역: 44px까지 확장하되 이웃의 영역과 겹치지 않게 제한한다. */
  hitX: number
  hitW: number
  labelW: number
  label: string
  labelX: number
  labelInside: boolean
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

/** 전체 레이블: '1호선 08:24'. 공간이 부족하면 표시만 축약하고 상세에는 전체를 제공한다. */
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
const graphicEnd = (p: LayoutItem) => p.x + p.w + (p.item.kind === 'ongoing' ? 8 : 0)

/**
 * 그림이 겹치는 경우에만 레인을 추가한다. 레이블은 같은 행의 빈 공간에 배치한다.
 */
export type TimelineGrouping = 'continuous' | 'lines'

export function layoutTimeline(model: TimelineModel, pxPerMin: number, measure: (s: string) => number = textWidth, grouping: TimelineGrouping = 'lines'): LayoutGroup[] {
  const groups = new Map<string, TimelineItem[]>()
  for (const it of model.items) {
    const name = grouping === 'continuous' ? '연속' : it.group
    const arr = groups.get(name)
    if (arr) arr.push(it)
    else groups.set(name, [it])
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
      const w = isPoint ? POINT_R * 2 : xOf(it.end, pxPerMin) - xOf(it.start, pxPerMin)
      // Only graphical overlaps need another lane. Labels never add lanes.
      const extent = x + w + (it.kind === 'ongoing' ? 8 : 0)
      let lane = laneRight.findIndex((r) => r <= x + 0.001)
      if (lane < 0) {
        lane = laneRight.length
        laneRight.push(0)
      }
      laneRight[lane] = extent
      placed.push({ item: it, lane, x, w, hitX: x, hitW: w, labelW: 0, label: '', labelX: x, labelInside: false })
    }
    // Divide each gap between its neighbours. Labels and touch targets stay in
    // their own cell, so a label can never hide a different trip or steal a tap.
    const lanes = Math.max(1, laneRight.length)
    for (let l = 0; l < lanes; l++) {
      const row = placed.filter((p) => p.lane === l).sort((a, b) => a.x - b.x)
      row.forEach((p, i) => {
        const pad = Math.max(0, (MIN_TOUCH - p.w) / 2)
        const prev = row[i - 1]
        const next = row[i + 1]
        const end = graphicEnd(p)
        const left = prev ? (graphicEnd(prev) + p.x) / 2 : Math.max(0, p.x - 240)
        const right = next ? (end + next.x) / 2 : Math.max(end, model.axisEnd * pxPerMin)
        const time = p.item.trip.boardTime ?? p.item.trip.alightTime ?? ''
        const full = grouping === 'continuous' ? labelOf(p.item) : labelOf(p.item).replace(`${p.item.line} `, '')
        const slots = [
          { x: p.x + 4, w: p.item.start === p.item.end ? 0 : p.w - 8, inside: true },
          { x: end + 4, w: right - end - 8, inside: false },
          { x: left + 4, w: p.x - left - 8, inside: false, before: true },
        ]
        for (const slot of slots) {
          const budget = Math.min(240, slot.w)
          let label = measure(full) <= budget ? full : measure(time) <= budget ? time : ''
          if (!label && budget >= 32) {
            label = full
            while (label && measure(`${label}…`) > budget) label = label.slice(0, -1)
            if (label) label += '…'
          }
          if (!label) continue
          p.label = label
          p.labelW = measure(label)
          p.labelX = slot.before ? p.x - 4 - p.labelW : slot.x
          p.labelInside = slot.inside
          break
        }
        p.hitX = Math.max(left, Math.min(p.x - pad, p.label ? p.labelX - 2 : p.x))
        const hitEnd = Math.min(right, Math.max(end + pad, p.labelX + p.labelW + 2))
        p.hitW = hitEnd - p.hitX
      })
    }
    return { name, lanes, items: placed }
  })
}

/** Clamp zoom without rounding the minute coordinates. */
export function clampTimelineScale(scale: number, width: number, axisEnd: number): number {
  return Math.max(fitScale(width, 0, axisEnd), Math.min(120, scale))
}

/** Scroll offset that keeps a minute under a given viewport pixel after zoom. */
export function anchoredScroll(minute: number, pixel: number, scale: number): number {
  return Math.max(0, minute * scale - pixel)
}

export function chartHeight(groups: LayoutGroup[]): number {
  return groups.reduce((h, g) => h + g.lanes * LANE_H, 0) + AXIS_H
}
