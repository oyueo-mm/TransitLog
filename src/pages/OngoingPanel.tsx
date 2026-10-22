import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../db/db'
import {
  addSeatEvent,
  captureSeatState,
  deleteSeatEvent,
  deleteTrip,
  endRide,
  restoreSeatState,
  setInitialSeat,
  updateSeatEvent,
  type SeatEventPatch,
} from '../db/repo'
import { orderEvents, summarizeSeat } from '../domain/seat'
import { currentSeat } from '../domain/seatLog'
import { canonicalName, destLabel, formatTrainRoute, sameStation } from '../domain/stations'
import { knownStations, suggestSeatPlaces, suggestStations } from '../domain/suggest'
import { diffMinutes, formatDuration, nowHm } from '../domain/time'
import { CROWDING_LABEL, type SeatEvent, type SeatState, type Trip } from '../domain/types'
import { Chip, ChipGroup, Section } from '../ui/common'
import { toast, useAllEvents, useAllTrips, useNow } from '../ui/hooks'
import { TimeInput } from '../ui/TimeInput'

const SEAT_LABEL: Record<SeatState, string> = { seated: '착석', standing: '일어섬' }

/** 이벤트 한 줄을 사람이 읽는 문장으로: '17:30 · 착석 · 수원역 (메모)' */
export function eventText(e: SeatEvent): string {
  return [e.time ?? '시각 미기록', SEAT_LABEL[e.state], e.place].filter(Boolean).join(' · ') + (e.note ? ` (${e.note})` : '')
}

