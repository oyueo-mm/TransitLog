import { useEffect, useMemo, useState } from 'react'
import { getSetting, saveTrip, setSetting, startRide, touchTemplate } from '../db/repo'
import { suggestBoardFromPrevAlight, suggestPositions, suggestRoutes, type RouteSuggestion, type SuggestedFields } from '../domain/recommend'
import { canonicalName, formatTrainRoute } from '../domain/stations'
import { knownStations, suggestSeatPlaces } from '../domain/suggest'
import { nowHm, todayStr } from '../domain/time'
import {
  BUS_DOOR_LABEL,
  CROWDING_LABEL,
  MODE_LABEL,
  PURPOSE_LABEL,
  SERVICE_LABEL,
  SIDE_LABEL,
  emptyTripDraft,
  type BusDoor,
  type Crowding,
  type Mode,
  type Purpose,
  type SeatEventDraft,
  type SeatState,
  type Service,
  type Side,
} from '../domain/types'
import { Chip, ChipGroup, Section } from '../ui/common'
import { toast, useAllEvents, useAllTrips, useNow, useOngoing, useTemplates } from '../ui/hooks'
import { MidSeat } from '../ui/MidSeat'
import { TimeInput } from '../ui/TimeInput'
import { OngoingPanel } from './OngoingPanel'
import { RoutePicker, type RouteValue } from '../ui/RoutePicker'

type Route = SuggestedFields

const LAST_KEY = 'quick.last'

function pick(f: Route): Route {
  return {
    mode: f.mode,
    purpose: f.purpose ?? null,
    line: f.line ?? null,
    boardPlace: f.boardPlace ?? null,
    alightPlace: f.alightPlace ?? null,
    trainOrigin: f.trainOrigin ?? null,
    trainDestination: f.trainDestination ?? null,
    service: f.service ?? null,
    car: f.car ?? null,
    door: f.door ?? null,
    side: f.side ?? null,
    busDoor: f.busDoor ?? null,
  }
}

const toValue = (r: Route, mode: Mode): RouteValue => ({
  mode,
  line: r.line ?? null,
  boardPlace: r.boardPlace ?? null,
  alightPlace: r.alightPlace ?? null,
  trainOrigin: r.trainOrigin ?? null,
  trainDestination: r.trainDestination ?? null,
})

function routeLabelOf(r: Route): string {
  const stations = r.boardPlace || r.alightPlace ? `${r.boardPlace ?? '?'}→${r.alightPlace ?? '?'}` : null
  return [r.line, stations, formatTrainRoute(r.trainOrigin, r.trainDestination)].filter(Boolean).join(' ')
}

