import { describe, expect, it } from 'vitest'
import { standingMinutesOf } from './timelineHelpers'
import { buildTimeline, describeItem, seatSegments, summarizeDay } from '../src/domain/timeline'
import { LANE_H, fitScale, labelOf, layoutTimeline, MIN_TOUCH, ticksFor, xOf } from '../src/domain/timelineLayout'
import { lineColor } from '../src/domain/lineColors'

it('10분·30분·1시간 눈금에서도 분 단위 좌표를 유지한다', () => {
  for (const interval of [10, 30, 60] as const) {
    const scale = 88 / interval
    const ticks = ticksFor(1500, scale, interval)
    expect(ticks[1].minute - ticks[0].minute).toBe(interval)
    expect(xOf(ticks[1].minute, scale) - xOf(ticks[0].minute, scale)).toBe(88)
    expect(xOf(478, scale)).toBe(478 * scale)
    expect(ticks.at(-1)?.label).toContain('익일')
  }
})
import { mkEvent, mkTrip } from './helpers'

const trip = (p: Parameters<typeof mkTrip>[0]) => mkTrip({ date: '2026-03-02', ...p })

describe('타임라인 좌표', () => {
  it('막대의 시작·끝은 00:00 기준 분이고 x·폭은 시각에 비례한다', () => {
    const t = trip({ line: '1호선', boardTime: '08:24', alightTime: '09:20' })
    const m = buildTimeline([t], [])
    const [it] = m.items
    expect(it.kind).toBe('span')
    expect([it.start, it.end]).toEqual([504, 560])
    const [g] = layoutTimeline(m, 2)
    expect(g.items[0].x).toBe(xOf(504, 2))
    expect(g.items[0].w).toBe(56 * 2)
  })

  it('같은 노선 반복·겹치는 구간이 하나도 사라지지 않고 서로 다른 레인에 놓인다', () => {
    const a = trip({ line: '1호선', boardTime: '08:00', alightTime: '09:00' })
    const b = trip({ line: '1호선', boardTime: '08:30', alightTime: '09:30' })
    const c = trip({ line: '1호선', boardTime: '18:00', alightTime: '18:30' })
    const d = trip({ line: '2호선', boardTime: '08:10', alightTime: '08:50' })
    const m = buildTimeline([a, b, c, d], [])
    expect(m.items).toHaveLength(4)
    const groups = layoutTimeline(m, 1)
    const g1 = groups.find((g) => g.name === '1호선')!
    expect(g1.items).toHaveLength(3)
    expect(g1.items.find((i) => i.item.id === a.id)!.lane).not.toBe(g1.items.find((i) => i.item.id === b.id)!.lane)
    expect(g1.lanes).toBeGreaterThanOrEqual(2)
    expect(groups.find((g) => g.name === '2호선')!.items).toHaveLength(1)
  })

  it('가까운 막대의 레이블이 같은 레인에서 겹치지 않는다', () => {
    const trips = ['08:00', '08:05', '08:10', '08:15'].map((b) => trip({ line: '1호선', boardTime: b, alightTime: '08:20' }))
    const g = layoutTimeline(buildTimeline(trips, []), 1)[0]
    for (let l = 0; l < g.lanes; l++) {
      const row = g.items.filter((i) => i.lane === l).sort((a, b) => a.x - b.x)
      for (let i = 1; i < row.length; i++) expect(row[i].x).toBeGreaterThanOrEqual(row[i - 1].x + Math.max(row[i - 1].w, row[i - 1].labelW))
    }
  })

  it('터치 영역은 최소 44px 이고 이웃 터치 영역과 겹치지 않는다', () => {
    const trips = [trip({ boardTime: '08:00', alightTime: '08:02' }), trip({ boardTime: '08:03', alightTime: '08:05' }), trip({ boardTime: '12:00', alightTime: '12:01' })]
    const g = layoutTimeline(buildTimeline(trips, []), 1)
    for (const grp of g) {
      for (const l of grp.items) {
        if (!grp.items.some((o) => o !== l && o.lane === l.lane && Math.abs(o.x - l.x) < MIN_TOUCH)) expect(l.hitW).toBeGreaterThanOrEqual(Math.min(MIN_TOUCH, 44))
      }
      for (let lane = 0; lane < grp.lanes; lane++) {
        const row = grp.items.filter((i) => i.lane === lane).sort((a, b) => a.hitX - b.hitX)
        for (let i = 1; i < row.length; i++) expect(row[i].hitX).toBeGreaterThanOrEqual(row[i - 1].hitX + row[i - 1].hitW - 0.001)
      }
    }
    expect(LANE_H).toBeGreaterThanOrEqual(44)
  })

  it('눌림 영역은 막대 위 레이블까지 덮고(글꼴이 더 넓어도), 이웃과 겹치지 않는다', () => {
    const trips = [trip({ line: '2호선', boardTime: '12:00', alightTime: '12:30' }), trip({ line: '2호선', boardTime: '12:20', alightTime: '12:25' }), trip({ line: '2호선', boardTime: '15:00', alightTime: '15:10' })]
    for (const measure of [undefined, (s: string) => s.length * 20]) {
      for (const grp of layoutTimeline(buildTimeline(trips, []), 0.35, measure)) {
        for (const l of grp.items) {
          expect(l.hitX).toBeLessThanOrEqual(l.x + 0.001)
          expect(l.hitX + l.hitW).toBeGreaterThanOrEqual(Math.min(l.x + l.labelW, l.hitX + l.hitW))
          // 항목 전체(막대+레이블)의 중심이 눌림 영역 안에 있다 → 중심을 눌러도 이 항목이 눌린다
          const cx = (Math.min(l.x, l.hitX) + Math.max(l.x + l.w, l.x + l.labelW)) / 2
          expect(cx).toBeGreaterThanOrEqual(l.hitX)
          expect(cx).toBeLessThanOrEqual(l.hitX + l.hitW)
        }
        for (let lane = 0; lane < grp.lanes; lane++) {
          const row = grp.items.filter((i) => i.lane === lane).sort((a, b) => a.hitX - b.hitX)
          for (let i = 1; i < row.length; i++) expect(row[i].hitX).toBeGreaterThanOrEqual(row[i - 1].hitX + row[i - 1].hitW - 0.001)
        }
      }
    }
  })

  it('fitScale 은 범위를 컨테이너 폭에 맞추고, 눈금은 폭에 맞춰 성기게 나온다', () => {
    expect(fitScale(1440, 0, 1440)).toBe(1)
    const sparse = ticksFor(1440, 0.25)
    expect(sparse.length).toBeLessThan(ticksFor(1440, 3).length)
    expect(sparse[0].label).toBe('00시')
  })

  it('노선 색은 노선별로 안정적이고 서로 다르다', () => {
    expect(lineColor('1호선', 'subway')).not.toBe(lineColor('2호선', 'subway'))
    expect(lineColor('9999', 'bus')).toBe(lineColor('9999', 'bus'))
  })
})

