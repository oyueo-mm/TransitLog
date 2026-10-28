import { buildBackup } from '../db/backup'
import type { TransitDB } from '../db/db'
import { SCHEMA_VERSION } from '../domain/types'
import { DriveError, type DriveApi, type DriveFileMeta } from './drive'
import { conflictToRow, idOf, idOfKey, keyOf, localChangeCount, mergeStates, sig, tableOf } from './merge'
import {
  SYNC_FORMAT_VERSION,
  SYNC_TABLES,
  type ConfirmRequest,
  type MergeResult,
  type MergeStats,
  type RemoteDoc,
  type RemoteRecord,
  type SyncData,
  type SyncTable,
} from './types'

/**
 * 한 번의 동기화 실행 (저장소 + Drive 만 다루며 UI·인증 상태는 모른다).
 *
 *   Drive 파일 읽기 → 이 기기 기록·기준 사본 읽기 → 3-way 병합 → (필요하면 복구용 사본) → Drive 에 쓰기·읽어서 확인
 *   → 이 기기에 반영 + 기준 사본 갱신
 *
 * 이 기기를 바꾸는 단계는 Drive 쓰기가 확인된 뒤에만 일어나므로, 중간에 실패해도 어느 쪽 데이터도 줄어들지 않고
 * 다음 실행이 같은 병합을 다시 안전하게 수행한다.
 */

export type MetaKey = 'enabled' | 'auto' | 'lastOkAt' | 'deviceId' | 'accountEmail' | 'accountId' | 'initialized'

export async function getMeta<T>(db: TransitDB, key: MetaKey, fallback: T): Promise<T> {
  const row = await db.syncMeta.get(key)
  return row ? (row.value as T) : fallback
}
export async function setMeta(db: TransitDB, key: MetaKey, value: unknown): Promise<void> {
  await db.syncMeta.put({ key, value })
}

function newDeviceId(): string {
  const c = globalThis.crypto
  return c && typeof c.randomUUID === 'function' ? c.randomUUID() : 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

/** Dexie 훅이 '동기화가 쓴 변경'을 변경 알림에서 빼기 위한 표시 */
export const applyState = { applying: 0 }

export async function readLocal(db: TransitDB): Promise<Map<string, SyncData>> {
  const [trips, seatEvents, days, templates] = await Promise.all([db.trips.toArray(), db.seatEvents.toArray(), db.days.toArray(), db.templates.toArray()])
  const m = new Map<string, SyncData>()
  const add = (t: SyncTable, rows: unknown[]) => {
    for (const r of rows) {
      const d = r as SyncData
      m.set(keyOf(t, idOf(t, d)), d)
    }
  }
  add('trips', trips)
  add('seatEvents', seatEvents)
  add('days', days)
  add('templates', templates)
  return m
}

async function readBase(db: TransitDB): Promise<Map<string, SyncData>> {
  const rows = await db.syncBase.toArray()
  return new Map(rows.map((r) => [r.k, r.data]))
}

export function countByTable(keys: Iterable<string>): { trips: number; seatEvents: number; days: number; templates: number } {
  const c = { trips: 0, seatEvents: 0, days: 0, templates: 0 }
  for (const k of keys) c[tableOf(k)]++
  return c
}

// ── Drive 파일 해석 ─────────────────────────────────────

export class RemoteCorruptError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'RemoteCorruptError'
  }
}
export class RemoteTooNewError extends Error {
  constructor() {
    super('Drive 의 동기화 데이터가 더 새로운 버전의 앱에서 만들어졌습니다. 앱을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.')
    this.name = 'RemoteTooNewError'
  }
}

