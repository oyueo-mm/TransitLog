import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../db/db'
import {
  addSeatEvent,
  deleteTrip,
  endRide,
  getSetting,
  saveTrip,
  setSetting,
  startRide,
  touchTemplate,
} from '../db/repo'
import { orderEvents } from '../domain/seat'
import {
  rankedValues,
  suggestBoardFromPrevAlight,
  suggestPositions,
  suggestRoutes,
  type RouteSuggestion,
  type SuggestedFields,
} from '../domain/recommend'
import { diffMinutes, formatDuration, nowHm, todayStr } from '../domain/time'
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
  type SeatEvent,
  type SeatState,
  type Service,
  type Side,
  type Trip,
} from '../domain/types'
import { Chip, ChipGroup, Section, destLabel } from '../ui/common'
import { toast, useAllEvents, useAllTrips, useNow, useOngoing, useTemplates } from '../ui/hooks'

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

function QuickText(props: { label: string; value: string | null; onChange: (v: string | null) => void; placeholder?: string }) {
  return (
    <input
      className="quick-input"
      type="text"
      aria-label={props.label}
      placeholder={props.placeholder ?? `${props.label} 직접 입력`}
      value={props.value ?? ''}
      onChange={(e) => props.onChange(e.target.value || null)}
      autoComplete="off"
      enterKeyHint="done"
    />
  )
}

function ChipRow<T extends string>(props: {
  label: string
  items: Array<{ value: T; label?: string; suggest?: boolean }>
  value: string | null
  onPick: (v: T) => void
  children?: React.ReactNode
}) {
  return (
    <div className="field" role="group" aria-label={props.label}>
      <div className="field-label">
        {props.label}
        {!props.value && <span className="unrecorded">미기록</span>}
      </div>
      <div className="chips">
        {props.items.map((i) => (
          <Chip key={i.value} value={i.value} selected={props.value === i.value} onSelect={props.onPick} tone={i.suggest ? 'suggest' : 'default'}>
            {i.label ?? i.value}
          </Chip>
        ))}
      </div>
      {props.children}
    </div>
  )
}