/** 탑승 중 좌석 이벤트 하나를 바로 고치는 편집기 (상태·시각·역·비고) */
function EventEditor(props: {
  event: SeatEvent
  places: Array<{ value: string }>
  known: string[]
  onSave: (patch: SeatEventPatch) => void
  onCancel: () => void
}) {
  const { event: e } = props
  const [state, setState] = useState<SeatState>(e.state)
  const [time, setTime] = useState<string | null>(e.time)
  const [place, setPlace] = useState<string | null>(e.place)
  const [note, setNote] = useState<string>(e.note ?? '')
  return (
    <div className="event-edit" role="group" aria-label="좌석 변화 수정">
      <div className="seg" role="group" aria-label="좌석 상태">
        {(['seated', 'standing'] as SeatState[]).map((s) => (
          <button key={s} type="button" className={`seg-btn ${state === s ? 'is-on' : ''}`} aria-pressed={state === s} onClick={() => setState(s)}>
            {SEAT_LABEL[s]}
          </button>
        ))}
      </div>
      <TimeInput label="변경 시각" value={time} onChange={setTime} nowLabel="지금" />
      <div className="field" role="group" aria-label="변경 역·정류장">
        <div className="field-label">
          변경 역·정류장 {!place && <span className="unrecorded">미기록</span>}
        </div>
        <div className="chips">
          {place && !props.places.some((p) => sameStation(p.value, place)) && (
            <Chip value={place} selected onSelect={() => setPlace(null)}>
              {place}
            </Chip>
          )}
          {props.places.map((p) => (
            <Chip key={p.value} value={p.value} selected={sameStation(place, p.value)} tone="suggest" onSelect={() => setPlace(sameStation(place, p.value) ? null : p.value)}>
              {p.value}
            </Chip>
          ))}
        </div>
        <input
          className="quick-input"
          type="text"
          aria-label="변경 역·정류장 직접 입력"
          placeholder="다른 곳은 검색하거나 직접 입력"
          list="edit-known"
          value={place ?? ''}
          onChange={(ev) => setPlace(ev.target.value || null)}
          onBlur={(ev) => setPlace(canonicalName(ev.target.value, props.known))}
          autoComplete="off"
        />
        <datalist id="edit-known">
          {props.known.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="edit-note">
          비고 (선택)
        </label>
        <input id="edit-note" type="text" value={note} onChange={(ev) => setNote(ev.target.value)} autoComplete="off" />
      </div>
      <div className="grid2">
        <button type="button" className="btn-primary" onClick={() => props.onSave({ state, time, place: canonicalName(place, props.known), note: note.trim() || null })}>
          저장
        </button>
        <button type="button" className="btn-secondary" onClick={props.onCancel}>
          취소
        </button>
      </div>
    </div>
  )
}

export function OngoingPanel({ trip }: { trip: Trip }) {
  const allTrips = useAllTrips()
  const allEvents = useAllEvents()
  const now = useNow(15_000)
  const events = useMemo(() => (allEvents ?? []).filter((e) => e.tripId === trip.id).sort((a, b) => a.createdAt - b.createdAt), [allEvents, trip.id])
  const [alighting, setAlighting] = useState(false)
  const [alightPlace, setAlightPlace] = useState<string | null>(trip.alightPlace)
  const [alightTime, setAlightTime] = useState<string>(nowHm())
  const [complete, setComplete] = useState<boolean | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const busy = useRef(false)

  const hm = nowHm()
  void now
  const history = useMemo(() => allTrips ?? [], [allTrips])
  const elapsed = diffMinutes(trip.boardTime, hm)
  // 현재 좌석·첫 착석까지의 시간은 이벤트 목록에서 항상 다시 계산한다 (추가·수정·삭제 직후에도 일치)
  const cur = currentSeat(trip, events)
  const summary = summarizeSeat(trip, events)
  const shown = orderEvents(trip, events)
  const alightChips = suggestStations(history, { mode: trip.mode, line: trip.line, role: 'alight', boardPlace: trip.boardPlace, exclude: trip.boardPlace })
  const seatPlaces = suggestSeatPlaces(history, allEvents ?? [], { line: trip.line, mode: trip.mode, limit: 6 })
  const known = knownStations(history, allEvents ?? [])
  const lastEvent = shown[shown.length - 1]
  const lastNoPlace = lastEvent && !lastEvent.place ? lastEvent : undefined

  /**
   * 좌석 관련 변경은 모두 이 함수를 거친다.
   *  - 처리 중에는 다음 요청을 받지 않는다(버튼 연타 방지)
   *  - 바꾸기 전 상태를 저장해 두었다가 '실행 취소'로 되돌릴 수 있게 한다
   *  - 결과가 null 이면(이미 같은 상태 등 중복 요청) 아무 일도 하지 않는다
   */
  const mutate = async (message: string, fn: () => Promise<unknown>) => {
    if (busy.current) return
    busy.current = true
    try {
      const snap = await captureSeatState(trip.id)
      const result = await fn()
      if (result === null) return
      toast(message, snap ? { label: '실행 취소', run: () => restoreSeatState(snap) } : undefined)
    } finally {
      busy.current = false
    }
  }

  const seat = (state: SeatState) =>
    mutate(state === 'seated' ? '착석을 기록했습니다' : '일어섬을 기록했습니다', () => addSeatEvent(trip.id, { time: nowHm(), state, place: null, note: null }))
  const finish = async () => {
    await endRide(trip.id, {
      alightPlace: canonicalName(alightPlace, known),
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
  const route = formatTrainRoute(trip.trainOrigin, trip.trainDestination)

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
          {route ? <span> · {route}</span> : trip.trainDestination ? <span> · {destLabel(trip.trainDestination)}</span> : null}
        </div>
        <div className="card-sub" data-testid="current-seat">
          현재 좌석: {cur === null ? <span className="muted">미기록</span> : cur === 'seated' ? '앉아 있음' : '서 있음'}
          {trip.crowding && <span className={`badge crowd-${trip.crowding}`}>{CROWDING_LABEL[trip.crowding]}</span>}
        </div>
        {summary.minutesToFirstSeat !== null && (
          <div className="seat-summary" data-testid="first-seat">
            서서 탄 뒤 첫 착석까지 {summary.minutesToFirstSeat}분
          </div>
        )}
      </div>

      {!alighting ? (
        <div className="actions-col">
          {cur === null && (
            <div className="field" role="group" aria-label="탑승 시 좌석 상태 지정">
              <div className="field-label">
                탑승 시 좌석 상태 <span className="unrecorded">미기록</span>
              </div>
              <div className="chips">
                <Chip value="standing" selected={false} onSelect={() => void mutate('서서 탑승으로 기록했습니다', async () => setInitialSeat(trip.id, 'standing'))}>
                  서서 탑승
                </Chip>
                <Chip value="seated" selected={false} onSelect={() => void mutate('앉아서 탑승으로 기록했습니다', async () => setInitialSeat(trip.id, 'seated'))}>
                  앉아서 탑승
                </Chip>
              </div>
            </div>
          )}
          {/* 지금 할 수 있는 동작을 강조: 서 있으면 '앉았다', 앉아 있으면 '일어섰다' */}
          <div className="grid2">
            <button className={`${cur === 'standing' ? 'btn-primary' : 'btn-secondary'} big`} onClick={() => void seat('seated')} disabled={cur === 'seated'}>
              앉았다
            </button>
            <button className={`${cur === 'seated' ? 'btn-primary' : 'btn-secondary'} big`} onClick={() => void seat('standing')} disabled={cur === 'standing'}>
              일어섰다
            </button>
          </div>
          <button className="btn-primary big" onClick={() => (setAlightTime(nowHm()), setAlightPlace(trip.alightPlace), setAlighting(true))}>
            하차
          </button>
        </div>
      ) : (
        <Section title="하차 기록">
          <div className="field" role="group" aria-label={trip.mode === 'subway' ? '하차역' : '하차 정류장'}>
            <div className="field-label">
              {trip.mode === 'subway' ? '하차역' : '하차 정류장'}
              {!alightPlace && <span className="unrecorded">미기록</span>}
            </div>
            <div className="chips">
              {alightPlace && !alightChips.some((c) => sameStation(c.value, alightPlace)) && (
                <Chip value={alightPlace} selected onSelect={() => setAlightPlace(null)}>
                  {alightPlace}
                </Chip>
              )}
              {alightChips.map((c) => (
                <Chip key={c.value} value={c.value} selected={sameStation(alightPlace, c.value)} tone="suggest" onSelect={(v) => setAlightPlace(sameStation(alightPlace, v) ? null : v)}>
                  {c.value}
                </Chip>
              ))}
            </div>
            <input
              className="quick-input"
              type="text"
              aria-label="하차 장소"
              placeholder="다른 곳은 검색하거나 직접 입력"
              list="alight-known"
              value={alightPlace ?? ''}
              onChange={(e) => setAlightPlace(e.target.value || null)}
              autoComplete="off"
            />
            <datalist id="alight-known">
              {known.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </div>
          <TimeInput label="하차 시각" value={alightTime} onChange={(t) => t && setAlightTime(t)} clearable={false} nowLabel="지금" />
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

      <Section title="좌석 변화 내역" className="events-section">
        {shown.length === 0 && <p className="muted">좌석 변화 기록이 없습니다. <span className="unrecorded">기록 없음</span></p>}
        {shown.length > 0 && (
          <ul className="event-list" aria-label="좌석 변화 내역">
            {shown.map((e) =>
              editingId === e.id ? (
                <li key={e.id} className="event-item" style={{ display: 'block' }}>
                  <EventEditor
                    event={e}
                    places={seatPlaces}
                    known={known}
                    onCancel={() => setEditingId(null)}
                    onSave={(patch) => {
                      setEditingId(null)
                      void mutate('좌석 변화를 수정했습니다', () => updateSeatEvent(e.id, patch))
                    }}
                  />
                </li>
              ) : (
                <li key={e.id} className="event-item">
                  <span className="ev-text">{eventText(e)}</span>
                  <span className="ev-actions">
                    <button type="button" className="btn-text" aria-label={`${eventText(e)} 수정`} onClick={() => setEditingId(e.id)}>
                      수정
                    </button>
                    <button
                      type="button"
                      className="btn-text danger"
                      aria-label={`${eventText(e)} 삭제`}
                      onClick={() => void mutate('좌석 변화를 삭제했습니다', () => deleteSeatEvent(e.id))}
                    >
                      삭제
                    </button>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
      </Section>

      {lastNoPlace && editingId === null && (
        <Section title="어느 역에서요? (선택)">
          <div className="chips">
            {seatPlaces.map((r) => (
              <Chip key={r.value} value={r.value} selected={false} tone="suggest" onSelect={(v) => void db.seatEvents.update(lastNoPlace.id, { place: v })}>
                {r.value}
              </Chip>
            ))}
          </div>
          <input
            className="quick-input"
            type="text"
            aria-label="착석한 역 직접 입력"
            placeholder="다른 곳은 직접 입력 후 확인"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.currentTarget.value.trim()) void db.seatEvents.update(lastNoPlace.id, { place: canonicalName(e.currentTarget.value, known) })
            }}
          />
        </Section>
      )}


      {!alighting && (
        <div className="row-links">
            <Link className="btn-text" to={`/trip/${trip.id}`}>
              상세 수정
            </Link>
            <button className="btn-text danger" onClick={cancel}>
              이 탑승 삭제
            </button>
          </div>
      )}
    </div>
  )
}
