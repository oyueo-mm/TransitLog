import { useId, useMemo, useState } from 'react'
import { rankedValues } from '../domain/recommend'
import { canonicalName, destLabel, formatTrainRoute, PRESET_LINES, sameStation } from '../domain/stations'
import {
  knownStations,
  knownTrainEnds,
  suggestStations,
  suggestTrainEnds,
  suggestTrainPairs,
  type PlaceSuggestion,
} from '../domain/suggest'
import type { Mode, Trip } from '../domain/types'
import { Chip } from './common'

/** 노선과 구간 입력에 필요한 값. 빠른 기록과 기록 수정 화면이 같은 컴포넌트를 쓴다 */
export interface RouteValue {
  mode: Mode
  line: string | null
  boardPlace: string | null
  alightPlace: string | null
  trainOrigin: string | null
  trainDestination: string | null
}

export interface NaControl {
  on: boolean
  toggle: (on: boolean) => void
}

export interface RoutePickerProps {
  value: RouteValue
  /** 추천·자동완성의 근거가 되는 과거 기록 */
  history: Trip[]
  historyEvents?: Array<{ tripId: string; place: string | null }>
  onChange: (patch: Partial<RouteValue>) => void
  /** 노선을 바꿀 때 이전 노선의 역·운행 구간을 비운다 (빠른 기록용. 기록 수정에서는 값을 지우지 않는다) */
  clearOnLineChange?: boolean
  showAlight?: boolean
  /** 직전 하차역 추천 (승차역 칩 맨 앞, 점선) */
  prevAlight?: string | null
  na?: { trainOrigin: NaControl; trainDestination: NaControl }
}

const CLEAR = { boardPlace: null, alightPlace: null, trainOrigin: null, trainDestination: null } as const

function SuggestChips(props: {
  label: string
  value: string | null
  items: PlaceSuggestion[]
  extra?: Array<{ value: string; label: string }>
  onPick: (v: string | null) => void
}) {
  const { value, items, extra = [] } = props
  const inList = value && [...items, ...extra].some((i) => sameStation(i.value, value))
  return (
    <div className="chips" role="group" aria-label={`${props.label} 추천`}>
      {value && !inList && (
        <Chip value={value} selected onSelect={() => props.onPick(null)}>
          {value}
        </Chip>
      )}
      {extra.map((e) => (
        <Chip key={`x-${e.value}`} value={e.value} selected={sameStation(value, e.value)} tone="suggest" onSelect={() => props.onPick(sameStation(value, e.value) ? null : e.value)}>
          {e.label}
        </Chip>
      ))}
      {items.map((s) => (
        <Chip key={s.value} value={s.value} selected={sameStation(value, s.value)} tone="suggest" onSelect={() => props.onPick(sameStation(value, s.value) ? null : s.value)}>
          {s.value}
        </Chip>
      ))}
    </div>
  )
}

