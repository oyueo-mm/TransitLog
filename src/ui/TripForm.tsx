import { useId, type ReactNode } from 'react'
import {
  BUS_DOOR_LABEL,
  CROWDING_LABEL,
  KIND_LABEL,
  MODE_LABEL,
  PURPOSE_LABEL,
  SERVICE_LABEL,
  SIDE_LABEL,
  type BusDoor,
  type Crowding,
  type Mode,
  type NaKey,
  type Purpose,
  type RecordKind,
  type SeatEventDraft,
  type SeatState,
  type Service,
  type Side,
  type TripDraft,
} from '../domain/types'
import { findFirstSeated } from '../domain/seatEdit'
import { reconcileSeatLog } from '../domain/seatLog'
import { knownStations, suggestSeatPlaces } from '../domain/suggest'
import type { Trip } from '../domain/types'
import { ChipGroup } from './common'
import { MidSeat } from './MidSeat'
import { TimeInput } from './TimeInput'
import { RoutePicker } from './RoutePicker'

type Draft = TripDraft

function opts<T extends string>(labels: Record<T, string>): Array<{ value: T; label: string }> {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }))
}

function TextField(props: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  placeholder?: string
  list?: string[]
  na?: { on: boolean; toggle: (on: boolean) => void }
}) {
  const id = useId()
  const listId = `${id}-l`
  const naOn = props.na?.on ?? false
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {props.label}
        {!naOn && !props.value && <span className="unrecorded">미기록</span>}
        {naOn && <span className="unrecorded na">해당 없음</span>}
      </label>
      <div className="field-row">
        <input
          id={id}
          type="text"
          value={naOn ? '' : (props.value ?? '')}
          disabled={naOn}
          placeholder={props.placeholder}
          list={props.list?.length ? listId : undefined}
          onChange={(e) => props.onChange(e.target.value || null)}
          autoComplete="off"
        />
        {props.na && (
          <label className="check">
            <input type="checkbox" checked={naOn} onChange={(e) => props.na!.toggle(e.target.checked)} />
            해당 없음
          </label>
        )}
      </div>
      {props.list?.length ? (
        <datalist id={listId}>
          {props.list.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      ) : null}
    </div>
  )
}

function NumField(props: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  max?: number
  na?: { on: boolean; toggle: (on: boolean) => void }
  suffix?: string
}) {
  const id = useId()
  const naOn = props.na?.on ?? false
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {props.label}
        {!naOn && props.value === null && <span className="unrecorded">미기록</span>}
        {naOn && <span className="unrecorded na">해당 없음</span>}
      </label>
      <div className="field-row">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={props.min}
          max={props.max}
          value={naOn || props.value === null ? '' : props.value}
          disabled={naOn}
          onChange={(e) => props.onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
        {props.suffix && <span className="suffix">{props.suffix}</span>}
        {props.na && (
          <label className="check">
            <input type="checkbox" checked={naOn} onChange={(e) => props.na!.toggle(e.target.checked)} />
            해당 없음
          </label>
        )}
      </div>
    </div>
  )
}

function TimeField(props: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  return <TimeInput label={props.label} value={props.value} onChange={props.onChange} />
}

export interface TripFormProps {
  value: Draft
  events: SeatEventDraft[]
  onChange: (value: Draft, events: SeatEventDraft[]) => void
  /** 노선·역 추천과 자동완성의 근거가 되는 과거 기록 */
  history?: Trip[]
  historyEvents?: Array<{ tripId: string; place: string | null }>
  /** 가져오기 미리보기에서는 날짜를 고정 */
  lockDate?: boolean
}

