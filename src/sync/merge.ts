import type {
  ConflictField,
  MergeResult,
  MergeStats,
  RemoteRecord,
  SyncConflict,
  SyncData,
  SyncTable,
} from './types'

/**
 * 3-way 병합 (순수 함수 — 저장소·네트워크를 만지지 않는다).
 *
 * 입력은 세 가지 상태다.
 *   local  : 지금 이 기기의 기록
 *   remote : Drive 파일의 기록 (삭제는 묘비)
 *   base   : 마지막 동기화에서 양쪽이 같았던 사본 (처음이면 비어 있음)
 *
 * 기록마다 base 와 비교해 '누가 바꿨는지'를 판단하므로 시각 비교로 한쪽을 덮어쓰지 않는다.
 *   - 한쪽만 바꿨다 → 그 변경을 따른다
 *   - 둘 다 다른 필드를 바꿨다 → 필드별로 합친다
 *   - 같은 필드를 서로 다르게 바꿨다 → 한쪽을 남기되 밀려난 값을 충돌로 보존해 사용자가 되돌릴 수 있다
 *   - 한쪽은 삭제, 한쪽은 수정 → 삭제하지 않고 수정본을 남긴다 (데이터 보존 우선)
 *   - Drive 에서 기록이 사라졌지만 삭제 표시(묘비)가 없다 → 삭제가 아니라 유실로 보고 다시 올린다
 */

export function keyOf(table: SyncTable, id: string): string {
  return `${table}:${id}`
}
export function tableOf(k: string): SyncTable {
  return k.slice(0, k.indexOf(':')) as SyncTable
}
export function idOfKey(k: string): string {
  return k.slice(k.indexOf(':') + 1)
}
export function idOf(table: SyncTable, data: SyncData): string {
  return String(table === 'days' ? data.date : data.id)
}

/** 변경으로 보지 않는 필드: 같은 내용을 다시 저장하면 바뀌는 값들 */
const VOLATILE: Record<SyncTable, string[]> = {
  trips: ['updatedAt'],
  seatEvents: ['createdAt'],
  days: ['updatedAt'],
  templates: ['useCount', 'lastUsedAt'],
}
const MAX_FIELDS = new Set(['updatedAt', 'useCount', 'lastUsedAt'])
const MIN_FIELDS = new Set(['createdAt'])

