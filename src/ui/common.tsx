import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { formatTrainRoute } from '../domain/stations'
import { clearToast, type ToastState } from './hooks'
import { diffMinutes, formatDuration } from '../domain/time'
import { summarizeSeat, tripDuration } from '../domain/seat'
import {
  BUS_DOOR_LABEL,
  CROWDING_LABEL,
  KIND_LABEL,
  MODE_LABEL,
  PURPOSE_LABEL,
  SERVICE_LABEL,
  SIDE_LABEL,
  type SeatEvent,
  type Trip,
} from '../domain/types'

export { destLabel } from '../domain/stations'

export function Chip<T extends string | number>(props: {
  value: T
  selected: boolean
  onSelect: (v: T) => void
  children?: ReactNode
  tone?: 'default' | 'suggest'
  small?: boolean
}) {
  const { value, selected, onSelect, children, tone = 'default', small } = props
  return (
    <button
      type="button"
      className={`chip ${selected ? 'is-on' : ''} ${tone === 'suggest' ? 'is-suggest' : ''} ${small ? 'is-small' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(value)}
    >
      {children ?? String(value)}
    </button>
  )
}

/** 단일 선택 칩 그룹. 같은 칩을 다시 누르면 선택이 해제되어 '미기록'으로 돌아간다 */
export function ChipGroup<T extends string | number>(props: {
  label: string
  options: Array<{ value: T; label: ReactNode }>
  value: T | null
  onChange: (v: T | null) => void
  hint?: string
}) {
  const { label, options, value, onChange, hint } = props
  return (
    <div className="field" role="group" aria-label={label}>
      <div className="field-label">
        {label}
        {value === null && <span className="unrecorded">미기록</span>}
      </div>
      <div className="chips">
        {options.map((o) => (
          <Chip key={String(o.value)} value={o.value} selected={value === o.value} onSelect={(v) => onChange(value === v ? null : v)}>
            {o.label}
          </Chip>
        ))}
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export function Section(props: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${props.className ?? ''}`}>
      {(props.title || props.action) && (
        <div className="section-head">
          {props.title && <h2>{props.title}</h2>}
          {props.action}
        </div>
      )}
      {props.children}
    </section>
  )
}

export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>
}

export function Ratio(props: { num: number; den: number; label?: string }) {
  if (props.den === 0) return <span className="muted">표본 없음</span>
  const pct = Math.round((props.num / props.den) * 100)
  return (
    <span>
      <strong>{pct}%</strong>{' '}
      <span className="muted">
        ({props.num}/{props.den})
      </span>
    </span>
  )
}

export function seatText(trip: Trip, events: SeatEvent[]): string[] {
  const out: string[] = []
  const s = summarizeSeat(trip, events)
  if (trip.initialSeat) out.push(trip.initialSeat === 'seated' ? '앉아서 탑승' : '서서 탑승')
  for (const e of [...events].sort((a, b) => a.createdAt - b.createdAt)) {
    out.push(`${[e.time, e.place].filter(Boolean).join(' ')} ${e.state === 'seated' ? '착석' : '일어섬'}${e.note ? ` (${e.note})` : ''}`.trim())
  }
  if (s.minutesToFirstSeat !== null) out.push(`착석까지 ${s.minutesToFirstSeat}분`)
  return out
}

export function TripCard(props: { trip: Trip; events: SeatEvent[]; to?: string }) {
  const { trip: t, events } = props
  const dur = tripDuration(t)
  const seat = seatText(t, events)
  const pos: string[] = []
  if (t.mode === 'subway') {
    if (t.car !== null || t.door !== null) pos.push(`${t.car ?? '?'}-${t.door ?? '?'}`)
    if (t.side) pos.push(SIDE_LABEL[t.side])
  } else if (t.busDoor) pos.push(BUS_DOOR_LABEL[t.busDoor])
  if (t.waitOrder !== null) pos.push(`${t.waitOrder}번째`)
  const route = [t.boardPlace, t.alightPlace].some(Boolean) ? `${t.boardPlace ?? '?'} → ${t.alightPlace ?? '?'}` : null

  const body = (
    <>
      <div className="card-top">
        <div className="time">
          {t.boardTime ?? '--:--'}
          {(t.alightTime || t.ongoing) && <span className="arrow"> → </span>}
          {t.ongoing ? <span className="live">탑승 중</span> : t.alightTime}
          {dur !== null && <span className="dur">{formatDuration(dur)}</span>}
        </div>
        <div className="badges">
          {t.kind !== 'ride' && <span className={`badge kind-${t.kind}`}>{KIND_LABEL[t.kind]}</span>}
          {t.purpose && <span className="badge">{PURPOSE_LABEL[t.purpose]}</span>}
          <span className="badge mode">{MODE_LABEL[t.mode]}</span>
        </div>
      </div>
      <div className="card-main">
        <strong>{t.line ?? (t.mode === 'subway' ? '노선 미기록' : '버스 번호 미기록')}</strong>
        {route && <span> · {route}</span>}
        {formatTrainRoute(t.trainOrigin, t.trainDestination) && <span> · {formatTrainRoute(t.trainOrigin, t.trainDestination)}</span>}
        {t.service && t.service !== 'normal' && <span className="badge">{SERVICE_LABEL[t.service]}</span>}
      </div>
      {pos.length > 0 && <div className="card-sub">{pos.join(' · ')}</div>}
      {t.kind === 'ride' && (
        <div className="card-sub">
          {seat.length ? seat.join(' → ') : <span className="muted">좌석 미기록</span>}
          {t.crowding && <span className={`badge crowd-${t.crowding}`}>{CROWDING_LABEL[t.crowding]}</span>}
        </div>
      )}
      {(t.incident || (t.delayMinutes ?? 0) > 0) && (
        <div className="card-sub warn">
          {t.incident}
          {t.delayMinutes ? ` (${t.delayMinutes}분 지연)` : ''}
        </div>
      )}
      {t.note && <div className="card-note">{t.note}</div>}
    </>
  )
  return props.to ? (
    <Link className="card" to={props.to}>
      {body}
    </Link>
  ) : (
    <div className="card">{body}</div>
  )
}

export function minutesBetween(a: string | null, b: string | null) {
  return diffMinutes(a, b)
}

export function ToastView({ toast: t }: { toast: ToastState | null }) {
  return (
    <div className={`toast ${t ? 'show' : ''} ${t?.action ? 'has-action' : ''}`} role="status" aria-live="polite">
      <span>{t?.msg}</span>
      {t?.action && (
        <button
          type="button"
          className="toast-action"
          onClick={async () => {
            await t.action!.run()
            clearToast()
          }}
        >
          {t.action.label}
        </button>
      )}
    </div>
  )
}
