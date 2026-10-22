import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { colorKey, lineColor } from '../domain/lineColors'
import { buildTimeline, describeItem, summarizeDay, type SeatSegState, type TimelineItem } from '../domain/timeline'
import { AXIS_H, LANE_H, chartHeight, fitScale, labelOf, layoutTimeline, textWidth, ticksFor, xOf, type LayoutItem } from '../domain/timelineLayout'
import { formatDuration } from '../domain/time'
import type { SeatEvent, Trip } from '../domain/types'
import { useNow } from './hooks'

/**
 * 하루 이동 타임라인 (SVG).
 *  - 가로: 00:00~24:00 (자정을 넘긴 하차가 있으면 다음 날 연장 구간까지)
 *  - 막대: 승차~하차에 정확히 비례. 노선은 색과 이름으로, 좌석 상태는 채움(앉아서)·줄무늬(서서)·점선 빈 막대(미확인)로 구분
 *  - 확대·축소·이동: 버튼과 터치 스크롤. 짧은 구간도 누를 수 있도록 터치 영역을 44px 이상으로 확보
 */
const BAR_Y = 22
const BAR_H = 24
const ZOOM_STEP = 1.6
const MAX_FACTOR = 14
const LABEL_COL = 76

/** 레이블 폭을 실제 글꼴로 측정한다(기기·글꼴마다 한글 폭이 달라 추정값만으로는 겹치거나 눌림 영역이 어긋남). 측정할 수 없으면 추정값 */
let ctx: CanvasRenderingContext2D | null | undefined
function measureLabel(s: string): number {
  if (ctx === undefined) {
    try {
      ctx = document.createElement('canvas').getContext('2d')
    } catch {
      ctx = null
    }
  }
  if (!ctx) return textWidth(s)
  ctx.font = `600 12px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`
  const w = ctx.measureText(s).width
  return w > 0 ? Math.ceil(w) + 6 : textWidth(s)
}

type ViewMode = 'focus' | 'full'

function Swatch({ kind, color = '#5B6577' }: { kind: SeatSegState | 'point' | 'ongoing' | 'skipped' | 'extension'; color?: string }) {
  const id = `sw-${kind}-${colorKey(color)}`
  return (
    <svg width="34" height="18" viewBox="0 0 34 18" aria-hidden="true" focusable="false">
      <defs>
        <pattern id={id} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" fill={color} fillOpacity="0.22" />
          <rect width="3.5" height="8" fill={color} />
        </pattern>
        <pattern id={`${id}-u`} width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1" fill="#8a93a3" />
        </pattern>
      </defs>
      {kind === 'seated' && <rect x="1" y="3" width="32" height="12" rx="3" fill={color} stroke={color} />}
      {kind === 'standing' && <rect x="1" y="3" width="32" height="12" rx="3" fill={`url(#${id})`} stroke={color} strokeWidth="1.5" />}
      {kind === 'unknown' && <rect x="1" y="3" width="32" height="12" rx="3" fill={`url(#${id}-u)`} stroke="#6b7385" strokeWidth="1.5" strokeDasharray="4 3" />}
      {kind === 'ongoing' && (
        <>
          <rect x="1" y="3" width="26" height="12" rx="3" fill={color} fillOpacity="0.55" stroke={color} strokeWidth="1.5" strokeDasharray="4 3" />
          <path d="M27 3 L33 9 L27 15 Z" fill={color} />
        </>
      )}
      {kind === 'point' && <path d="M17 1 L25 9 L17 17 L9 9 Z" fill={color} stroke="#fff" strokeWidth="1" />}
      {kind === 'skipped' && <path d="M17 1 L25 9 L17 17 L9 9 Z" fill="#fff" stroke="#6b7385" strokeWidth="1.5" />}
      {kind === 'extension' && <rect x="1" y="1" width="32" height="16" fill="#eef0f3" stroke="#8a93a3" strokeDasharray="3 3" />}
    </svg>
  )
}

