import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import { db } from '../db/db'
import { deleteTrip, saveTemplate, saveTrip, templateFromTrip, defaultTemplateName } from '../db/repo'
import { emptyTripDraft, type SeatEventDraft, type Trip, type TripDraft } from '../domain/types'
import { todayStr } from '../domain/time'
import { TripForm } from '../ui/TripForm'
import { toast, useAllEvents, useAllTrips } from '../ui/hooks'

function draftFrom(t: Trip): TripDraft {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, createdAt, updatedAt, ...rest } = t
  return rest
}

/** 이전 기록을 템플릿 삼아 새 기록을 만든다. 장소·행선지·위치는 복사하되 그 순간의 관측값(좌석·혼잡도·대기·시각)은 비운다 */
export function cloneAsTemplate(t: Trip, date: string): TripDraft {
  return {
    ...emptyTripDraft(date, t.mode),
    purpose: t.purpose,
    line: t.line,
    boardPlace: t.boardPlace,
    alightPlace: t.alightPlace,
    trainOrigin: t.trainOrigin,
    trainDestination: t.trainDestination,
    service: t.service,
    car: t.car,
    door: t.door,
    side: t.side,
    busDoor: t.busDoor,
    naFields: t.naFields.filter((k) => k !== 'waitOrder'),
  }
}

export function TripEditorPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const trips = useAllTrips()
  const isNew = !id
  const [draft, setDraft] = useState<TripDraft | null>(null)
  const [events, setEvents] = useState<SeatEventDraft[]>([])
  const [existing, setExisting] = useState<Trip | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (id) {
        const t = await db.trips.get(id)
        if (!alive) return
        if (!t) return setError('기록을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.')
        const evs = await db.seatEvents.where('tripId').equals(id).sortBy('createdAt')
        if (!alive) return
        setExisting(t)
        setDraft(draftFrom(t))
        setEvents(evs.map((e) => ({ time: e.time, state: e.state, place: e.place })))
      } else {
        const date = sp.get('date') ?? todayStr()
        const copy = sp.get('copy')
        if (copy) {
          const src = await db.trips.get(copy)
          if (src && alive) return setDraft(cloneAsTemplate(src, date))
        }
        if (alive) setDraft(emptyTripDraft(date))
      }
    })()
    return () => {
      alive = false
    }
  }, [id, sp])

  const events$ = useAllEvents()

  if (error) {
    return (
      <div className="page">
        <p className="notice error">{error}</p>
        <Link to="/">홈으로</Link>
      </div>
    )
  }
  if (!draft) return <div className="page"><p className="muted">불러오는 중…</p></div>

  const save = async () => {
    setSaving(true)
    try {
      const base = existing ? { ...existing, ...draft } : draft
      const saved = await saveTrip(base as Trip | TripDraft, draft.kind === 'ride' ? events : [])
      toast('저장했습니다')
      nav(`/day/${saved.date}`, { replace: true })
    } catch (e) {
      setError(`저장하지 못했습니다: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!existing) return
    if (!window.confirm('이 기록을 삭제할까요? 삭제한 기록은 되돌릴 수 없습니다. (백업 파일이 있다면 복원할 수 있습니다)')) return
    await deleteTrip(existing.id)
    toast('삭제했습니다')
    nav(`/day/${existing.date}`, { replace: true })
  }

  const asTemplate = async () => {
    if (!existing) return
    const name = window.prompt('경로 템플릿 이름', defaultTemplateName(existing))
    if (name === null) return
    await saveTemplate(templateFromTrip({ ...existing, ...draft } as Trip, name))
    toast('빠른 기록 경로로 저장했습니다')
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>{isNew ? '기록 추가' : '기록 수정'}</h1>
      </header>
      <TripForm value={draft} events={events} onChange={(d, e) => (setDraft(d), setEvents(e))} history={trips ?? []} historyEvents={events$ ?? []} />
      <div className="formbar">
        <button className="btn-primary" onClick={save} disabled={saving}>
          저장
        </button>
        <button className="btn-secondary" onClick={() => nav(-1)}>
          취소
        </button>
      </div>
      {existing && (
        <div className="extra-actions">
          <Link className="btn-secondary" to={`/trip/new?date=${todayStr()}&copy=${existing.id}`}>
            이 기록으로 새 기록 만들기
          </Link>
          <button className="btn-secondary" onClick={asTemplate}>
            빠른 기록 경로로 저장
          </button>
          <button className="btn-danger" onClick={remove}>
            기록 삭제
          </button>
        </div>
      )}
    </div>
  )
}