export function TripForm({ value: v, events, onChange, history = [], historyEvents = [], lockDate }: TripFormProps) {
  const set = <K extends keyof Draft>(k: K, val: Draft[K]) => onChange({ ...v, [k]: val }, events)
  const na = (key: NaKey) => ({
    on: v.naFields.includes(key),
    toggle: (on: boolean) =>
      onChange(
        {
          ...v,
          naFields: on ? [...new Set([...v.naFields, key])] : v.naFields.filter((k) => k !== key),
          ...(on ? ({ [key]: null } as Partial<Draft>) : {}),
        },
        events,
      ),
  })
  // 좌석 이벤트·탑승 시 좌석이 달라지면 '기록 완결' 확인은 해제된다 (이전 확인이 부정확하게 남지 않도록)
  const withSeat = (nextV: Draft, nextEvents: SeatEventDraft[]) =>
    onChange(
      {
        ...nextV,
        seatLogComplete: reconcileSeatLog(
          { initialSeat: v.initialSeat, events, seatLogComplete: v.seatLogComplete },
          { initialSeat: nextV.initialSeat, events: nextEvents },
        ),
      },
      nextEvents,
    )
  const setEvents = (next: SeatEventDraft[]) => withSeat(v, next)
  const isSubway = v.mode === 'subway'
  const isRide = v.kind === 'ride'

  return (
    <div className="form">
      <ChipGroup<RecordKind>
        label="기록 종류"
        options={opts(KIND_LABEL)}
        value={v.kind}
        onChange={(x) => set('kind', x ?? 'ride')}
        hint="탑승하지 않은 기록(놓침·관찰)은 이동 횟수와 착석률 통계에서 제외됩니다."
      />
      <ChipGroup<Mode>
        label="교통수단"
        options={opts(MODE_LABEL)}
        value={v.mode}
        onChange={(x) => set('mode', x ?? 'subway')}
      />
      <ChipGroup<Purpose>
        label="목적"
        options={opts(PURPOSE_LABEL)}
        value={v.purpose}
        onChange={(x) => set('purpose', x)}
      />

      <div className="field">
        <label className="field-label" htmlFor="trip-date">
          날짜
        </label>
        <input id="trip-date" type="date" value={v.date} disabled={lockDate} onChange={(e) => e.target.value && set('date', e.target.value)} />
      </div>

      <RoutePicker
        value={v}
        history={history}
        historyEvents={historyEvents}
        showAlight={isRide}
        onChange={(patch) => onChange({ ...v, ...patch }, events)}
        na={{ trainOrigin: na('trainOrigin'), trainDestination: na('trainDestination') }}
      />

      {/* 모바일에서도 잘리지 않도록 시각은 한 줄에 하나씩 전체 너비로 */}
      <div className="stack">
        <TimeField label={isRide ? '승차 시각' : '관찰 시각'} value={v.boardTime} onChange={(x) => set('boardTime', x)} />
        {isRide && <TimeField label="하차 시각" value={v.alightTime} onChange={(x) => set('alightTime', x)} />}
      </div>

      {isSubway ? (
        <>
          <ChipGroup<Service>
            label="운행 종류"
            options={opts(SERVICE_LABEL)}
            value={v.service}
            onChange={(x) => set('service', x)}
          />
          <div className="grid2">
            <NumField label="칸" value={v.car} onChange={(x) => set('car', x)} min={1} max={12} na={na('car')} />
            <NumField label="문" value={v.door} onChange={(x) => set('door', x)} min={1} max={6} na={na('door')} />
          </div>
          <ChipGroup<Side> label="좌우" options={opts(SIDE_LABEL)} value={v.side} onChange={(x) => set('side', x)} />
          <label className="check block">
            <input type="checkbox" checked={na('side').on} onChange={(e) => na('side').toggle(e.target.checked)} />
            좌우 구분이 해당 없음
          </label>
        </>
      ) : (
        <>
          <ChipGroup<BusDoor> label="승차 문" options={opts(BUS_DOOR_LABEL)} value={v.busDoor} onChange={(x) => set('busDoor', x)} />
          <label className="check block">
            <input type="checkbox" checked={na('busDoor').on} onChange={(e) => na('busDoor').toggle(e.target.checked)} />
            승차 문이 해당 없음
          </label>
        </>
      )}

      <NumField label="대기 순서" value={v.waitOrder} onChange={(x) => set('waitOrder', x)} min={1} max={99} suffix="번째" na={na('waitOrder')} />

      {isRide && (
        <fieldset className="fieldset">
          <legend>좌석</legend>
          <ChipGroup<SeatState>
            label="탑승 시점 좌석"
            options={[
              { value: 'standing', label: '서서' },
              { value: 'seated', label: '앉아서' },
            ]}
            value={v.initialSeat}
            onChange={(x) => withSeat({ ...v, initialSeat: x }, events)}
            hint="모르면 비워 두세요. 좌석 정보가 없는 기록을 '서서 감'으로 보지 않습니다."
          />
          {v.initialSeat === 'standing' && (
            <MidSeat
              events={events}
              onChange={(next) => withSeat(v, next)}
              places={suggestSeatPlaces(history, historyEvents, { line: v.line, mode: v.mode })}
              known={knownStations(history, historyEvents)}
            />
          )}
          <div className="field-label">{v.initialSeat === 'standing' && findFirstSeated(events) >= 0 ? '그 밖의 좌석 변화' : '탑승 중 좌석 변화'}</div>
          {events.length === 0 && <div className="hint">기록된 변화가 없습니다.</div>}
          {events.map((e, i) =>
            v.initialSeat === 'standing' && i === findFirstSeated(events) ? null : (
              <div className="event-card" key={e.id ?? i} role="group" aria-label={`좌석 변화 ${i + 1}`}>
                <div className="row-between">
                  <strong>좌석 변화 {i + 1}</strong>
                  <button type="button" className="btn-text danger" onClick={() => setEvents(events.filter((_, j) => j !== i))} aria-label={`좌석 변화 ${i + 1} 삭제`}>
                    삭제
                  </button>
                </div>
                <TimeInput
                  label={`좌석 변화 ${i + 1} 시각`}
                  value={e.time}
                  onChange={(t) => setEvents(events.map((x, j) => (j === i ? { ...x, time: t } : x)))}
                  compact
                />
                <div className="grid2">
                  <select
                    aria-label={`좌석 변화 ${i + 1} 상태`}
                    value={e.state}
                    onChange={(ev) => setEvents(events.map((x, j) => (j === i ? { ...x, state: ev.target.value as SeatState } : x)))}
                  >
                    <option value="seated">착석</option>
                    <option value="standing">일어섬</option>
                  </select>
                  <input
                    type="text"
                    aria-label={`좌석 변화 ${i + 1} 역·정류장`}
                    placeholder="역·정류장 (선택)"
                    value={e.place ?? ''}
                    list="seat-places"
                    onChange={(ev) => setEvents(events.map((x, j) => (j === i ? { ...x, place: ev.target.value || null } : x)))}
                  />
                  <input
                    type="text"
                    aria-label={`좌석 변화 ${i + 1} 비고`}
                    placeholder="비고 (선택)"
                    value={e.note ?? ''}
                    onChange={(ev) => setEvents(events.map((x, j) => (j === i ? { ...x, note: ev.target.value || null } : x)))}
                  />
                </div>
              </div>
            ),
          )}
          <datalist id="seat-places">
            {knownStations(history, historyEvents).map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setEvents([...events, { time: null, state: events.at(-1)?.state === 'seated' ? 'standing' : 'seated', place: null }])}
          >
            + 좌석 변화 추가
          </button>
          <ChipGroup<'yes' | 'no'>
            label="좌석 변화 기록이 완결되었나요?"
            options={[
              { value: 'yes', label: '예, 더 없음' },
              { value: 'no', label: '아니오' },
            ]}
            value={v.seatLogComplete === null ? null : v.seatLogComplete ? 'yes' : 'no'}
            onChange={(x) => set('seatLogComplete', x === null ? null : x === 'yes')}
            hint="'예'일 때만 최종 착석 여부와 서서 이동 시간을 계산합니다. 이벤트나 탑승 시 좌석을 바꾸면 이 확인은 자동으로 해제되니 다시 확인해 주세요."
          />
        </fieldset>
      )}

      <ChipGroup<Crowding> label="혼잡도" options={opts(CROWDING_LABEL)} value={v.crowding} onChange={(x) => set('crowding', x)} />

      <div className="grid2">
        <NumField label="지연" value={v.delayMinutes} onChange={(x) => set('delayMinutes', x)} min={0} max={240} suffix="분" />
        <TextField label="지연·운행 특이사항" value={v.incident} onChange={(x) => set('incident', x)} placeholder="예: 안전 점검" />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="trip-note">
          비고
        </label>
        <textarea id="trip-note" rows={3} value={v.note ?? ''} onChange={(e) => set('note', e.target.value || null)} />
      </div>
    </div>
  )
}

export function FormBar(props: { children: ReactNode }) {
  return <div className="formbar">{props.children}</div>
}