function StartPanel() {
  const trips = useAllTrips()
  const templates = useTemplates()
  const now = useNow(30_000)
  const [mode, setMode] = useState<Mode>('subway')
  const [route, setRoute] = useState<Route>({ mode: 'subway' })
  const [initialSeat, setInitialSeat] = useState<SeatState | null>(null)
  const [crowding, setCrowding] = useState<Crowding | null>(null)
  const [waitOrder, setWaitOrder] = useState<number | null>(null)
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
        setMode(l.mode ?? 'subway')
        setRoute((r) => ({ ...r, mode: l.mode ?? 'subway' }))
      }
    })
  }, [])

  const all = trips ?? []
  const hm = nowHm()
  const suggestions = useMemo(() => {
    const list = suggestRoutes(all, templates ?? [], { now, nowHm: hm, mode }, 5)
    if (last && last.mode === mode) {
      const key = JSON.stringify(pick(last))
      if (!list.some((s) => JSON.stringify(pick(s.fields)) === key)) {
        const label = [last.line, last.boardPlace && last.alightPlace ? `${last.boardPlace}→${last.alightPlace}` : last.boardPlace, last.trainDestination ? destLabel(last.trainDestination) : null]
          .filter(Boolean)
          .join(' ')
        list.unshift({ key: 'last', label: label || '지난번 경로', fields: last, count: 0, score: 99, reasons: ['마지막 사용'] })
      }
    }
    return list.slice(0, 5)
    // 분 단위 시각이 바뀌면 같은 시간대 추천을 갱신
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.length, templates, mode, hm, last])

  const line = route.line ?? null
  const boardPlace = route.boardPlace ?? null
  const byMode = (t: Trip) => t.mode === mode
  const lineChips = rankedValues(all, (t) => t.line, byMode, 6)
  const prevAlight = suggestBoardFromPrevAlight(all, todayStr(), hm)
  const placeChips = rankedValues(all, (t) => t.boardPlace, (t) => byMode(t) && (!line || t.line === line), 6)
  const destChips = rankedValues(all, (t) => t.trainDestination, (t) => t.mode === 'subway' && (!line || t.line === line) && (!boardPlace || t.boardPlace === boardPlace), 6)
  const positions = mode === 'subway' ? suggestPositions(all, line, boardPlace, 4) : []

  const update = (patch: Partial<Route>) => {
    setRoute((r) => ({ ...r, ...patch }))
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
    boardPlace: route.boardPlace ?? null,
    alightPlace: null,
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
    boardTime: timeOverride ?? nowHm(),
  })

  const rememberLast = async () => {
    const r = pick({ ...route, alightPlace: null })
    await setSetting(LAST_KEY, r)
    setLast(r)
  }

  const start = async () => {
    setBusy(true)
    try {
      await startRide(buildDraft())
      await rememberLast()
      setInitialSeat(null)
      setCrowding(null)
      setWaitOrder(null)
      setTimeOverride(null)
      setEditTime(false)
      toast('탑승을 시작했습니다')
    } finally {
      setBusy(false)
    }
  }
  const saveOnly = async () => {
    setBusy(true)
    try {
      await saveTrip({ ...buildDraft(), ongoing: false })
      await rememberLast()
      toast('하차 기록 없이 저장했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page quick">
      <header className="page-head">
        <h1>빠른 기록</h1>
        <div className="muted">자주 타는 경로를 누르고 ‘지금 탑승’</div>
      </header>

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

      <Section title="탑승">
        <ChipRow
          label={mode === 'subway' ? '노선' : '버스 번호'}
          items={lineChips.map((r) => ({ value: r.value }))}
          value={line}
          onPick={(v) => update({ line: line === v ? null : v })}
        >
          <QuickText label={mode === 'subway' ? '노선' : '버스 번호'} value={line} onChange={(v) => update({ line: v })} />
        </ChipRow>

        <ChipRow
          label={mode === 'subway' ? '승차역' : '승차 정류장'}
          items={[
            ...(prevAlight ? [{ value: prevAlight, label: `직전 하차 · ${prevAlight}`, suggest: true }] : []),
            ...placeChips.filter((r) => r.value !== prevAlight).map((r) => ({ value: r.value })),
          ]}
          value={boardPlace}
          onPick={(v) => update({ boardPlace: boardPlace === v ? null : v })}
        >
          <QuickText label={mode === 'subway' ? '승차역' : '승차 정류장'} value={boardPlace} onChange={(v) => update({ boardPlace: v })} />
        </ChipRow>

        {mode === 'subway' && (
          <ChipRow
            label="행선지"
            items={destChips.map((r) => ({ value: r.value, label: destLabel(r.value) }))}
            value={route.trainDestination ?? null}
            onPick={(v) => update({ trainDestination: route.trainDestination === v ? null : v })}
          >
            <QuickText label="행선지" value={route.trainDestination ?? null} onChange={(v) => update({ trainDestination: v })} placeholder="행선지 직접 입력 (행 제외)" />
          </ChipRow>
        )}

        <ChipGroup<SeatState>
          label="지금 좌석 상태"
          options={[
            { value: 'standing', label: '서서' },
            { value: 'seated', label: '앉아서' },
          ]}
          value={initialSeat}
          onChange={setInitialSeat}
          hint="그때그때 직접 고른 값만 기록됩니다. 건너뛰면 ‘미기록’이에요."
        />
        <ChipGroup<Crowding>
          label="혼잡도"
          options={(Object.keys(CROWDING_LABEL) as Crowding[]).map((c) => ({ value: c, label: CROWDING_LABEL[c] }))}
          value={crowding}
          onChange={setCrowding}
        />
      </Section>

      <button type="button" className="btn-text more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
        {more ? '상세 입력 접기 ▲' : '상세 입력 펼치기 ▼ (칸·문·좌우·대기 순서…)'}
      </button>
      {more && (
        <Section>
          {mode === 'subway' ? (
            <>
              {positions.length > 0 && (
                <ChipRow
                  label="자주 탄 위치"
                  items={positions.map((p) => ({
                    value: `${p.car}-${p.door}-${p.side ?? ''}`,
                    label: `${p.car}-${p.door}${p.side ? ' ' + SIDE_LABEL[p.side] : ''}`,
                    suggest: true,
                  }))}
                  value={route.car !== null && route.car !== undefined ? `${route.car}-${route.door}-${route.side ?? ''}` : null}
                  onPick={(v) => {
                    const p = positions.find((x) => `${x.car}-${x.door}-${x.side ?? ''}` === v)
                    if (p) update({ car: p.car, door: p.door, side: p.side })
                  }}
                />
              )}
              <div className="grid2">
                <div className="field">
                  <label className="field-label" htmlFor="q-car">
                    칸
                    {route.car == null && <span className="unrecorded">미기록</span>}
                  </label>
                  <input id="q-car" type="number" inputMode="numeric" min={1} max={12} value={route.car ?? ''} onChange={(e) => update({ car: e.target.value ? Number(e.target.value) : null })} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="q-door">
                    문
                    {route.door == null && <span className="unrecorded">미기록</span>}
                  </label>
                  <input id="q-door" type="number" inputMode="numeric" min={1} max={6} value={route.door ?? ''} onChange={(e) => update({ door: e.target.value ? Number(e.target.value) : null })} />
                </div>
              </div>
              <ChipGroup<Side>
                label="좌우"
                options={(Object.keys(SIDE_LABEL) as Side[]).map((s) => ({ value: s, label: SIDE_LABEL[s] }))}
                value={route.side ?? null}
                onChange={(v) => update({ side: v })}
              />
              <ChipGroup<Service>
                label="운행 종류"
                options={(Object.keys(SERVICE_LABEL) as Service[]).map((s) => ({ value: s, label: SERVICE_LABEL[s] }))}
                value={route.service ?? null}
                onChange={(v) => update({ service: v })}
              />
            </>
          ) : (
            <ChipGroup<BusDoor>
              label="승차 문"
              options={(Object.keys(BUS_DOOR_LABEL) as BusDoor[]).map((s) => ({ value: s, label: BUS_DOOR_LABEL[s] }))}
              value={route.busDoor ?? null}
              onChange={(v) => update({ busDoor: v })}
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
            onChange={(v) => update({ purpose: v })}
          />
        </Section>
      )}

      <div className="startbar">
        <div className="timerow">
          <span>승차 시각</span>
          {editTime ? (
            <>
              <input type="time" aria-label="승차 시각" value={timeOverride ?? hm} onChange={(e) => setTimeOverride(e.target.value || null)} />
              <button type="button" className="btn-text" onClick={() => (setEditTime(false), setTimeOverride(null))}>
                지금으로
              </button>
            </>
          ) : (
            <>
              <strong>지금 ({hm})</strong>
              <button type="button" className="btn-text" onClick={() => (setEditTime(true), setTimeOverride(hm))}>
                수정
              </button>
            </>
          )}
        </div>
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

function currentSeat(trip: Trip, events: SeatEvent[]): SeatState | null {
  const o = orderEvents(trip, events)
  return o.length ? o[o.length - 1].state : trip.initialSeat
}

function OngoingPanel({ trip }: { trip: Trip }) {
  const allTrips = useAllTrips()
  const allEvents = useAllEvents()
  const now = useNow(15_000)
  const events = useMemo(() => (allEvents ?? []).filter((e) => e.tripId === trip.id).sort((a, b) => a.createdAt - b.createdAt), [allEvents, trip.id])
  const [alighting, setAlighting] = useState(false)
  const [alightPlace, setAlightPlace] = useState<string | null>(null)
  const [alightTime, setAlightTime] = useState<string>(nowHm())
  const [complete, setComplete] = useState<boolean | null>(null)

  const hm = nowHm()
  void now
  const elapsed = diffMinutes(trip.boardTime, hm)
  const cur = currentSeat(trip, events)
  const places = rankedValues(allTrips ?? [], (t) => t.alightPlace, (t) => t.mode === trip.mode && (!trip.line || t.line === trip.line), 6)
  const lastNoPlace = [...events].reverse().find((e) => !e.place)
  const lastEvent = events[events.length - 1]
  const placeChips = rankedValues(allTrips ?? [], (t) => t.alightPlace ?? t.boardPlace, (t) => t.mode === trip.mode && (!trip.line || t.line === trip.line), 5)

  const seat = async (state: SeatState) => {
    await addSeatEvent(trip.id, { time: nowHm(), state, place: null })
    toast(state === 'seated' ? '착석을 기록했습니다' : '일어섬을 기록했습니다')
  }
  const finish = async () => {
    await endRide(trip.id, {
      alightPlace,
      alightTime,
      ...(complete !== null ? { seatLogComplete: complete } : {}),
    })
    setAlighting(false)
    toast('하차를 기록했습니다')
  }
  const cancel = async () => {
    if (!window.confirm('이 탑승 기록을 삭제할까요?')) return
    await deleteTrip(trip.id)
    toast('삭제했습니다')
  }

  return (
    <div className="page quick">
      <header className="page-head">
        <h1>탑승 중</h1>
        <div className="muted">
          {trip.boardTime}에 탑승 · {elapsed !== null ? formatDuration(elapsed) : ''} 경과
        </div>
      </header>

      <div className="card big-card">
        <div className="card-main">
          <strong>{trip.line ?? (trip.mode === 'subway' ? '노선 미기록' : '버스 번호 미기록')}</strong>
          {trip.boardPlace && <span> · {trip.boardPlace}</span>}
          {trip.trainDestination && <span> · {destLabel(trip.trainDestination)}</span>}
        </div>
        <div className="card-sub">
          현재 좌석: {cur === null ? <span className="muted">미기록</span> : cur === 'seated' ? '앉아 있음' : '서 있음'}
          {trip.crowding && <span className={`badge crowd-${trip.crowding}`}>{CROWDING_LABEL[trip.crowding]}</span>}
        </div>
        {events.length > 0 && (
          <ul className="event-list">
            {events.map((e) => (
              <li key={e.id}>
                {e.time} {e.place ?? ''} {e.state === 'seated' ? '착석' : '일어섬'}
              </li>
            ))}
          </ul>
        )}
      </div>

      {lastNoPlace && lastNoPlace.id === lastEvent?.id && placeChips.length > 0 && (
        <Section title="어느 역에서요? (선택)">
          <div className="chips">
            {placeChips.map((r) => (
              <Chip key={r.value} value={r.value} selected={false} onSelect={(v) => void db.seatEvents.update(lastNoPlace.id, { place: v })}>
                {r.value}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {!alighting ? (
        <div className="actions-col">
          <div className="grid2">
            <button className="btn-secondary big" onClick={() => seat('seated')} disabled={cur === 'seated'}>
              앉았다
            </button>
            <button className="btn-secondary big" onClick={() => seat('standing')} disabled={cur === 'standing'}>
              일어섰다
            </button>
          </div>
          <button className="btn-primary big" onClick={() => (setAlightTime(nowHm()), setAlighting(true))}>
            하차
          </button>
          <div className="row-links">
            <Link to={`/trip/${trip.id}`}>상세 수정</Link>
            <button className="btn-text danger" onClick={cancel}>
              이 탑승 삭제
            </button>
          </div>
        </div>
      ) : (
        <Section title="하차 기록">
          <ChipRow
            label={trip.mode === 'subway' ? '하차역' : '하차 정류장'}
            items={places.map((r) => ({ value: r.value }))}
            value={alightPlace}
            onPick={(v) => setAlightPlace(alightPlace === v ? null : v)}
          >
            <QuickText label="하차 장소" value={alightPlace} onChange={setAlightPlace} />
          </ChipRow>
          <div className="field">
            <label className="field-label" htmlFor="alight-time">
              하차 시각
            </label>
            <input id="alight-time" type="time" value={alightTime} onChange={(e) => setAlightTime(e.target.value)} />
          </div>
          {trip.initialSeat !== null && (
            <ChipGroup<'yes' | 'no'>
              label="탑승 중 좌석 변화를 모두 기록했나요?"
              options={[
                { value: 'yes', label: '예, 더 없음' },
                { value: 'no', label: '아니오' },
              ]}
              value={complete === null ? null : complete ? 'yes' : 'no'}
              onChange={(v) => setComplete(v === null ? null : v === 'yes')}
              hint="‘예’를 고르면 최종 착석 여부와 서서 이동 시간을 계산합니다. 모르면 비워 두세요."
            />
          )}
          <div className="grid2">
            <button className="btn-primary" onClick={finish}>
              하차 완료
            </button>
            <button className="btn-secondary" onClick={() => setAlighting(false)}>
              취소
            </button>
          </div>
        </Section>
      )}
    </div>
  )
}

export function QuickPage() {
  const ongoing = useOngoing()
  if (ongoing === undefined) return <div className="page"><p className="muted">불러오는 중…</p></div>
  return ongoing.trip ? <OngoingPanel trip={ongoing.trip} /> : <StartPanel />
}