export function parseRemote(text: string): RemoteDoc {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new RemoteCorruptError('Drive 의 동기화 파일을 읽을 수 없습니다 (JSON 형식이 아님).')
  }
  const o = j as Partial<RemoteDoc> | null
  if (!o || o.app !== 'TransitLog' || o.kind !== 'sync' || typeof o.formatVersion !== 'number' || !o.records || typeof o.records !== 'object') {
    throw new RemoteCorruptError('Drive 의 파일이 TransitLog 동기화 파일이 아닙니다.')
  }
  if (o.formatVersion > SYNC_FORMAT_VERSION || (typeof o.schemaVersion === 'number' && o.schemaVersion > SCHEMA_VERSION)) throw new RemoteTooNewError()
  for (const [k, r] of Object.entries(o.records) as Array<[string, RemoteRecord]>) {
    const okTable = r && SYNC_TABLES.includes(r.table)
    const okId = okTable && typeof r.id === 'string' && keyOf(r.table, r.id) === k && r.k === k
    const okBody = okId && (r.deleted === true || (r.data && typeof r.data === 'object' && idOf(r.table, r.data) === r.id))
    if (!okBody) throw new RemoteCorruptError('Drive 파일의 일부 기록이 손상되었습니다.')
    if (r.table === 'seatEvents' && !r.deleted && typeof r.data?.tripId !== 'string') throw new RemoteCorruptError('Drive 파일의 일부 기록이 손상되었습니다.')
  }
  return o as RemoteDoc
}

// ── 실행 ────────────────────────────────────────────────

export interface RunOptions {
  /** 처음 연결 확인을 마침 */
  confirmFirst?: boolean
  /** 다른 계정으로 연결함을 확인함 */
  confirmAccount?: boolean
  /** 대량 삭제를 Drive 에 반영하는 것을 확인함 / 반영하지 않고 Drive 내용으로 되돌림 */
  bulkDelete?: 'apply' | 'revert'
  /** 손상된 Drive 파일을 이 기기 데이터로 다시 만드는 것을 확인함 */
  rebuildRemote?: boolean
  /** 아무것도 쓰지 않고 병합 요약만 계산 */
  dryRun?: boolean
}

export type SyncOutcome =
  | { kind: 'ok'; stats: MergeStats; conflicts: number; wrote: boolean; skipped: number }
  | { kind: 'confirm'; request: ConfirmRequest }

export interface EngineDeps {
  db: TransitDB
  drive: DriveApi
  now?: () => number
}

const MAX_ATTEMPTS = 4
const SNAPSHOTS_KEPT = 3
/** 이 건수 이상이면서 전체의 이 비율 이상을 한꺼번에 삭제하려 하면 사용자 확인을 받는다 */
const BULK_MIN = 10
const BULK_RATIO = 0.3

function bulkDeleteCount(r: MergeResult, liveCount: number): number {
  const n = Math.max(r.stats.pushedDeleted, r.stats.pulledDeleted)
  return n >= BULK_MIN && n >= liveCount * BULK_RATIO ? n : 0
}