export function stable(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`
}

/** 내용 서명: 휘발성 필드를 뺀 안정 직렬화. 같으면 같은 기록이다 */
export function sig(table: SyncTable, data: SyncData): string {
  const skip = new Set(VOLATILE[table])
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(data)) if (!skip.has(k)) o[k] = data[k]
  return stable(o)
}

export function tsOf(table: SyncTable, data: SyncData): number {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (table === 'templates') return n(data.lastUsedAt) || n(data.createdAt)
  if (table === 'seatEvents') return n(data.createdAt)
  return n(data.updatedAt)
}

export function labelOf(table: SyncTable, data: SyncData): string {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : '')
  if (table === 'trips') return [s(data.date), s(data.boardTime), s(data.line), s(data.boardPlace)].filter(Boolean).join(' ') || '탑승 기록'
  if (table === 'seatEvents') return ['좌석 변화', s(data.time), s(data.place)].filter(Boolean).join(' ')
  if (table === 'days') return `${s(data.date)} 하루 기록`
  return s(data.name) || '경로 템플릿'
}

const eq = (a: unknown, b: unknown) => stable(a) === stable(b)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

interface FieldMerge {
  data: SyncData
  fields: ConflictField[]
  /** 한쪽에만 있던 변경을 합쳤는지(충돌 없이) */
  changed: boolean
}

function mergeFields(L: SyncData, R: SyncData, B: SyncData | undefined, tsL: number, tsR: number): FieldMerge {
  const names = new Set([...Object.keys(L), ...Object.keys(R), ...(B ? Object.keys(B) : [])])
  const out: SyncData = {}
  const fields: ConflictField[] = []
  const keepLocalOnTie = (lv: unknown, rv: unknown) => (tsL !== tsR ? tsL > tsR : stable(lv) >= stable(rv))
  for (const n of [...names].sort()) {
    const lv = L[n]
    const rv = R[n]
    if (MAX_FIELDS.has(n) || MIN_FIELDS.has(n)) {
      const a = num(lv)
      const b = num(rv)
      out[n] = a === null ? rv : b === null ? lv : MAX_FIELDS.has(n) ? Math.max(a, b) : Math.min(a, b)
      continue
    }
    if (eq(lv, rv)) out[n] = lv
    else if (B && eq(lv, B[n])) out[n] = rv
    else if (B && eq(rv, B[n])) out[n] = lv
    else {
      const kept = keepLocalOnTie(lv, rv) ? 'local' : 'remote'
      out[n] = kept === 'local' ? lv : rv
      fields.push({ name: n, local: lv ?? null, remote: rv ?? null, kept })
    }
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return { data: out, fields, changed: true }
}

export interface MergeInput {
  local: Map<string, SyncData>
  remote: Record<string, RemoteRecord>
  base: Map<string, SyncData>
  now: number
}

export const emptyStats = (): MergeStats => ({
  pulledNew: 0,
  pulledChanged: 0,
  pulledDeleted: 0,
  pushedNew: 0,
  pushedChanged: 0,
  pushedDeleted: 0,
  unchanged: 0,
  deduped: 0,
  conflicts: 0,
})

type Fin = { live: SyncData } | { deleted: true }

/** 탑승 한 건의 '내용' 서명 (식별자·시각 메타 제외) — 완전히 같은 중복을 찾는 데 쓴다 */
function tripContentKey(trip: SyncData, events: SyncData[]): string {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = trip
  const evs = events
    .map((e) => {
      const { id: _i, tripId: _t, createdAt: _ca, ...r } = e
      return stable(r)
    })
    .sort()
  return stable(rest) + '#' + evs.join('|')
}

export function mergeStates(input: MergeInput): MergeResult {
  const { local, remote, base, now } = input
  const stats = emptyStats()
  const conflicts: MergeResult['conflicts'] = []
  const fin = new Map<string, Fin>()
  /** 이 기록을 Drive 에 새로 써야 하는지 */
  const push = new Set<string>()
  /** 이 기기의 기록을 바꿔야 하는지 (put/delete) */
  const pull = new Set<string>()

  const keys = new Set<string>([...local.keys(), ...base.keys(), ...Object.keys(remote)])
  const parentTs = (side: 'local' | 'remote', tripId: unknown): number => {
    const k = keyOf('trips', String(tripId))
    if (side === 'local') {
      const t = local.get(k)
      return t ? tsOf('trips', t) : 0
    }
    const r = remote[k]
    return r && !r.deleted && r.data ? tsOf('trips', r.data) : 0
  }

  for (const k of keys) {
    const table = tableOf(k)
    const L = local.get(k)
    const B = base.get(k)
    const Rr = remote[k]
    const R = Rr && !Rr.deleted ? Rr.data : undefined
    const sL = L ? sig(table, L) : null
    const sB = B ? sig(table, B) : null
    const sR = R ? sig(table, R) : null

    if (!Rr) {
      // Drive 에 없음: 새 기록이거나(또는 경합으로 유실) → 올린다. 삭제는 반드시 묘비로만 전달된다
      if (L) {
        fin.set(k, { live: L })
        push.add(k)
        if (B) stats.pushedChanged++
        else stats.pushedNew++
      } else if (B) {
        fin.set(k, { deleted: true })
        push.add(k)
        stats.pushedDeleted++
      }
      continue
    }

    if (Rr.deleted) {
      if (!L) {
        fin.set(k, { deleted: true })
      } else if (B && sL === sB) {
        // 이 기기에서는 마지막 동기화 뒤 바뀌지 않았고 다른 기기가 삭제했다 → 삭제를 따른다
        fin.set(k, { deleted: true })
        pull.add(k)
        stats.pulledDeleted++
      } else {
        // 삭제됐지만 이 기기에서 수정했거나(또는 삭제 뒤 같은 식별자로 다시 복원했다) → 지우지 않고 되살린다
        fin.set(k, { live: L })
        push.add(k)
        stats.pushedChanged++
        if (B) {
          conflicts.push({ k, table, recordId: idOfKey(k), kind: 'deleted-remote', label: labelOf(table, L), fields: [] })
          stats.conflicts++
        }
      }
      continue
    }

    // Drive 에 살아 있는 기록이 있다
    if (!L) {
      if (B && sR === sB) {
        // 이 기기에서 삭제했고 Drive 쪽은 그대로 → 삭제를 전달한다
        fin.set(k, { deleted: true })
        push.add(k)
        stats.pushedDeleted++
      } else if (B) {
        // 이 기기에서 삭제했지만 다른 기기가 그 뒤 수정했다 → 수정본을 남긴다
        fin.set(k, { live: R! })
        pull.add(k)
        stats.pulledChanged++
        conflicts.push({ k, table, recordId: idOfKey(k), kind: 'deleted-local', label: labelOf(table, R!), fields: [] })
        stats.conflicts++
      } else {
        fin.set(k, { live: R! })
        pull.add(k)
        stats.pulledNew++
      }
      continue
    }

    if (sL === sR) {
      fin.set(k, { live: L })
      stats.unchanged++
    } else if (B && sL === sB) {
      fin.set(k, { live: R! })
      pull.add(k)
      stats.pulledChanged++
    } else if (B && sR === sB) {
      fin.set(k, { live: L })
      push.add(k)
      stats.pushedChanged++
    } else {
      // 양쪽이 다르게 바뀜 (또는 기준 없이 같은 식별자가 양쪽에 다른 내용으로 존재)
      const tsL = table === 'seatEvents' ? parentTs('local', L.tripId) : tsOf(table, L)
      const tsR = table === 'seatEvents' ? parentTs('remote', R!.tripId) : tsOf(table, R!)
      const m = mergeFields(L, R!, B, tsL, tsR)
      fin.set(k, { live: m.data })
      const sM = sig(table, m.data)
      if (sM !== sL) {
        pull.add(k)
        stats.pulledChanged++
      }
      if (sM !== sR) {
        push.add(k)
        stats.pushedChanged++
      }
      if (m.fields.length) {
        conflicts.push({ k, table, recordId: idOfKey(k), kind: 'fields', label: labelOf(table, m.data), fields: m.fields })
        stats.conflicts++
      }
    }
  }

  // ── 완전히 같은 중복(서로 다른 식별자)을 하나로 합친다. 기준에 없는 새 탑승끼리만 비교한다 ──
  const eventsByTrip = new Map<string, SyncData[]>()
  for (const [k, f] of fin) {
    if (tableOf(k) !== 'seatEvents' || !('live' in f)) continue
    const tid = String(f.live.tripId)
    eventsByTrip.set(tid, [...(eventsByTrip.get(tid) ?? []), f.live])
  }
  const groups = new Map<string, string[]>()
  for (const [k, f] of fin) {
    if (tableOf(k) !== 'trips' || !('live' in f) || base.has(k)) continue
    const ck = tripContentKey(f.live, eventsByTrip.get(idOfKey(k)) ?? [])
    groups.set(ck, [...(groups.get(ck) ?? []), k])
  }
  const kill = (k: string) => {
    fin.set(k, { deleted: true })
    push.add(k)
    if (local.has(k)) pull.add(k)
  }
  for (const ks of groups.values()) {
    if (ks.length < 2) continue
    const [, ...losers] = ks.sort((a, b) => (idOfKey(a) < idOfKey(b) ? -1 : 1))
    for (const k of losers) {
      kill(k)
      for (const e of eventsByTrip.get(idOfKey(k)) ?? []) kill(keyOf('seatEvents', String(e.id)))
      stats.deduped++
    }
  }

  // ── 부모 탑승이 없는 좌석 변화는 정리한다 (삭제된 탑승에 달린 변화) ──
  for (const [k, f] of fin) {
    if (tableOf(k) !== 'seatEvents' || !('live' in f)) continue
    const parent = fin.get(keyOf('trips', String(f.live.tripId)))
    if (!parent || !('live' in parent)) kill(k)
  }

  // ── 결과 조립 ──
  const localPut = new Map<string, SyncData>()
  const localDelete = new Set<string>()
  const nextBase = new Map<string, SyncData>()
  const remoteRecords: Record<string, RemoteRecord> = { ...remote }
  for (const [k, f] of fin) {
    const table = tableOf(k)
    if ('live' in f) {
      nextBase.set(k, f.live)
      if (pull.has(k)) localPut.set(k, f.live)
      if (push.has(k)) remoteRecords[k] = { k, table, id: idOfKey(k), ts: tsOf(table, f.live), data: f.live }
    } else {
      if (pull.has(k)) localDelete.add(k)
      if (push.has(k)) remoteRecords[k] = { k, table, id: idOfKey(k), ts: now, deleted: true }
    }
  }
  return { localPut, localDelete, remoteRecords, remoteChanged: push.size > 0, nextBase, conflicts, stats }
}

export function conflictToRow(c: MergeResult['conflicts'][number], at: number): SyncConflict {
  return { ...c, id: `${c.k}@${at}`, at }
}

/** 병합 결과로 이 기기 기록에 생기는 변화의 총합 */
export function localChangeCount(r: MergeResult): number {
  return r.localPut.size + r.localDelete.size
}