describe('시각이 빠졌거나 특이한 기록', () => {
  it('승차 시각만 있으면 점 + 하차 미기록, 하차만 있으면 점 + 승차 미기록', () => {
    const a = trip({ line: '1호선', boardTime: '10:00' })
    const b = trip({ line: '1호선', alightTime: '11:00' })
    const m = buildTimeline([a, b], [])
    expect(m.items.map((i) => i.kind)).toEqual(['point-board', 'point-alight'])
    expect(labelOf(m.items[0])).toContain('하차 미기록')
    expect(labelOf(m.items[1])).toContain('승차 미기록')
    expect(m.items.every((i) => i.start === i.end)).toBe(true)
  })

  it('시각이 하나도 없으면 그래프에 그리지 않고 목록으로 보낸다 (소요 시간 원문이 있어도 추정하지 않음)', () => {
    const t = trip({ line: '2호선', reportedDurationMin: 25 })
    const m = buildTimeline([t], [])
    expect(m.items).toHaveLength(0)
    expect(m.untimed).toHaveLength(1)
    expect(m.untimed[0].notes.join(' ')).toContain('추정하지 않음')
    expect(m.focus).toBeNull()
  })

  it('자정을 넘기면 끝이 1440 을 넘고 축이 다음 날까지 연장된다', () => {
    const t = trip({ line: '2호선', boardTime: '23:40', alightTime: '00:20' })
    const m = buildTimeline([t], [])
    expect([m.items[0].start, m.items[0].end]).toEqual([1420, 1460])
    expect(m.items[0].crossesMidnight).toBe(true)
    expect(m.items[0].durationMin).toBe(40)
    expect(m.axisEnd).toBe(1500)
  })

  it('승·하차 시각이 같으면 24시간이 아니라 0분 점이다', () => {
    const m = buildTimeline([trip({ boardTime: '09:00', alightTime: '09:00' })], [])
    expect(m.items[0].kind).toBe('point-same')
    expect(m.items[0].durationMin).toBe(0)
    expect(m.axisEnd).toBe(1440)
  })

  it('놓침·관찰은 탑승 요약에 들어가지 않는다', () => {
    const r = trip({ boardTime: '08:00', alightTime: '08:30' })
    const missed = trip({ kind: 'missed', boardTime: '07:50' })
    const obs = trip({ kind: 'observed' })
    const m = buildTimeline([r, missed, obs], [])
    const s = summarizeDay(m)
    expect(s.rides).toBe(1)
    expect(s.nonRide).toBe(2)
    expect(m.items.find((i) => i.id === missed.id)!.group).toBe('비탑승')
    expect(m.untimed.map((u) => u.id)).toEqual([obs.id])
  })

  it('진행 중 탑승: 오늘이면 현재 시각까지 잠정 구간, 다른 날이면 하차 미기록 점', () => {
    const t = trip({ ongoing: true, boardTime: '08:00', initialSeat: 'standing' })
    const e = mkEvent(t.id, { time: '08:10', state: 'seated' })
    const live = buildTimeline([t], [e], { nowMinute: 8 * 60 + 40 })
    const it = live.items[0]
    expect(it.kind).toBe('ongoing')
    expect([it.start, it.end]).toEqual([480, 520])
    expect(it.segments.map((s) => [s.state, s.start, s.end, !!s.provisional])).toEqual([
      ['standing', 480, 490, false],
      ['seated', 490, 520, true],
    ])
    const past = buildTimeline([t], [e], { nowMinute: null })
    expect(past.items[0].kind).toBe('point-board')
  })
})