export async function runSync(deps: EngineDeps, opts: RunOptions = {}): Promise<SyncOutcome> {
  const { db, drive } = deps
  const now = deps.now ?? Date.now
  let deviceId = await getMeta<string | null>(db, 'deviceId', null)
  if (!deviceId) {
    deviceId = newDeviceId()
    await setMeta(db, 'deviceId', deviceId)
  }

  // 1. 계정 확인: 처음이거나 다른 계정이면 사용자 확인 없이 기록을 올리지 않는다
  const who = await drive.about()
  const storedId = await getMeta<string | null>(db, 'accountId', null)
  const initialized = await getMeta<boolean>(db, 'initialized', false)
  const accountChanged = !!storedId && !!who.permissionId && storedId !== who.permissionId
  const needFirst = !initialized && !accountChanged
  const previousAccount = await getMeta<string | null>(db, 'accountEmail', null)

  let attempt = 0
  for (;;) {
    attempt++
    // 2. Drive 파일
    const files = await drive.list()
    const target: DriveFileMeta | undefined = files[0]
    let doc: RemoteDoc | null = null
    let version = ''
    if (target) {
      const r = await drive.read(target.id)
      version = r.version
      try {
        doc = parseRemote(r.text)
      } catch (e) {
        if (!(e instanceof RemoteCorruptError)) throw e
        if (!opts.rebuildRemote) return { kind: 'confirm', request: { kind: 'remote-corrupt', detail: e.message } }
        doc = null // 사용자가 확인한 경우에만 이 기기 데이터로 다시 만든다
      }
    }

    // 3. 병합
    const local = await readLocal(db)
    // 처음이거나 계정이 바뀌었다면 이전 기준은 쓰지 않는다 (이전 계정과의 기준을 새 계정에 적용하지 않기 위해)
    const base = accountChanged || !initialized ? new Map<string, SyncData>() : await readBase(db)
    if (opts.bulkDelete === 'revert') {
      // 삭제를 반영하지 않고 되돌린다: 이 기기에서 지운 기록은 Drive 의 것을 다시 받고,
      // 다른 기기가 지운 기록은 이 기기의 것을 남겨 다시 올린다 (기준을 버리면 '새 기록'으로 취급된다)
      for (const k of [...base.keys()]) {
        const rr = doc?.records[k]
        if (!local.has(k) || rr?.deleted) base.delete(k)
      }
    }
    const result = mergeStates({ local, remote: doc?.records ?? {}, base, now: now() })

    if ((needFirst || accountChanged) && !(needFirst ? opts.confirmFirst : opts.confirmAccount)) {
      return { kind: 'confirm', request: await describe(accountChanged ? 'account' : 'first', deps, result.stats, who.account, accountChanged ? previousAccount : null, local, doc) }
    }
    const liveRemote = Object.values(doc?.records ?? {}).filter((r) => !r.deleted).length
    const bulk = bulkDeleteCount(result, Math.max(liveRemote, local.size))
    if (bulk && !opts.bulkDelete) {
      const push = result.stats.pushedDeleted >= result.stats.pulledDeleted
      return { kind: 'confirm', request: { kind: 'bulk-delete', deleteCount: bulk, stats: result.stats, bulkDirection: push ? 'push' : 'pull' } }
    }
    if (opts.dryRun) return { kind: 'ok', stats: result.stats, conflicts: result.stats.conflicts, wrote: false, skipped: 0 }

    // 4. 이 기기의 기록이 바뀔 예정이면 먼저 복구용 사본을 남긴다
    if (localChangeCount(result) > 0 || needFirst || accountChanged) {
      await saveSnapshot(db, needFirst ? '처음 연결' : accountChanged ? '계정 변경' : '동기화', now())
    }

    // 5. Drive 에 쓰기 → 읽어서 확인
    let wrote = false
    if (result.remoteChanged || !target || doc === null) {
      const next: RemoteDoc = {
        app: 'TransitLog',
        kind: 'sync',
        formatVersion: SYNC_FORMAT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        revision: (doc?.revision ?? 0) + 1,
        writtenAt: new Date(now()).toISOString(),
        writtenBy: deviceId,
        records: result.remoteRecords,
      }
      const text = JSON.stringify(next)
      let fileId = target?.id
      try {
        if (target) await drive.update(target.id, text, version)
        else fileId = (await drive.create(text)).id
      } catch (e) {
        if (e instanceof DriveError && e.kind === 'conflict' && attempt < MAX_ATTEMPTS) continue
        throw e
      }
      const back = await drive.read(fileId!)
      if (back.text !== text) {
        // 쓰는 사이 다른 기기가 덮어썼다 → 처음부터 다시 병합 (이 기기의 기록은 아직 건드리지 않았다)
        if (attempt < MAX_ATTEMPTS) continue
        throw new DriveError('conflict', '다른 기기와 동시에 동기화하고 있습니다. 잠시 후 다시 시도합니다.')
      }
      wrote = true
      // 처음 파일을 만들 때 두 기기가 동시에 만들었다면 가장 오래된 파일만 남긴다
      if (!target) {
        const again = await drive.list()
        if (again.length > 1 && again[0].id !== fileId && attempt < MAX_ATTEMPTS) {
          await drive.remove(fileId!).catch(() => undefined)
          continue
        }
      }
    }

    // 6. 이 기기에 반영 + 기준 사본 갱신 (그 사이 사용자가 고친 기록은 건드리지 않는다)
    const skipped = await applyLocal(db, result, local, base, now(), accountChanged)
    await setMeta(db, 'lastOkAt', now())
    await setMeta(db, 'initialized', true)
    if (who.permissionId) await setMeta(db, 'accountId', who.permissionId)
    if (who.account) await setMeta(db, 'accountEmail', who.account)
    return { kind: 'ok', stats: result.stats, conflicts: result.conflicts.length, wrote, skipped }
  }
}

