import { db as defaultDb, type TransitDB } from './db'
import { existingFingerprints, tripFingerprint } from './repo'
import { summarizeSeat, tripDuration } from '../domain/seat'
import {
  CROWDING_LABEL,
  KIND_LABEL,
  MODE_LABEL,
  PURPOSE_LABEL,
  SCHEMA_VERSION,
  SERVICE_LABEL,
  SIDE_LABEL,
  BUS_DOOR_LABEL,
  type DayLog,
  type RouteTemplate,
  type SeatEvent,
  type Setting,
  type Trip,
} from '../domain/types'

export interface BackupFile {
  app: 'TransitLog'
  schemaVersion: number
  exportedAt: string
  data: {
    trips: Trip[]
    seatEvents: SeatEvent[]
    days: DayLog[]
    templates: RouteTemplate[]
    settings: Setting[]
  }
}

export async function buildBackup(d: TransitDB = defaultDb): Promise<BackupFile> {
  const [trips, seatEvents, days, templates, settings] = await Promise.all([
    d.trips.toArray(),
    d.seatEvents.toArray(),
    d.days.toArray(),
    d.templates.toArray(),
    d.settings.toArray(),
  ])
  return {
    app: 'TransitLog',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: { trips, seatEvents, days, templates, settings },
  }
}

export interface BackupSummary {
  trips: number
  seatEvents: number
  days: number
  templates: number
  exportedAt: string
  schemaVersion: number
}

export type ParsedBackup =
  | { ok: true; backup: BackupFile; summary: BackupSummary }
  | { ok: false; error: string }

/** 백업 JSON 문자열을 검증하고 필요하면 스키마를 올린다 */
export function parseBackup(text: string): ParsedBackup {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'JSON 형식이 아닙니다. TransitLog 백업 파일(.json)을 선택해 주세요.' }
  }
  const b = json as Partial<BackupFile> | null
  if (!b || b.app !== 'TransitLog' || typeof b.schemaVersion !== 'number' || !b.data) {
    return { ok: false, error: 'TransitLog 백업 파일이 아닙니다.' }
  }
  if (b.schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `이 백업은 더 새로운 버전(v${b.schemaVersion})에서 만들어졌습니다. 앱을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.`,
    }
  }
  const data = migrateBackupData(b.data, b.schemaVersion)
  const bad = data.trips.find((t) => !t || typeof t.id !== 'string' || typeof t.date !== 'string' || !t.kind || !t.mode)
  if (bad) return { ok: false, error: '백업 파일의 일부 기록이 손상되었습니다. 복원을 중단했습니다.' }
  const backup: BackupFile = {
    app: 'TransitLog',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: b.exportedAt ?? '',
    data,
  }
  return {
    ok: true,
    backup,
    summary: {
      trips: data.trips.length,
      seatEvents: data.seatEvents.length,
      days: data.days.length,
      templates: data.templates.length,
      exportedAt: backup.exportedAt,
      schemaVersion: b.schemaVersion,
    },
  }
}

/** 이전 스키마 버전을 현재 형태로 올린다. 버전을 올릴 때 여기에 단계를 추가한다. */
function migrateBackupData(raw: Partial<BackupFile['data']>, _from: number): BackupFile['data'] {
  return {
    trips: raw.trips ?? [],
    seatEvents: raw.seatEvents ?? [],
    days: raw.days ?? [],
    templates: raw.templates ?? [],
    settings: raw.settings ?? [],
  }
}

export interface RestoreResult {
  addedTrips: number
  skippedTrips: number
  addedEvents: number
  addedDays: number
  filledDays: number
  addedTemplates: number
}

/**
 * 병합 복원 (기본): 기존 데이터는 지우거나 덮어쓰지 않는다.
 *  - 같은 id 이거나 같은 기록(날짜·시각·노선·장소)이면 건너뜀
 *  - 일지는 비어 있는 칸만 채움
 */
export async function restoreMerge(b: BackupFile, d: TransitDB = defaultDb): Promise<RestoreResult> {
  const res: RestoreResult = {
    addedTrips: 0,
    skippedTrips: 0,
    addedEvents: 0,
    addedDays: 0,
    filledDays: 0,
    addedTemplates: 0,
  }
  await d.transaction('rw', [d.trips, d.seatEvents, d.days, d.templates, d.settings], async () => {
    const fps = await existingFingerprints(d)
    const addedIds = new Set<string>()
    for (const t of b.data.trips) {
      const fp = tripFingerprint(t)
      if ((await d.trips.get(t.id)) || fps.has(fp)) {
        res.skippedTrips++
        continue
      }
      await d.trips.add(t)
      fps.add(fp)
      addedIds.add(t.id)
      res.addedTrips++
    }
    for (const e of b.data.seatEvents) {
      if (addedIds.has(e.tripId) && !(await d.seatEvents.get(e.id))) {
        await d.seatEvents.add(e)
        res.addedEvents++
      }
    }
    for (const day of b.data.days) {
      const cur = await d.days.get(day.date)
      if (!cur) {
        await d.days.add(day)
        res.addedDays++
      } else {
        const patch: Partial<DayLog> = {}
        for (const k of ['homeDepart', 'schoolDepart', 'schoolArrive', 'homeArrive', 'note'] as const) {
          if (cur[k] === null && day[k] !== null) patch[k] = day[k] as never
        }
        if (Object.keys(patch).length) {
          await d.days.put({ ...cur, ...patch, updatedAt: Date.now() })
          res.filledDays++
        }
      }
    }
    for (const t of b.data.templates) {
      if (!(await d.templates.get(t.id))) {
        await d.templates.add(t)
        res.addedTemplates++
      }
    }
    for (const s of b.data.settings) {
      if (!(await d.settings.get(s.key))) await d.settings.add(s)
    }
  })
  return res
}