describe('좌석 상태 구간 나누기', () => {
  it('08:24 서서 → 08:30 앉음 → 09:20 하차', () => {
    const t = trip({ boardTime: '08:24', alightTime: '09:20', initialSeat: 'standing', seatLogComplete: true })
    const m = buildTimeline([t], [mkEvent(t.id, { time: '08:30', state: 'seated', place: '가가역' })])
    expect(m.items[0].segments).toEqual([
      { start: 504, end: 510, state: 'standing' },
      { start: 510, end: 560, state: 'seated' },
    ])
    expect(m.items[0].ticks).toHaveLength(1)
    // 기존 통계 계산과 일치
    expect(standingMinutesOf(t, [mkEvent(t.id, { time: '08:30', state: 'seated' })])).toBe(6)
  })

  it('앉았다가 일어서면 다시 서서 구간이 된다', () => {
    const t = trip({ boardTime: '10:00', alightTime: '10:40', initialSeat: 'seated', seatLogComplete: true })
    const evs = [mkEvent(t.id, { time: '10:10', state: 'standing' }), mkEvent(t.id, { time: '10:25', state: 'seated' })]
    const { segments } = seatSegments(t, evs, 600, 640)
    expect(segments.map((s) => s.state)).toEqual(['seated', 'standing', 'seated'])
    expect(segments.map((s) => s.end - s.start)).toEqual([10, 15, 15])
  })

  it('마지막 변화 이후 완결 확인이 없으면 남은 구간은 미확인', () => {
    const t = trip({ boardTime: '08:00', alightTime: '08:40', initialSeat: 'standing', seatLogComplete: null })
    const { segments, notes } = seatSegments(t, [mkEvent(t.id, { time: '08:10', state: 'seated' })], 480, 520)
    // 08:10 에 앉았다는 사실(눈금)은 남지만, 그 뒤 변화가 없었는지 모르므로 이후 구간은 미확인
    expect(segments.map((s) => [s.state, s.start, s.end])).toEqual([
      ['standing', 480, 490],
      ['unknown', 490, 520],
    ])
    expect(notes.join(' ')).toContain('확인이 없어')
  })

  it('좌석 정보가 전혀 없으면 전 구간 미확인 (서 있었다고 가정하지 않음)', () => {
    const t = trip({ boardTime: '08:00', alightTime: '08:40' })
    const { segments } = seatSegments(t, [], 480, 520)
    expect(segments).toEqual([{ start: 480, end: 520, state: 'unknown' }])
  })

  it('탑승 시 좌석을 모르면 첫 변화 전까지는 미확인', () => {
    const t = trip({ boardTime: '08:00', alightTime: '08:40', seatLogComplete: true })
    const { segments } = seatSegments(t, [mkEvent(t.id, { time: '08:15', state: 'seated' })], 480, 520)
    expect(segments.map((s) => s.state)).toEqual(['unknown', 'seated'])
  })

  it('시각 없는 변화나 구간 밖 변화 이후는 미확인으로 두고 이유를 남긴다', () => {
    const t = trip({ boardTime: '08:00', alightTime: '08:40', initialSeat: 'standing', seatLogComplete: true })
    const a = seatSegments(t, [mkEvent(t.id, { time: null, state: 'seated' })], 480, 520)
    expect(a.segments.every((s) => s.state === 'unknown' || s.state === 'standing')).toBe(true)
    expect(a.notes.join(' ')).toContain('시각이 기록되지 않은')
    const b = seatSegments(t, [mkEvent(t.id, { time: '09:30', state: 'seated' })], 480, 520)
    expect(b.notes.join(' ')).toContain('구간 밖')
  })

  it('같은 분의 변화는 눈금과 순서가 남고 구간은 합쳐진다', () => {
    const t = trip({ boardTime: '08:00', alightTime: '08:40', initialSeat: 'standing', seatLogComplete: true })
    const evs = [mkEvent(t.id, { time: '08:10', state: 'seated' }), mkEvent(t.id, { time: '08:10', state: 'standing' })]
    const r = seatSegments(t, evs, 480, 520)
    expect(r.ticks).toHaveLength(2)
    expect(r.segments.map((s) => s.state)).toEqual(['standing'])
    expect(r.segments[0].end).toBe(520)
  })
})

