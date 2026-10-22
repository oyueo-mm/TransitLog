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
import { ChipGroup } from './common'

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
  const id = useId()
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {props.label}
        {!props.value && <span className="unrecorded">미기록</span>}
      </label>
      <div className="field-row">
        <input id={id} type="time" value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value || null)} />
        {props.value && (
          <button type="button" className="btn-text" onClick={() => props.onChange(null)}>
            지우기
          </button>
        )}
      </div>
    </div>
  )
}

export interface TripFormProps {
  value: Draft
  events: SeatEventDraft[]
  onChange: (value: Draft, events: SeatEventDraft[]) => void
  suggestions?: { lines?: string[]; places?: string[]; destinations?: string[] }
  /** 가져오기 미리보기에서는 날짜를 고정 */
  lockDate?: boolean
}

export function TripForm({ value: v, events, onChange, suggestions, lockDate }: TripFormProps) {
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
  const setEvents = (next: SeatEventDraft[]) => onChange({ ...v, seatLogComplete: next.length !== events.length ? null : v.seatLogComplete }, next)
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

      <div className="grid2">
        <TimeField label={isRide ? '승차 시각' : '관찰 시각'} value={v.boardTime} onChange={(x) => set('boardTime', x)} />
        {isRide && <TimeField label="하차 시각" value={v.alightTime} onChange={(x) => set('alightTime', x)} />}
      </div>

      <TextField
        label={isSubway ? '노선' : '버스 번호'}
        value={v.line}
        onChange={(x) => set('line', x)}
        placeholder={isSubway ? '예: 1호선' : '예: 1234'}
        list={suggestions?.lines}
      />
      <div className="grid2">
        <TextField label={isSubway ? '승차역' : '승차 정류장'} value={v.boardPlace} onChange={(x) => set('boardPlace', x)} list={suggestions?.places} />
        {isRide && (
          <TextField label={isSubway ? '하차역' : '하차 정류장'} value={v.alightPlace} onChange={(x) => set('alightPlace', x)} list={suggestions?.places} />
        )}
      </div>

      {isSubway ? (
        <>
          <div className="grid2">
            <TextField label="열차 출발지" value={v.trainOrigin} onChange={(x) => set('trainOrigin', x)} na={na('trainOrigin')} list={suggestions?.places} />
            <TextField
              label="행선지"
              value={v.trainDestination}
              onChange={(x) => set('trainDestination', x)}
              placeholder="예: 종착역 (행 제외)"
              na={na('trainDestination')}
              list={suggestions?.destinations}
            />
          </div>
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
            onChange={(x) => set('initialSeat', x)}
            hint="모르면 비워 두세요. 좌석 정보가 없는 기록을 '서서 감'으로 보지 않습니다."
          />
          <div className="field-label">탑승 중 좌석 변화</div>
          {events.length === 0 && <div className="hint">기록된 변화가 없습니다.</div>}
          {events.map((e, i) => (
            <div className="event-row" key={i}>
              <input
                type="time"
                aria-label={`좌석 변화 ${i + 1} 시각`}
                value={e.time ?? ''}
                onChange={(ev) => setEvents(events.map((x, j) => (j === i ? { ...x, time: ev.target.value || null } : x)))}
              />
              <input
                type="text"
                aria-label={`좌석 변화 ${i + 1} 역·정류장`}
                placeholder="역·정류장 (선택)"
                value={e.place ?? ''}
                list="seat-places"
                onChange={(ev) => setEvents(events.map((x, j) => (j === i ? { ...x, place: ev.target.value || null } : x)))}
              />
              <select
                aria-label={`좌석 변화 ${i + 1} 상태`}
                value={e.state}
                onChange={(ev) => setEvents(events.map((x, j) => (j === i ? { ...x, state: ev.target.value as SeatState } : x)))}
              >
                <option value="seated">착석</option>
                <option value="standing">일어섬</option>
              </select>
              <button type="button" className="btn-text danger" onClick={() => setEvents(events.filter((_, j) => j !== i))} aria-label={`좌석 변화 ${i + 1} 삭제`}>
                삭제
              </button>
            </div>
          ))}
          <datalist id="seat-places">
            {(suggestions?.places ?? []).map((p) => (
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
            hint="'예'일 때만 최종 착석 여부와 서서 이동 시간을 계산합니다."
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