function StartPanel() {
  const trips = useAllTrips()
  const allEvents = useAllEvents()
  const templates = useTemplates()
  const now = useNow(30_000)
  const [mode, setMode] = useState<Mode>('subway')
  const [route, setRoute] = useState<Route>({ mode: 'subway' })
  const [initialSeat, setInitialSeat] = useState<SeatState | null>(null)
  const [events, setEvents] = useState<SeatEventDraft[]>([])
  const [crowding, setCrowding] = useState<Crowding | null>(null)
  const [waitOrder, setWaitOrder] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [timeOverride, setTimeOverride] = useState<string | null>(null)
  const [editTime, setEditTime] = useState(false)
  const [more, setMore] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [last, setLast] = useState<Route | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getSetting<Route | null>(LAST_KEY, null).then((l) => {
      if (l) {
        setLast(l)
      }
    })
  }, [])

  const all = useMemo(() => trips ?? [], [trips])
  const evs = useMemo(() => allEvents ?? [], [allEvents])
  const hm = nowHm()
  const suggestions = useMemo(() => {
    const list = suggestRoutes(all, templates ?? [], { now, nowHm: hm, mode }, 12)
    if (last && last.mode === mode) {
      const key = JSON.stringify(pick(last))
      if (!list.some((s) => JSON.stringify(pick(s.fields)) === key)) {
        list.unshift({ key: 'last', label: routeLabelOf(last) || '지난번 경로', fields: last, count: 0, score: 99, reasons: ['마지막 사용'] })
      }
    }
    // 노선을 골랐다면 그 노선의 경로만 보여 준다
    return (route.line ? list.filter((s) => !s.fields.line || s.fields.line === route.line) : list).slice(0, 5)
    // 분 단위 시각이 바뀌면 같은 시간대 추천을 갱신
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.length, templates, mode, hm, last, route.line])

  const line = route.line ?? null
  const boardPlace = route.boardPlace ?? null
  const prevAlight = suggestBoardFromPrevAlight(all, todayStr(), hm)
  const positions = mode === 'subway' ? suggestPositions(all, line, boardPlace, 4) : []
  const seatPlaces = useMemo(() => suggestSeatPlaces(all, evs, { line, mode }), [all, evs, line, mode])
  const known = useMemo(() => knownStations(all, evs), [all, evs])

  const patch = (p: Partial<Route>) => {
    setRoute((r) => ({ ...r, ...p }))
    setCopied(null)
  }
  const switchMode = (m: Mode) => {
    setMode(m)
    setRoute({ mode: m })
    setCopied(null)
  }
  const apply = (s: RouteSuggestion) => {
    setMode(s.fields.mode ?? mode)
    setRoute({ ...pick(s.fields), mode: s.fields.mode ?? mode })
    setCopied(s.label)
    if (s.templateId) void touchTemplate(s.templateId)
  }

  const buildDraft = () => ({
    ...emptyTripDraft(todayStr(), mode),
    purpose: (route.purpose ?? null) as Purpose | null,
    line: route.line ?? null,
    boardPlace: canonicalName(route.boardPlace, known),
    alightPlace: canonicalName(route.alightPlace, known),
    trainOrigin: mode === 'subway' ? (route.trainOrigin ?? null) : null,
    trainDestination: mode === 'subway' ? (route.trainDestination ?? null) : null,
    service: mode === 'subway' ? (route.service ?? null) : null,
    car: mode === 'subway' ? (route.car ?? null) : null,
    door: mode === 'subway' ? (route.door ?? null) : null,
    side: mode === 'subway' ? (route.side ?? null) : null,
    busDoor: mode === 'bus' ? (route.busDoor ?? null) : null,
    waitOrder,
    initialSeat,
    crowding,
    note: note.trim() || null,
    boardTime: timeOverride ?? nowHm(),
  })
  // 중간 착석은 '서서 탑승'일 때만 의미가 있다
  const eventsToSave = initialSeat === 'standing' ? events : []

  const reset = () => {
    setInitialSeat(null)
    setEvents([])
    setCrowding(null)
    setWaitOrder(null)
    setNote('')
    setTimeOverride(null)
    setEditTime(false)
  }

  const rememberLast = async () => {
    const r = pick({ ...route, alightPlace: null })
    await setSetting(LAST_KEY, r)
    setLast(r)
  }

  const start = async () => {
    setBusy(true)
    try {
      await startRide(buildDraft(), eventsToSave)
      await rememberLast()
      reset()
      toast('탑승을 시작했습니다')
    } finally {
      setBusy(false)
    }
  }
  const saveOnly = async () => {
    setBusy(true)
    try {
      await saveTrip({ ...buildDraft(), ongoing: false }, eventsToSave)
      await rememberLast()
      reset()
      toast('하차 기록 없이 저장했습니다')
    } finally {
      setBusy(false)
    }
  }

  const posSummary = [route.car != null || route.door != null ? `${route.car ?? '?'}-${route.door ?? '?'}` : null, route.side ? SIDE_LABEL[route.side] : null, waitOrder ? `${waitOrder}번째` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="page quick">
      <header className="page-head">
        <h1>빠른 기록</h1>
        <div className="muted">경로를 누르고 ‘지금 탑승’ · 점선 칩은 추천이며 눌러야 입력됩니다</div>
      </header>

      {/* 1. 지하철 / 버스 */}
      <div className="seg" role="group" aria-label="교통수단">
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <button key={m} className={`seg-btn ${mode === m ? 'is-on' : ''}`} aria-pressed={mode === m} onClick={() => switchMode(m)}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {suggestions.length > 0 && (
        <Section title="자주 타는 경로">
          <div className="chips">
            {suggestions.map((s) => (
              <button key={s.key} type="button" className={`chip route ${copied === s.label ? 'is-on' : ''}`} aria-pressed={copied === s.label} onClick={() => apply(s)}>
                <span>{s.label}</span>
                <small>{s.reasons.slice(0, 2).join(' · ')}</small>
              </button>
            ))}
          </div>
          {copied && (
            <p className="hint tight">
              ‘{copied}’의 경로·위치를 가져왔어요. 아래에서 바꿀 수 있고, <strong>좌석 상태와 혼잡도는 지금 상황을 직접 선택</strong>해 주세요.
            </p>
          )}
        </Section>
      )}

      {/* 2~5. 노선, 승차역, 하차역, 열차 운행 출발지·종착역 */}
      <Section title="경로">
        <RoutePicker
          value={toValue(route, mode)}
          history={all}
          historyEvents={evs}
          clearOnLineChange
          prevAlight={prevAlight}
          onChange={(p) => patch(p)}
        />
      </Section>

      {/* 6. 탑승 시각 */}
      <div className="field" role="group" aria-label="탑승 시각 설정">
        <div className="field-label">탑승 시각</div>
        {editTime ? (
          <>
            <TimeInput label="탑승 시각" value={timeOverride ?? hm} onChange={(t) => setTimeOverride(t)} clearable={false} hideLabel />
            <button type="button" className="btn-text" onClick={() => (setEditTime(false), setTimeOverride(null))}>
              지금으로
            </button>
          </>
        ) : (
          <div className="timerow">
            <strong>지금 ({hm})</strong>
            <button type="button" className="btn-text" onClick={() => (setEditTime(true), setTimeOverride(hm))}>
              수정
            </button>
          </div>
        )}
      </div>

      {/* 7. 칸·문, 좌우, 대기 순서 (필요할 때 펼치기) */}
      <button type="button" className="btn-text more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
        {more ? '위치·대기 순서 접기 ▲' : `위치·대기 순서 ${posSummary ? `(${posSummary}) ` : ''}펼치기 ▼`}
      </button>
      {more && (
        <Section>
          {mode === 'subway' ? (
            <>
              {positions.length > 0 && (
                <div className="field" role="group" aria-label="자주 탄 위치">
                  <div className="field-label">자주 탄 위치</div>
                  <div className="chips">
                    {positions.map((p) => {
                      const on = route.car === p.car && route.door === p.door && (route.side ?? null) === (p.side ?? null)
                      return (
                        <Chip key={`${p.car}-${p.door}-${p.side}`} value={`${p.car}-${p.door}`} selected={on} tone="suggest" onSelect={() => patch({ car: p.car, door: p.door, side: p.side })}>
                          {p.car}-{p.door}
                          {p.side ? ' ' + SIDE_LABEL[p.side] : ''}
                        </Chip>
                      )
                    })}
                  </div>
                </div>
              )}
              <div className="grid2">
                <div className="field">
                  <label className="field-label" htmlFor="q-car">
                    칸 {route.car == null && <span className="unrecorded">미기록</span>}
                  </label>
                  <input id="q-car" type="number" inputMode="numeric" min={1} max={12} value={route.car ?? ''} onChange={(e) => patch({ car: e.target.value ? Number(e.target.value) : null })} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="q-door">
                    문 {route.door == null && <span className="unrecorded">미기록</span>}
                  </label>
                  <input id="q-door" type="number" inputMode="numeric" min={1} max={6} value={route.door ?? ''} onChange={(e) => patch({ door: e.target.value ? Number(e.target.value) : null })} />
                </div>
              </div>
              <ChipGroup<Side>
                label="좌우 방향"
                options={(Object.keys(SIDE_LABEL) as Side[]).map((s) => ({ value: s, label: SIDE_LABEL[s] }))}
                value={route.side ?? null}
                onChange={(v) => patch({ side: v })}
              />
              <ChipGroup<Service>
                label="운행 종류"
                options={(Object.keys(SERVICE_LABEL) as Service[]).map((s) => ({ value: s, label: SERVICE_LABEL[s] }))}
                value={route.service ?? null}
                onChange={(v) => patch({ service: v })}
              />
            </>
          ) : (
            <ChipGroup<BusDoor>
              label="승차 문"
              options={(Object.keys(BUS_DOOR_LABEL) as BusDoor[]).map((s) => ({ value: s, label: BUS_DOOR_LABEL[s] }))}
              value={route.busDoor ?? null}
              onChange={(v) => patch({ busDoor: v })}
            />
          )}
          <ChipGroup<number>
            label="대기 순서"
            options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: `${n}번째` }))}
            value={waitOrder}
            onChange={setWaitOrder}
          />
          <ChipGroup<Purpose>
            label="목적"
            options={(Object.keys(PURPOSE_LABEL) as Purpose[]).map((p) => ({ value: p, label: PURPOSE_LABEL[p] }))}
            value={route.purpose ?? null}
            onChange={(v) => patch({ purpose: v })}
          />
        </Section>
      )}

      {/* 8~9. 좌석 상태와 중간 착석 */}
      <Section title="좌석">
        <ChipGroup<SeatState>
          label="지금 좌석 상태"
          options={[
            { value: 'standing', label: '서서 탑승' },
            { value: 'seated', label: '앉아서 탑승' },
          ]}
          value={initialSeat}
          onChange={setInitialSeat}
          hint="그때그때 직접 고른 값만 기록됩니다. 건너뛰면 ‘미기록’이에요."
        />
        {initialSeat === 'standing' && <MidSeat events={events} onChange={setEvents} places={seatPlaces} known={known} />}
      </Section>

      {/* 10. 혼잡도와 비고 */}
      <Section title="혼잡도·비고 (선택)">
        <ChipGroup<Crowding>
          label="혼잡도"
          options={(Object.keys(CROWDING_LABEL) as Crowding[]).map((c) => ({ value: c, label: CROWDING_LABEL[c] }))}
          value={crowding}
          onChange={setCrowding}
        />
        <div className="field">
          <label className="field-label" htmlFor="q-note">
            비고
          </label>
          <input id="q-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" enterKeyHint="done" />
        </div>
      </Section>

      {/* 11. 기록 저장 */}
      <div className="startbar">
        <button type="button" className="btn-primary big" onClick={start} disabled={busy}>
          지금 탑승
        </button>
        <button type="button" className="btn-text" onClick={saveOnly} disabled={busy}>
          하차 기록 없이 저장
        </button>
      </div>
    </div>
  )
}

export function QuickPage() {
  const ongoing = useOngoing()
  if (ongoing === undefined) return <div className="page"><p className="muted">불러오는 중…</p></div>
  return ongoing.trip ? <OngoingPanel trip={ongoing.trip} /> : <StartPanel />
}