async function describe(
  kind: 'first' | 'account',
  deps: EngineDeps,
  stats: MergeStats,
  account: string | null,
  previousAccount: string | null,
  local?: Map<string, SyncData>,
  doc?: RemoteDoc | null,
): Promise<ConfirmRequest> {
  const l = local ?? (await readLocal(deps.db))
  return {
    kind,
    stats,
    account,
    previousAccount,
    localCounts: countByTable(l.keys()),
    remoteCounts: countByTable(Object.values(doc?.records ?? {}).filter((r) => !r.deleted).map((r) => r.k)),
  }
}

async function applyLocal(db: TransitDB, r: MergeResult, readAt: Map<string, SyncData>, base: Map<string, SyncData>, at: number, resetBase: boolean): Promise<number> {
  let skipped = 0
  applyState.applying++
  try {
    await db.transaction('rw', [db.trips, db.seatEvents, db.days, db.templates, db.syncBase, db.syncConflicts], async () => {
      const tbl = (t: SyncTable) => db[t] as unknown as { get(id: string): Promise<SyncData | undefined>; put(v: SyncData): Promise<unknown>; delete(id: string): Promise<void> }
      /** 읽은 뒤 다른 곳(사용자 입력)에서 바뀐 기록인지 */
      const changedMeanwhile = async (k: string): Promise<boolean> => {
        const t = tableOf(k)
        const cur = await tbl(t).get(idOfKey(k))
        const before = readAt.get(k)
        if (!cur || !before) return !!cur !== !!before
        return sig(t, cur) !== sig(t, before)
      }
      const skip = new Set<string>()
      if (resetBase) {
        await db.syncBase.clear()
        await db.syncConflicts.clear()
      }
      for (const [k, data] of r.localPut) {
        if (await changedMeanwhile(k)) {
          skip.add(k)
          skipped++
        } else await tbl(tableOf(k)).put(data)
      }
      for (const k of r.localDelete) {
        if (await changedMeanwhile(k)) {
          skip.add(k)
          skipped++
        } else await tbl(tableOf(k)).delete(idOfKey(k))
      }
      for (const [k, data] of r.nextBase) if (!skip.has(k)) await db.syncBase.put({ k, data })
      for (const k of base.keys()) if (!r.nextBase.has(k) && !skip.has(k)) await db.syncBase.delete(k)
      for (const c of r.conflicts) await db.syncConflicts.put(conflictToRow(c, at))
    })
  } finally {
    applyState.applying--
  }
  return skipped
}

export async function saveSnapshot(db: TransitDB, reason: string, at: number): Promise<void> {
  const b = await buildBackup(db)
  const counts = { trips: b.data.trips.length, seatEvents: b.data.seatEvents.length, days: b.data.days.length, templates: b.data.templates.length }
  await db.transaction('rw', db.syncSnapshots, async () => {
    await db.syncSnapshots.put({ id: `snap-${at}`, at, reason, json: JSON.stringify(b), counts })
    const all = await db.syncSnapshots.orderBy('id').toArray()
    const excess = all.sort((a, c) => a.at - c.at).slice(0, Math.max(0, all.length - SNAPSHOTS_KEPT))
    for (const s of excess) await db.syncSnapshots.delete(s.id)
  })
}

/** 연결 해제: 이 기기의 기록은 그대로 두고 동기화 상태(기준 사본·충돌·연결 정보)만 지운다 */
export async function clearSyncState(db: TransitDB): Promise<void> {
  await db.transaction('rw', [db.syncMeta, db.syncBase, db.syncConflicts], async () => {
    await db.syncBase.clear()
    await db.syncConflicts.clear()
    for (const k of ['enabled', 'lastOkAt', 'accountEmail', 'accountId', 'initialized'] as const) await db.syncMeta.delete(k)
  })
}