function Bar({ li, selected, onSelect, color, pxPerMin }: { li: LayoutItem; selected: boolean; onSelect: () => void; color: string; pxPerMin: number }) {
  const it = li.item
  const y0 = li.lane * LANE_H
  const key = colorKey(color)
  const label = labelOf(it)
  const d = describeItem(it)
  const aria = `${label}. ${d.rows.map(([k, v]) => `${k} ${v}`).join(', ')}${d.segments.length ? `. ${d.segments.join(', ')}` : ''}`
  const isPoint = it.start === it.end
  const cx = xOf(it.start, pxPerMin)
  const cy = y0 + BAR_Y + BAR_H / 2

  const segFill = (state: SeatSegState) => (state === 'seated' ? color : state === 'standing' ? `url(#st-${key})` : 'url(#unk)')
  return (
    <g
      className={`tl-item ${selected ? 'is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={aria}
      aria-pressed={selected}
      data-trip-id={it.id}
      data-kind={it.kind}
      data-start={it.start}
      data-end={it.end}
      data-x={li.x}
      data-w={li.w}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <title>{`${label} — ${d.rows.map(([k, v]) => `${k}: ${v}`).join(' / ')}`}</title>
      <rect className="tl-hit" x={li.hitX} y={y0} width={li.hitW} height={LANE_H} fill="transparent" />
      <text x={li.x} y={y0 + 14} className="tl-label" fill={it.isRide ? color : '#566073'}>
        {label}
      </text>
      {isPoint ? (
        it.isRide ? (
          <path d={`M${cx} ${cy - 11} L${cx + 11} ${cy} L${cx} ${cy + 11} L${cx - 11} ${cy} Z`} fill={color} stroke="#fff" strokeWidth="1.5" />
        ) : (
          <path d={`M${cx} ${cy - 10} L${cx + 10} ${cy} L${cx} ${cy + 10} L${cx - 10} ${cy} Z`} fill="#fff" stroke="#566073" strokeWidth="2" />
        )
      ) : (
        <>
          {it.segments.map((g, i) => (
            <rect
              key={i}
              data-seg-state={g.state}
              data-seg-start={g.start}
              data-seg-end={g.end}
              data-provisional={g.provisional ? '1' : undefined}
              x={xOf(g.start, pxPerMin)}
              y={y0 + BAR_Y}
              width={Math.max(1, xOf(g.end, pxPerMin) - xOf(g.start, pxPerMin))}
              height={BAR_H}
              fill={segFill(g.state)}
              opacity={g.provisional ? 0.7 : 1}
            />
          ))}
          {/* 탑승 시 좌석이 기록된 경우 승차 지점에 그 상태를 작게 표시 (이후 구간이 미확인이어도 사실만 보여 줌) */}
          {it.trip.initialSeat && (
            <rect x={li.x} y={y0 + BAR_Y} width={Math.min(7, li.w)} height={BAR_H} fill={it.trip.initialSeat === 'seated' ? color : `url(#st-${key})`} stroke={color} strokeWidth="1" />
          )}
          <rect
            x={li.x}
            y={y0 + BAR_Y}
            width={li.w}
            height={BAR_H}
            fill="none"
            stroke={color}
            strokeWidth="1.8"
            strokeDasharray={it.kind === 'ongoing' ? '5 3' : undefined}
            rx="3"
          />
          {it.ticks.map((t) => (
            <g key={t.eventId} data-tick={t.at}>
              <line x1={xOf(t.at, pxPerMin)} x2={xOf(t.at, pxPerMin)} y1={y0 + BAR_Y - 3} y2={y0 + BAR_Y + BAR_H} stroke="#fff" strokeWidth="2.5" />
              <circle cx={xOf(t.at, pxPerMin)} cy={y0 + BAR_Y - 3} r="3.2" fill={t.state === 'seated' ? color : '#fff'} stroke={color} strokeWidth="1.5" />
            </g>
          ))}
          {it.kind === 'ongoing' && <path d={`M${li.x + li.w} ${y0 + BAR_Y} l8 ${BAR_H / 2} l-8 ${BAR_H / 2} Z`} fill={color} />}
        </>
      )}
      {selected && <rect x={li.hitX} y={y0 + 2} width={Math.max(li.hitW, 4)} height={LANE_H - 4} fill="none" stroke="#1f4fd1" strokeWidth="2" strokeDasharray="5 3" rx="6" pointerEvents="none" />}
    </g>
  )
}

