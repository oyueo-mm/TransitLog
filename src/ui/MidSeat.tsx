import { useId } from 'react'
import { findFirstSeated, removeFirstSeated, upsertFirstSeated } from '../domain/seatEdit'
import { canonicalName } from '../domain/stations'
import type { PlaceSuggestion } from '../domain/suggest'
import { nowHm } from '../domain/time'
import type { SeatEventDraft } from '../domain/types'
import { Chip } from './common'

/**
 * '서서 탑승' 뒤에 중간에 앉은 일을 기록한다 (시각·역·비고, 모두 선택).
 * 이 컴포넌트는 첫 번째 '착석' 이벤트 하나만 만들거나 고친다 — 버튼을 여러 번 눌러도 이벤트가 늘어나지 않는다.
 * 시각이나 역을 모르면 비워 둔 채로 저장할 수 있다. 여러 번 바뀌는 경우는 기록 수정 화면의 '좌석 변화 추가'를 쓴다.
 */
export function MidSeat(props: {
  events: SeatEventDraft[]
  onChange: (events: SeatEventDraft[]) => void
  places: PlaceSuggestion[]
  known: string[]
}) {
  const id = useId()
  const { events, onChange } = props
  const idx = findFirstSeated(events)
  const ev = idx >= 0 ? events[idx] : null

  if (!ev) {
    return (
      <button type="button" className="btn-secondary midseat-add" onClick={() => onChange(upsertFirstSeated(events))}>
        + 중간에 앉음 기록
      </button>
    )
  }
  const set = (patch: Partial<SeatEventDraft>) => onChange(upsertFirstSeated(events, patch))
  return (
    <div className="midseat" role="group" aria-label="중간 착석 기록">
      <div className="row-between">
        <strong>중간 착석</strong>
        <button type="button" className="btn-text danger" onClick={() => onChange(removeFirstSeated(events))}>
          중간 착석 삭제
        </button>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-t`}>
          착석한 시각 {!ev.time && <span className="unrecorded">미기록</span>}
        </label>
        <div className="field-row">
          <input id={`${id}-t`} type="time" value={ev.time ?? ''} onChange={(e) => set({ time: e.target.value || null })} />
          <button type="button" className="btn-small" onClick={() => set({ time: nowHm() })}>
            지금 앉음
          </button>
        </div>
      </div>
      <div className="field" role="group" aria-label="착석한 역·정류장">
        <div className="field-label">
          착석한 역·정류장 {!ev.place && <span className="unrecorded">미기록</span>}
        </div>
        <div className="chips">
          {ev.place && !props.places.some((p) => p.value === ev.place) && (
            <Chip value={ev.place} selected onSelect={() => set({ place: null })}>
              {ev.place}
            </Chip>
          )}
          {props.places.map((p) => (
            <Chip key={p.value} value={p.value} selected={ev.place === p.value} tone="suggest" onSelect={() => set({ place: ev.place === p.value ? null : p.value })}>
              {p.value}
            </Chip>
          ))}
        </div>
        <input
          className="quick-input"
          type="text"
          aria-label="착석한 역·정류장 직접 입력"
          placeholder="다른 곳은 검색하거나 직접 입력"
          list={`${id}-l`}
          value={ev.place ?? ''}
          onChange={(e) => set({ place: e.target.value || null })}
          onBlur={(e) => {
            const c = canonicalName(e.target.value, props.known)
            if (c !== (ev.place ?? null)) set({ place: c })
          }}
          autoComplete="off"
        />
        <datalist id={`${id}-l`}>
          {props.known.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-n`}>
          비고 (선택)
        </label>
        <input id={`${id}-n`} type="text" value={ev.note ?? ''} onChange={(e) => set({ note: e.target.value || null })} autoComplete="off" />
      </div>
    </div>
  )
}