function PlaceField(props: {
  label: string
  value: string | null
  items: PlaceSuggestion[]
  extra?: Array<{ value: string; label: string }>
  known: string[]
  onChange: (v: string | null) => void
  na?: NaControl
  recommended?: boolean
}) {
  const id = useId()
  const naOn = props.na?.on ?? false
  return (
    <div className="field" role="group" aria-label={props.label}>
      <div className="field-label">
        {props.label}
        {props.recommended && <span className="req">권장</span>}
        {naOn ? <span className="unrecorded na">해당 없음</span> : !props.value && <span className="unrecorded">미기록</span>}
        {props.na && (
          <label className="check inline">
            <input type="checkbox" checked={naOn} onChange={(e) => props.na!.toggle(e.target.checked)} />
            해당 없음
          </label>
        )}
      </div>
      {!naOn && (
        <>
          <SuggestChips label={props.label} value={props.value} items={props.items} extra={props.extra} onPick={props.onChange} />
          <input
            className="quick-input"
            type="text"
            aria-label={`${props.label} 직접 입력`}
            placeholder="검색·직접 입력"
            list={`${id}-list`}
            value={props.value ?? ''}
            onChange={(e) => props.onChange(e.target.value || null)}
            onBlur={(e) => {
              const c = canonicalName(e.target.value, props.known)
              if (c !== (props.value ?? null)) props.onChange(c)
            }}
            autoComplete="off"
            enterKeyHint="done"
          />
          <datalist id={`${id}-list`}>
            {props.known.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </>
      )}
    </div>
  )
}

export function RoutePicker(props: RoutePickerProps) {
  const { value: v, history, onChange } = props
  const idp = useId()
  const [otherOpen, setOtherOpen] = useState(false)
  const isBus = v.mode === 'bus'
  const showAlight = props.showAlight ?? true

  const isPreset = v.line !== null && PRESET_LINES.includes(v.line)
  const otherActive = !isBus && (otherOpen || (v.line !== null && !isPreset))

  const changeLine = (next: string | null) => {
    const changed = v.line !== null && next !== v.line
    onChange({ line: next, ...(props.clearOnLineChange && changed ? CLEAR : {}) })
  }

  const otherLines = useMemo(
    () => rankedValues(history, (t) => t.line, (t) => t.mode === v.mode && !PRESET_LINES.includes(t.line ?? ''), 8),
    [history, v.mode],
  )
  const knownLines = useMemo(() => [...new Set([...PRESET_LINES, ...history.filter((t) => t.mode === v.mode).map((t) => t.line).filter((x): x is string => !!x)])], [history, v.mode])

  const board = useMemo(
    () => suggestStations(history, { mode: v.mode, line: v.line, role: 'board' }),
    [history, v.mode, v.line],
  )
  const alight = useMemo(
    () => suggestStations(history, { mode: v.mode, line: v.line, role: 'alight', boardPlace: v.boardPlace, exclude: v.boardPlace }),
    [history, v.mode, v.line, v.boardPlace],
  )
  const origins = useMemo(() => suggestTrainEnds(history, { line: v.line, role: 'origin', boardPlace: v.boardPlace }), [history, v.line, v.boardPlace])
  const dests = useMemo(() => suggestTrainEnds(history, { line: v.line, role: 'destination', boardPlace: v.boardPlace }), [history, v.line, v.boardPlace])
  const pairs = useMemo(() => suggestTrainPairs(history, { line: v.line, boardPlace: v.boardPlace }), [history, v.line, v.boardPlace])
  const knownPlaces = useMemo(() => knownStations(history, props.historyEvents ?? []), [history, props.historyEvents])
  const knownEnds = useMemo(() => knownTrainEnds(history), [history])

  const placeLabel = isBus ? '정류장' : '역'
  const preview = formatTrainRoute(v.trainOrigin, v.trainDestination)
  const prevExtra = props.prevAlight ? [{ value: props.prevAlight, label: `직전 하차 · ${props.prevAlight}` }] : []

  return (
    <div className="routepicker">
      {/* 2. 노선 */}
      <div className="field">
        <div className="field-label">
          {isBus ? '버스 번호' : '노선'}
          <span className="req">권장</span>
          {!v.line && <span className="unrecorded">미기록</span>}
        </div>
        {isBus ? (
          <div role="group" aria-label="버스 번호 선택" className="chips">
            {rankedValues(history, (t) => t.line, (t) => t.mode === 'bus', 8).map((r) => (
              <Chip key={r.value} value={r.value} selected={v.line === r.value} tone="suggest" onSelect={() => changeLine(v.line === r.value ? null : r.value)}>
                {r.value}
              </Chip>
            ))}
          </div>
        ) : (
          <div className="seg cols4" role="group" aria-label="노선 선택">
            {PRESET_LINES.map((l) => (
              <button
                key={l}
                type="button"
                className={`seg-btn ${v.line === l ? 'is-on' : ''}`}
                aria-pressed={v.line === l}
                onClick={() => {
                  setOtherOpen(false)
                  changeLine(v.line === l ? null : l)
                }}
              >
                {l}
              </button>
            ))}
            <button
              type="button"
              className={`seg-btn ${otherActive ? 'is-on' : ''}`}
              aria-pressed={otherActive}
              onClick={() => {
                setOtherOpen(true)
                if (isPreset) changeLine(null)
              }}
            >
              기타
            </button>
          </div>
        )}
        {(isBus || otherActive) && (
          <>
            {!isBus && otherLines.length > 0 && (
              <div className="chips" role="group" aria-label="최근 쓴 다른 노선">
                {otherLines.map((r) => (
                  <Chip key={r.value} value={r.value} selected={v.line === r.value} tone="suggest" onSelect={() => changeLine(v.line === r.value ? null : r.value)}>
                    {r.value}
                  </Chip>
                ))}
              </div>
            )}
            <input
              className="quick-input"
              type="text"
              aria-label={isBus ? '버스 번호 직접 입력' : '노선 직접 입력'}
              placeholder={isBus ? '예: 1234 (검색·직접 입력)' : '예: 경춘선 (검색·직접 입력)'}
              list={`${idp}-lines`}
              value={isPreset ? '' : (v.line ?? '')}
              onChange={(e) => changeLine(e.target.value.trim() ? e.target.value : null)}
              autoComplete="off"
              enterKeyHint="done"
            />
            <datalist id={`${idp}-lines`}>
              {knownLines.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </>
        )}
      </div>

      {/* 3. 승차역 */}
      <PlaceField
        label={`승차${placeLabel}`}
        recommended
        value={v.boardPlace}
        items={board}
        extra={prevExtra}
        known={knownPlaces}
        onChange={(x) => onChange({ boardPlace: x })}
      />

      {/* 4. 하차역 */}
      {showAlight && (
        <PlaceField
          label={`하차${placeLabel}`}
          value={v.alightPlace}
          items={alight}
          known={knownPlaces}
          onChange={(x) => onChange({ alightPlace: x })}
        />
      )}

      {/* 5. 열차 운행 출발지·종착역 (승·하차역과 별개) */}
      {!isBus && (
        <fieldset className="fieldset train">
          <legend>열차 운행 정보 (선택)</legend>
          <p className="hint tight">타는 역이 아니라 <strong>열차 자체</strong>의 출발지와 종착역입니다. 모르면 비우거나 한쪽만 입력해도 됩니다.</p>
          {pairs.length > 0 && (
            <div className="field" role="group" aria-label="자주 쓴 운행 구간">
              <div className="field-label">자주 쓴 운행 구간</div>
              <div className="chips">
                {pairs.map((p) => {
                  const on = sameStation(p.origin, v.trainOrigin) && sameStation(p.destination, v.trainDestination) && (!!v.trainOrigin || !!v.trainDestination)
                  return (
                    <Chip
                      key={`${p.origin}>${p.destination}`}
                      value={`${p.origin}>${p.destination}`}
                      selected={on}
                      tone="suggest"
                      onSelect={() => onChange(on ? { trainOrigin: null, trainDestination: null } : { trainOrigin: p.origin, trainDestination: p.destination })}
                    >
                      {formatTrainRoute(p.origin, p.destination)}
                    </Chip>
                  )
                })}
              </div>
            </div>
          )}
          <PlaceField
            label="운행 출발지"
            value={v.trainOrigin}
            items={origins}
            known={knownEnds}
            na={props.na?.trainOrigin}
            onChange={(x) => onChange({ trainOrigin: x })}
          />
          <PlaceField
            label="종착역"
            value={v.trainDestination}
            items={dests}
            known={knownEnds}
            na={props.na?.trainDestination}
            onChange={(x) => onChange({ trainDestination: x })}
          />
          {preview && (
            <div className="route-preview" aria-live="polite">
              운행: <strong>{preview}</strong>
              {sameStation(v.trainOrigin, v.trainDestination) && v.trainOrigin && <span className="muted small"> (순환 운행)</span>}
            </div>
          )}
        </fieldset>
      )}
    </div>
  )
}

export { destLabel }