export function DayTimeline({ date, trips, events, today }: { date: string; trips: Trip[]; events: SeatEvent[]; today: string }) {
  const location = useLocation()
  const now = useNow(30_000)
  const nowMinute = date === today ? now.getHours() * 60 + now.getMinutes() : null
  const dayEvents = useMemo(() => {
    const ids = new Set(trips.map((t) => t.id))
    return events.filter((e) => ids.has(e.tripId))
  }, [events, trips])
  const model = useMemo(() => buildTimeline(trips, dayEvents, { nowMinute }), [trips, dayEvents, nowMinute])
  const summary = useMemo(() => summarizeDay(model), [model])

  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [view, setView] = useState<ViewMode>('focus')
  const [factor, setFactor] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 화면 폭(회전·창 크기 변경 포함)을 관찰해 배율을 다시 계산한다
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const hasItems = model.items.length > 0
  const focus = model.focus ?? { start: 0, end: model.axisEnd }
  const baseScale = useMemo(() => {
    const w = Math.max(120, width)
    return view === 'full' ? fitScale(w, 0, model.axisEnd) : fitScale(w, focus.start, focus.end)
  }, [width, view, model.axisEnd, focus.start, focus.end])
  const pxPerMin = baseScale * factor
  const groups = useMemo(() => layoutTimeline(model, pxPerMin, measureLabel), [model, pxPerMin])
  const height = chartHeight(groups)
  const totalW = Math.max(width, Math.ceil(model.axisEnd * pxPerMin))
  const ticks = useMemo(() => ticksFor(model.axisEnd, pxPerMin), [model.axisEnd, pxPerMin])

  // 보기 모드·배율이 바뀌면 보이는 영역의 시작을 맞춘다
  const scrollKey = `${view}|${factor}|${date}|${hasItems}`
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    sc.scrollLeft = view === 'full' && factor === 1 ? 0 : Math.max(0, xOf(view === 'focus' ? focus.start : 0, pxPerMin) - 8)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, width > 0])

  // 날짜가 바뀌면 선택을 해제한다
  useEffect(() => setSelectedId(null), [date])

  const selected = model.items.find((i) => i.id === selectedId) ?? model.untimed.find((i) => i.id === selectedId) ?? null
  const colorOf = (it: TimelineItem) => lineColor(it.trip.line, it.trip.mode)
  const usedColors = useMemo(() => [...new Set(model.items.filter((i) => i.isRide).map((i) => lineColor(i.trip.line, i.trip.mode)))], [model.items])
  const lineNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of model.items) if (i.isRide && !m.has(i.line)) m.set(i.line, lineColor(i.trip.line, i.trip.mode))
    return [...m.entries()]
  }, [model.items])

  const zoom = (dir: 1 | -1) => {
    const sc = scrollRef.current
    const center = sc ? (sc.scrollLeft + sc.clientWidth / 2) / pxPerMin : 0
    const next = dir > 0 ? Math.min(MAX_FACTOR, factor * ZOOM_STEP) : Math.max(1, factor / ZOOM_STEP)
    setFactor(next)
    // 보고 있던 시각을 중심으로 유지
    requestAnimationFrame(() => {
      if (sc) sc.scrollLeft = Math.max(0, center * baseScale * next - sc.clientWidth / 2)
    })
  }
  const pan = (dir: 1 | -1) => scrollRef.current?.scrollBy({ left: dir * (scrollRef.current.clientWidth * 0.6), behavior: 'smooth' })

  const detail = selected ? describeItem(selected) : null

  return (
    <div className="timeline-box" data-testid="day-timeline">
      {!hasItems && model.untimed.length === 0 ? (
        <p className="muted">이 날짜에는 그래프로 그릴 이동 기록이 없습니다.</p>
      ) : (
        <>
          <div className="tl-controls" role="group" aria-label="타임라인 보기 조절">
            <button type="button" className={`btn-small ${view === 'full' && factor === 1 ? 'is-on' : ''}`} aria-pressed={view === 'full' && factor === 1} onClick={() => (setView('full'), setFactor(1))}>
              24시간 전체
            </button>
            <button type="button" className={`btn-small ${view === 'focus' && factor === 1 ? 'is-on' : ''}`} aria-pressed={view === 'focus' && factor === 1} disabled={!hasItems} onClick={() => (setView('focus'), setFactor(1))}>
              이동 시간대
            </button>
            <button type="button" className="btn-small" aria-label="축소" onClick={() => zoom(-1)} disabled={factor <= 1}>
              −
            </button>
            <button type="button" className="btn-small" aria-label="확대" onClick={() => zoom(1)} disabled={factor >= MAX_FACTOR}>
              ＋
            </button>
            <button type="button" className="btn-small" aria-label="왼쪽으로 이동" onClick={() => pan(-1)}>
              ◀
            </button>
            <button type="button" className="btn-small" aria-label="오른쪽으로 이동" onClick={() => pan(1)}>
              ▶
            </button>
          </div>

          {hasItems && (
            <div className="tl-frame">
              <div className="tl-rows" style={{ width: LABEL_COL }} aria-hidden="true">
                {groups.map((g) => (
                  <div key={g.name} className="tl-rowlabel" style={{ height: g.lanes * LANE_H }}>
                    <span className="tl-chip" style={{ borderColor: g.name === '비탑승' ? '#6b7385' : colorOf(g.items[0].item) }}>
                      <i style={{ background: g.name === '비탑승' ? '#fff' : colorOf(g.items[0].item), border: g.name === '비탑승' ? '2px solid #6b7385' : undefined }} />
                      {g.name}
                    </span>
                  </div>
                ))}
                <div style={{ height: AXIS_H }} />
              </div>
              <div className="tl-scroll" ref={wrapRef}>
                <div className="tl-scroller" ref={scrollRef} tabIndex={0} aria-label="가로로 스크롤하는 하루 이동 그래프" role="region">
                  <svg
                    className="tl-svg"
                    width={totalW}
                    height={height}
                    viewBox={`0 0 ${totalW} ${height}`}
                    role="group"
                    aria-label={`${date} 하루 이동 타임라인`}
                    data-px-per-min={pxPerMin}
                    data-axis-end={model.axisEnd}
                    data-view={view}
                  >
                    <defs>
                      {usedColors.map((c) => (
                        <pattern key={c} id={`st-${colorKey(c)}`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                          <rect width="8" height="8" fill={c} fillOpacity="0.22" />
                          <rect width="3.5" height="8" fill={c} />
                        </pattern>
                      ))}
                      <pattern id="unk" width="6" height="6" patternUnits="userSpaceOnUse">
                        <rect width="6" height="6" fill="#fff" />
                        <circle cx="3" cy="3" r="1" fill="#8a93a3" />
                      </pattern>
                      <pattern id="ext" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <rect width="8" height="8" fill="#f1f3f6" />
                        <rect width="1.5" height="8" fill="#c5cad3" />
                      </pattern>
                    </defs>
                    {model.axisEnd > 1440 && <rect x={xOf(1440, pxPerMin)} y="0" width={xOf(model.axisEnd - 1440, pxPerMin)} height={height - AXIS_H} fill="url(#ext)" data-testid="tl-extension" />}
                    {ticks.map((t) => (
                      <line key={t.minute} x1={xOf(t.minute, pxPerMin)} x2={xOf(t.minute, pxPerMin)} y1="0" y2={height - AXIS_H} stroke={t.major ? '#dfe3e8' : '#eef0f3'} strokeWidth="1" />
                    ))}
                    {model.axisEnd > 1440 && (
                      <>
                        <line x1={xOf(1440, pxPerMin)} x2={xOf(1440, pxPerMin)} y1="0" y2={height - AXIS_H} stroke="#566073" strokeWidth="1.5" strokeDasharray="5 3" />
                        <text x={xOf(1440, pxPerMin) + 4} y={height - AXIS_H - 4} className="tl-axis" fill="#566073">
                          다음 날 →
                        </text>
                      </>
                    )}
                    {(() => {
                      let y = 0
                      return groups.map((g) => {
                        const top = y
                        y += g.lanes * LANE_H
                        return (
                          <g key={g.name} transform={`translate(0 ${top})`}>
                            <line x1="0" x2={totalW} y1={g.lanes * LANE_H} y2={g.lanes * LANE_H} stroke="#eef0f3" />
                            {g.items.map((li) => (
                              <Bar key={li.item.id} li={li} selected={selectedId === li.item.id} onSelect={() => setSelectedId(selectedId === li.item.id ? null : li.item.id)} color={li.item.isRide ? colorOf(li.item) : '#566073'} pxPerMin={pxPerMin} />
                            ))}
                          </g>
                        )
                      })
                    })()}
                    {nowMinute !== null && (
                      <g data-testid="tl-now" pointerEvents="none">
                        <line x1={xOf(nowMinute, pxPerMin)} x2={xOf(nowMinute, pxPerMin)} y1="0" y2={height - AXIS_H} stroke="#d0124f" strokeWidth="1.2" strokeDasharray="2 3" />
                      </g>
                    )}
                    {ticks.map((t) => (
                      <text key={`l${t.minute}`} x={xOf(t.minute, pxPerMin) + 3} y={height - 9} className="tl-axis" fill="#566073" textAnchor="start">
                        {t.label}
                      </text>
                    ))}
                  </svg>
                </div>
              </div>
            </div>
          )}

          {/* 범례: 색만으로 구분하지 않도록 패턴과 글자를 함께 쓴다 */}
          <ul className="tl-legend" aria-label="범례">
            <li>
              <Swatch kind="seated" /> 앉아서 이동 <span className="muted">(진한 채움)</span>
            </li>
            <li>
              <Swatch kind="standing" /> 서서 이동 <span className="muted">(사선 줄무늬)</span>
            </li>
            <li>
              <Swatch kind="unknown" /> 좌석 미확인 <span className="muted">(점선 빈 막대)</span>
            </li>
            <li>
              <Swatch kind="point" /> 한 시각만 기록 <span className="muted">(◆, 하차·승차 미기록·0분)</span>
            </li>
            <li>
              <Swatch kind="ongoing" /> 진행 중 <span className="muted">(점선·▶, 현재까지 잠정)</span>
            </li>
            <li>
              <Swatch kind="skipped" /> 탑승하지 않음 <span className="muted">(놓침·관찰 ◇)</span>
            </li>
            {model.axisEnd > 1440 && (
              <li>
                <Swatch kind="extension" /> 다음 날 연장 구간
              </li>
            )}
          </ul>
          {lineNames.length > 0 && (
            <ul className="tl-legend" aria-label="노선 색상">
              {lineNames.map(([name, c]) => (
                <li key={name}>
                  <span className="tl-dot" style={{ background: c }} /> {name}
                </li>
              ))}
            </ul>
          )}

          {detail && selected && (
            <div className="card tl-detail" role="region" aria-label="선택한 탑승 상세" data-testid="tl-detail">
              <div className="row-between">
                <strong>{detail.title}</strong>
                <button type="button" className="btn-text" onClick={() => setSelectedId(null)}>
                  닫기
                </button>
              </div>
              <dl className="tl-dl">
                {detail.rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {detail.segments.length > 0 && (
                <ul className="plain small" aria-label="좌석 상태 구간">
                  {detail.segments.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
              {selected.ticks.length > 0 && <p className="small muted">좌석 변화: {selected.ticks.map((t) => t.label).join(' → ')}</p>}
              {detail.notes.length > 0 && (
                <ul className="plain small tl-notes">
                  {detail.notes.map((n) => (
                    <li key={n}>• {n}</li>
                  ))}
                </ul>
              )}
              <Link className="btn-secondary" to={`/trip/${selected.id}`} state={{ from: location.pathname }}>
                기록 수정으로 이동
              </Link>
            </div>
          )}

          {model.untimed.length > 0 && (
            <div className="tl-untimed" data-testid="tl-untimed">
              <h3>시각 미기록 ({model.untimed.length}건)</h3>
              <p className="hint">승·하차 시각이 없어 그래프에 그릴 수 없습니다. 시각을 추정하지 않습니다.</p>
              <ul className="plain">
                {model.untimed.map((u) => (
                  <li key={u.id}>
                    <Link to={`/trip/${u.id}`} state={{ from: location.pathname }}>
                      {u.line}
                      {u.trip.boardPlace || u.trip.alightPlace ? ` · ${u.trip.boardPlace ?? '?'}→${u.trip.alightPlace ?? '?'}` : ''}
                      {u.isRide ? '' : u.trip.kind === 'missed' ? ' · 놓침' : ' · 관찰'}
                    </Link>
                    {u.notes.length > 0 && <span className="muted small"> — {u.notes.join(' / ')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3>하루 요약</h3>
          <dl className="totals" data-testid="day-summary">
            <div>
              <dt>전체 탑승</dt>
              <dd>{summary.rides}회</dd>
            </div>
            <div>
              <dt>지하철 · 버스</dt>
              <dd>
                {summary.subway}회 · {summary.bus}회
              </dd>
            </div>
            <div>
              <dt>탑승 시간 합계</dt>
              <dd>
                {summary.ridesWithDuration > 0 ? formatDuration(summary.durationSum) : '—'}
                <span className="muted small"> ({summary.ridesWithDuration}/{summary.rides}건 계산)</span>
              </dd>
            </div>
            <div>
              <dt>서서 이동 (확인된 구간)</dt>
              <dd>
                {summary.spanRides > 0 ? formatDuration(summary.standingMin) : '—'}
                <span className="muted small"> ({summary.fullyKnownRides}/{summary.spanRides}건 전 구간 확인)</span>
              </dd>
            </div>
            <div>
              <dt>앉아서 이동 (확인된 구간)</dt>
              <dd>
                {summary.spanRides > 0 ? formatDuration(summary.seatedMin) : '—'}
                <span className="muted small"> (미확인 {formatDuration(summary.unknownMin)})</span>
              </dd>
            </div>
            <div>
              <dt>최초 착석 · 중간 착석</dt>
              <dd>
                {summary.initialSeated}건 · {summary.midSeatEvents}회
                <span className="muted small"> (탑승 시 좌석 기록 {summary.initialKnown}/{summary.rides}건, 중간 착석 {summary.ridesWithMidSeat}건)</span>
              </dd>
            </div>
          </dl>
          <p className="hint">
            시각·좌석이 기록된 구간만 계산하고 빠진 값은 추정하지 않습니다.
            {summary.nonRide > 0 ? ` 놓침·관찰 ${summary.nonRide}건은 탑승 통계에서 제외했습니다.` : ''}
          </p>
        </>
      )}
    </div>
  )
}