describe('하루 요약', () => {
  it('계산 가능한 건수와 함께 합계를 낸다 (미확인은 합계에 넣지 않음)', () => {
    const a = trip({ mode: 'subway', boardTime: '08:24', alightTime: '09:20', initialSeat: 'standing', seatLogComplete: true })
    const b = trip({ mode: 'bus', line: '5000', boardTime: '12:00', alightTime: '12:30' })
    const c = trip({ mode: 'subway', boardTime: '18:00' })
    const s = summarizeDay(buildTimeline([a, b, c], [mkEvent(a.id, { time: '08:30', state: 'seated' })]))
    expect(s.rides).toBe(3)
    expect([s.subway, s.bus]).toEqual([2, 1])
    expect(s.ridesWithDuration).toBe(2)
    expect(s.durationSum).toBe(56 + 30)
    expect(s.standingMin).toBe(6)
    expect(s.seatedMin).toBe(50)
    expect(s.unknownMin).toBe(30)
    expect(s.spanRides).toBe(2)
    expect(s.fullyKnownRides).toBe(1)
    expect(s.initialKnown).toBe(1)
    expect(s.midSeatEvents).toBe(1)
    expect(s.ridesWithMidSeat).toBe(1)
  })

  it('describeItem 은 시각·노선·역·좌석 상태를 담는다', () => {
    const t = trip({ line: '1호선', boardPlace: '가가역', alightPlace: '나나역', boardTime: '08:24', alightTime: '09:20', initialSeat: 'standing', seatLogComplete: true })
    const m = buildTimeline([t], [mkEvent(t.id, { time: '08:30', state: 'seated' })])
    const d = describeItem(m.items[0])
    expect(d.title).toBe('1호선')
    expect(d.rows).toContainEqual(['시각', '08:24 → 09:20'])
    expect(d.rows).toContainEqual(['승·하차', '가가역 → 나나역'])
    expect(d.rows).toContainEqual(['탑승 시 좌석', '서서'])
    expect(d.segments[0]).toContain('서서 이동')
    expect(d.segments[1]).toContain('앉아서 이동')
  })
})
