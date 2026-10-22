import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { getSetting, ongoingTrip, setSetting } from '../db/repo'

export function useAllTrips() {
  return useLiveQuery(() => db.trips.toArray(), [])
}
export function useAllEvents() {
  return useLiveQuery(() => db.seatEvents.toArray(), [])
}
export function useTemplates() {
  return useLiveQuery(() => db.templates.toArray(), [])
}
/** 로딩 중에는 undefined, 로딩 후에는 { trip } (탑승 중인 기록이 없으면 trip 이 undefined) */
export function useOngoing() {
  return useLiveQuery(async () => ({ trip: await ongoingTrip() }), [])
}
export function useDay(date: string) {
  return useLiveQuery(() => db.days.get(date), [date])
}
export function useTripsOn(date: string) {
  return useLiveQuery(() => db.trips.where('date').equals(date).toArray(), [date])
}
export function useTripEvents(tripId: string | undefined) {
  return useLiveQuery(
    () => (tripId ? db.seatEvents.where('tripId').equals(tripId).sortBy('createdAt') : []),
    [tripId],
  )
}

/** 일정 간격으로 현재 시각을 갱신 */
export function useNow(intervalMs = 20_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** IndexedDB 설정 값을 읽고 쓰는 훅. 로딩 중에는 fallback */
export function useSetting<T>(key: string, fallback: T): [T, (v: T) => void, boolean] {
  const row = useLiveQuery(() => db.settings.get(key), [key])
  const loaded = row !== undefined || false
  const value = row ? (row.value as T) : fallback
  return [value, (v: T) => void setSetting(key, v), loaded]
}

export function useLocalSetting<T>(key: string, fallback: T) {
  const [v, setV] = useState<T>(fallback)
  useEffect(() => {
    let alive = true
    void getSetting<T>(key, fallback).then((x) => alive && setV(x))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return [
    v,
    (x: T) => {
      setV(x)
      void setSetting(key, x)
    },
  ] as const
}

// ── 토스트 ──────────────────────────────────────────────
type ToastListener = (msg: string) => void
const toastListeners = new Set<ToastListener>()
export function toast(msg: string) {
  toastListeners.forEach((l) => l(msg))
}
export function useToastHost(): string | null {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const l: ToastListener = (m) => {
      setMsg(m)
      clearTimeout(timer)
      timer = setTimeout(() => setMsg(null), 2600)
    }
    toastListeners.add(l)
    return () => {
      toastListeners.delete(l)
      clearTimeout(timer)
    }
  }, [])
  return msg
}