/** 전체 교체 복원. 호출 전에 현재 데이터를 반드시 백업(다운로드)해야 한다. */
export async function restoreReplace(b: BackupFile, d: TransitDB = defaultDb): Promise<void> {
  await d.transaction('rw', [d.trips, d.seatEvents, d.days, d.templates, d.settings], async () => {
    await Promise.all([d.trips.clear(), d.seatEvents.clear(), d.days.clear(), d.templates.clear(), d.settings.clear()])
    await d.trips.bulkAdd(b.data.trips)
    await d.seatEvents.bulkAdd(b.data.seatEvents)
    await d.days.bulkAdd(b.data.days)
    await d.templates.bulkAdd(b.data.templates)
    await d.settings.bulkAdd(b.data.settings)
  })
}

export async function deleteAllData(d: TransitDB = defaultDb): Promise<void> {
  await d.transaction('rw', [d.trips, d.seatEvents, d.days, d.templates, d.settings], async () => {
    await Promise.all([d.trips.clear(), d.seatEvents.clear(), d.days.clear(), d.templates.clear(), d.settings.clear()])
  })
}

// ── CSV ──────────────────────────────────────────────────

const CSV_COLUMNS = [
  '날짜',
  '구분',
  '교통수단',
  '목적',
  '노선/버스번호',
  '승차 장소',
  '하차 장소',
  '승차 시각',
  '하차 시각',
  '소요 시간(분)',
  '열차 출발지',
  '행선지',
  '운행 종류',
  '칸',
  '문',
  '좌우',
  '버스 승차 문',
  '대기 순서',
  '탑승 시 좌석',
  '좌석 변화',
  '좌석 기록 완료',
  '즉시 착석',
  '한 번이라도 착석',
  '최종 착석',
  '착석까지(분)',
  '서서 이동(분)',
  '혼잡도',
  '지연(분)',
  '운행 특이사항',
  '비고',
]

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const yn = (v: boolean | null) => (v === null ? '' : v ? '예' : '아니오')

/** 빈 칸 = 미기록(알 수 없음). '해당 없음'은 'N/A'로 표시 */
export function tripsToCsv(trips: Trip[], events: SeatEvent[]): string {
  const byTrip = new Map<string, SeatEvent[]>()
  for (const e of events) byTrip.set(e.tripId, [...(byTrip.get(e.tripId) ?? []), e])
  const sorted = [...trips].sort((a, b) => a.date.localeCompare(b.date) || (a.boardTime ?? '99').localeCompare(b.boardTime ?? '99'))
  const rows = sorted.map((t) => {
    const evs = byTrip.get(t.id) ?? []
    const s = summarizeSeat(t, evs)
    const na = (k: (typeof t.naFields)[number], v: string | number | null) => (v === null && t.naFields.includes(k) ? 'N/A' : v)
    return [
      t.date,
      KIND_LABEL[t.kind],
      MODE_LABEL[t.mode],
      t.purpose ? PURPOSE_LABEL[t.purpose] : '',
      t.line,
      t.boardPlace,
      t.alightPlace,
      t.boardTime,
      t.alightTime,
      tripDuration(t),
      na('trainOrigin', t.trainOrigin),
      na('trainDestination', t.trainDestination),
      na('service', t.service ? SERVICE_LABEL[t.service] : null),
      na('car', t.car),
      na('door', t.door),
      na('side', t.side ? SIDE_LABEL[t.side] : null),
      na('busDoor', t.busDoor ? BUS_DOOR_LABEL[t.busDoor] : null),
      na('waitOrder', t.waitOrder),
      t.initialSeat === null ? '' : t.initialSeat === 'seated' ? '앉아서' : '서서',
      evs
        .map((e) => [e.time, e.place, e.state === 'seated' ? '착석' : '일어섬', e.note ? `(${e.note})` : ''].filter(Boolean).join(' '))
        .join('; '),
      t.seatLogComplete === null ? '' : t.seatLogComplete ? '예' : '아니오',
      yn(s.immediate),
      yn(s.everSeated),
      s.final === null ? '' : s.final === 'seated' ? '앉음' : '서 있음',
      s.minutesToFirstSeat,
      s.standingMinutes,
      t.crowding ? CROWDING_LABEL[t.crowding] : '',
      t.delayMinutes,
      t.incident,
      t.note,
    ].map(csvCell).join(',')
  })
  return '﻿' + [CSV_COLUMNS.join(','), ...rows].join('\r\n')
}

// ── 파일 저장 (브라우저) ──────────────────────────────────

export function backupFileName(prefix = 'transitlog-backup', ext = 'json'): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`
}

export function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 공유 시트(안드로이드의 '드라이브에 저장' 등)로 파일을 내보낸다. 지원하지 않으면 false */
export async function shareTextFile(filename: string, text: string, mime: string): Promise<boolean> {
  try {
    const file = new File([text], filename, { type: mime })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename })
      return true
    }
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return true
  }
  return false
}
