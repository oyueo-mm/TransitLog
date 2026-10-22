import { db as defaultDb, type TransitDB } from '../db/db'
import { existingFingerprints, newId, normalizeTrip, tripFingerprint } from '../db/repo'
import type { BackupFile } from '../db/backup'
import { SCHEMA_VERSION, type DayLog, type SeatEvent, type Trip } from '../domain/types'
import type { ImportCandidate, ImportDay, ParseResult } from './parser'

export interface ImportSummary {
  total: number
  confirmed: number
  review: number
  rides: number
  missed: number
  observed: number
  duplicates: number
  selected: number
  /** 필드별 누락(미기록) 건수 — 실제 탑승 기록 기준 */
  missingByField: Record<string, number>
  unknownMarks: number
  days: number
  dateCount: number
  unattached: number
}

export function summarize(p: ParseResult | { candidates: ImportCandidate[]; days: ImportDay[]; unattached: unknown[]; dateCount: number }): ImportSummary {
  const c = p.candidates
  const missingByField: Record<string, number> = {}
  for (const x of c) for (const m of x.missing) missingByField[m] = (missingByField[m] ?? 0) + 1
  return {
    total: c.length,
    confirmed: c.filter((x) => x.status === 'confirmed').length,
    review: c.filter((x) => x.status === 'review').length,
    rides: c.filter((x) => x.trip.kind === 'ride').length,
    missed: c.filter((x) => x.trip.kind === 'missed').length,
    observed: c.filter((x) => x.trip.kind === 'observed').length,
    duplicates: c.filter((x) => x.duplicate !== 'none').length,
    selected: c.filter((x) => x.selected && x.duplicate === 'none').length,
    missingByField,
    unknownMarks: c.reduce((n, x) => n + x.unknownMarks, 0),
    days: p.days.filter((d) => Object.values(d.patch).some((v) => v)).length,
    dateCount: p.dateCount,
    unattached: p.unattached.length,
  }
}

function toRecords(candidates: ImportCandidate[]) {
  const trips: Trip[] = []
  const seatEvents: SeatEvent[] = []
  const now = Date.now()
  candidates.forEach((c, i) => {
    const id = newId()
    const trip = normalizeTrip({
      ...c.trip,
      importKey: tripFingerprint(c.trip),
      id,
      createdAt: now + i,
      updatedAt: now + i,
    })
    trips.push(trip)
    c.seatEvents.forEach((e, j) => seatEvents.push({ ...e, id: newId(), tripId: id, createdAt: now + i + j * 0.001 }))
  })
  return { trips, seatEvents }
}

function toDays(days: ImportDay[]): DayLog[] {
  const now = Date.now()
  return days
    .filter((d) => Object.values(d.patch).some((v) => v))
    .map((d) => ({
      date: d.date,
      homeDepart: d.patch.homeDepart ?? null,
      schoolDepart: d.patch.schoolDepart ?? null,
      schoolArrive: d.patch.schoolArrive ?? null,
      homeArrive: d.patch.homeArrive ?? null,
      note: null,
      updatedAt: now,
    }))
}

/** 로컬 스크립트용: 가져오기 결과를 복원 가능한 백업 JSON 구조로 만든다 */
export function candidatesToBackup(p: ParseResult, opts: { onlyConfirmed?: boolean } = {}): BackupFile {
  const list = p.candidates.filter((c) => c.duplicate === 'none' && c.selected && (!opts.onlyConfirmed || c.status === 'confirmed'))
  const { trips, seatEvents } = toRecords(list)
  return {
    app: 'TransitLog',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: { trips, seatEvents, days: toDays(p.days), templates: [], settings: [] },
  }
}

/** 기존 기록과 겹치는 후보에 표시한다 (저장 전 미리보기에서 호출) */
export async function markDuplicates(candidates: ImportCandidate[], d: TransitDB = defaultDb): Promise<void> {
  const existing = await existingFingerprints(d)
  for (const c of candidates) {
    if (c.duplicate === 'in-file') continue
    if (existing.has(tripFingerprint(c.trip))) {
      c.duplicate = 'existing'
      c.selected = false
    } else if (c.duplicate === 'existing') {
      c.duplicate = 'none'
    }
  }
}

export interface CommitResult {
  added: number
  skippedDuplicates: number
  daysFilled: number
}

/**
 * 사용자가 최종 승인한 후보만 저장한다. 기존 기록은 건드리지 않고,
 * 저장 직전에 한 번 더 중복을 확인한다. 일지는 비어 있는 칸만 채운다.
 */
export async function commitCandidates(
  candidates: ImportCandidate[],
  days: ImportDay[],
  d: TransitDB = defaultDb,
): Promise<CommitResult> {
  const res: CommitResult = { added: 0, skippedDuplicates: 0, daysFilled: 0 }
  await d.transaction('rw', [d.trips, d.seatEvents, d.days], async () => {
    const fps = await existingFingerprints(d)
    const chosen: ImportCandidate[] = []
    for (const c of candidates) {
      if (!c.selected) continue
      const fp = tripFingerprint(c.trip)
      if (fps.has(fp)) {
        res.skippedDuplicates++
        continue
      }
      fps.add(fp)
      chosen.push(c)
    }
    const { trips, seatEvents } = toRecords(chosen)
    await d.trips.bulkAdd(trips)
    await d.seatEvents.bulkAdd(seatEvents)
    res.added = trips.length

    for (const day of toDays(days)) {
      const cur = await d.days.get(day.date)
      if (!cur) {
        await d.days.add(day)
        res.daysFilled++
      } else {
        const patch: Partial<DayLog> = {}
        for (const k of ['homeDepart', 'schoolDepart', 'schoolArrive', 'homeArrive'] as const) {
          if (cur[k] === null && day[k] !== null) patch[k] = day[k]
        }
        if (Object.keys(patch).length) {
          await d.days.put({ ...cur, ...patch, updatedAt: Date.now() })
          res.daysFilled++
        }
      }
    }
  })
  return res
}
