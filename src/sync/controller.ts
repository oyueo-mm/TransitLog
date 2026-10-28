import type { TransitDB } from '../db/db'
import type { AuthProvider } from './auth'
import { DriveError, type DriveApi } from './drive'
import { RemoteTooNewError, applyState, clearSyncState, getMeta, runSync, setMeta, type RunOptions } from './engine'
import type { SyncConflict, SyncStatus } from './types'

/**
 * 동기화 상태 기계: 언제 동기화할지(변경 후·온라인 복귀·앱 시작·수동), 한 번에 하나만 실행, 실패를 사용자에게 어떻게 보일지.
 * 데이터 병합 자체는 engine.ts 가 하고, 여기서는 인증·재시도·상태 표시만 다룬다.
 */

const DEBOUNCE_MS = 2500
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 10 * 60_000
/** 조용한 토큰 갱신이 실패한 뒤 사용자 조작 없이 다시 시도하지 않는 시간 */
const SILENT_COOLDOWN_MS = 10 * 60_000

export interface ControllerDeps {
  db: TransitDB
  auth: AuthProvider
  drive: DriveApi
  isOnline?: () => boolean
  now?: () => number
  /** 변경 뒤 동기화를 미루는 시간(ms). 테스트에서 줄여 쓴다 */
  debounceMs?: number
  /** 일시 오류 뒤 첫 재시도까지의 시간(ms) */
  retryBaseMs?: number
}

const BASE_STATUS: SyncStatus = {
  phase: 'disconnected',
  auto: true,
  account: null,
  lastOkAt: null,
  message: null,
  conflictCount: 0,
  confirm: null,
  dirty: false,
}

export class SyncController {
  private status: SyncStatus = { ...BASE_STATUS }
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  private silentFailedAt = 0
  /** 확인 대기 중인 실행에서 이미 받은 승인들 */
  private granted: RunOptions = {}
  private initDone = false

  private deps: ControllerDeps

  constructor(deps: ControllerDeps) {
    this.deps = deps
    this.status.phase = deps.auth.configured ? 'disconnected' : 'unconfigured'
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }
  private online() {
    return this.deps.isOnline ? this.deps.isOnline() : typeof navigator === 'undefined' || navigator.onLine !== false
  }

  // ── 구독 ──
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getStatus = () => this.status
  private set(p: Partial<SyncStatus>) {
    this.status = { ...this.status, ...p }
    for (const l of this.listeners) l()
  }

  // ── 시작 ──
  async init(): Promise<void> {
    if (this.initDone) return
    this.initDone = true
    const { db, auth } = this.deps
    if (!auth.configured) return
    const [enabled, auto, lastOkAt, account] = await Promise.all([
      getMeta<boolean>(db, 'enabled', false),
      getMeta<boolean>(db, 'auto', true),
      getMeta<number | null>(db, 'lastOkAt', null),
      getMeta<string | null>(db, 'accountEmail', null),
    ])
    this.set({ auto, lastOkAt, account, phase: enabled ? 'idle' : 'disconnected', conflictCount: await db.syncConflicts.count() })
    if (enabled) await this.syncNow({ interactive: false, reason: 'start' })
  }

  // ── 사용자 동작 ──
  /** Google 계정 연결 (버튼 클릭 안에서 호출해야 팝업이 막히지 않는다) */
  async connect(): Promise<void> {
    if (!this.deps.auth.configured) return
    this.granted = {}
    await this.deps.db.syncMeta.put({ key: 'enabled', value: true })
    this.set({ phase: 'idle', message: null, confirm: null })
    await this.syncNow({ interactive: true, reason: 'connect' })
  }

  async setAuto(on: boolean): Promise<void> {
    await setMeta(this.deps.db, 'auto', on)
    this.set({ auto: on })
    if (on) this.requestSync()
  }

  /** '지금 동기화' */
  async syncNow(o: { interactive: boolean; reason?: string } = { interactive: true }): Promise<void> {
    if (!this.isActive()) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    return this.enqueue(() => this.execute(this.granted, o.interactive))
  }

  /** 사용자가 확인 창에서 '계속'을 눌렀다 */
  async confirmContinue(choice?: 'apply' | 'revert'): Promise<void> {
    const req = this.status.confirm
    if (!req) return
    const g: RunOptions = { ...this.granted }
    if (req.kind === 'first') g.confirmFirst = true
    else if (req.kind === 'account') g.confirmAccount = true
    else if (req.kind === 'bulk-delete') g.bulkDelete = choice ?? 'apply'
    else if (req.kind === 'remote-corrupt') g.rebuildRemote = true
    this.granted = req.kind === 'bulk-delete' ? this.granted : g
    this.set({ confirm: null, message: null })
    await this.enqueue(() => this.execute(g, true))
  }

  /** 확인 창에서 취소: 처음 연결·계정 변경이면 연결을 취소한다 */
  async confirmCancel(): Promise<void> {
    const req = this.status.confirm
    if (!req) return
    if (req.kind === 'first' || req.kind === 'account') await this.disconnect()
    else this.set({ confirm: null, phase: 'idle', message: '동기화를 보류했습니다. 다음 동기화 때 다시 확인합니다.' })
  }

  /** 연결 해제: 이 기기의 기록은 지우지 않는다 */
  async disconnect(): Promise<void> {
    const { db, auth } = this.deps
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.timer = this.retryTimer = null
    await this.queue.catch(() => undefined)
    await auth.revoke().catch(() => undefined)
    await clearSyncState(db)
    this.granted = {}
    this.set({ ...BASE_STATUS, auto: this.status.auto, phase: auth.configured ? 'disconnected' : 'unconfigured' })
  }

  // ── 자동 동기화 ──
  private isActive(): boolean {
    return this.deps.auth.configured && this.status.phase !== 'disconnected' && this.status.phase !== 'unconfigured'
  }

  /** 기록이 바뀌었을 때(또는 온라인 복귀·앱 활성화) 호출. 짧은 시간에 여러 번 와도 한 번만 실행된다 */
  requestSync(): void {
    if (applyState.applying > 0 || !this.isActive()) return
    this.set({ dirty: true })
    if (!this.status.auto) return
    if (this.status.phase === 'confirm') return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.syncNow({ interactive: false, reason: 'auto' })
    }, this.deps.debounceMs ?? DEBOUNCE_MS)
  }

  /** 오래 열려 있던 화면이 다시 보일 때: 조용한 갱신을 한 번 더 시도 */
  onVisible(): void {
    if (!this.isActive() || !this.status.auto) return
    if (this.status.phase === 'reauth' && this.now() - this.silentFailedAt < SILENT_COOLDOWN_MS) return
    if (this.status.phase === 'confirm') return
    this.requestSync()
  }

  // ── 충돌 ──
  async refreshConflictCount(): Promise<void> {
    const n = await this.deps.db.syncConflicts.count()
    this.set({ conflictCount: n, phase: n === 0 && this.status.phase === 'conflict' ? 'ok' : this.status.phase })
  }

  /**
   * 충돌 처리.
   *  keep    : 지금 남아 있는 값을 그대로 쓴다 (확인 완료)
   *  other   : 밀려난 값/상태로 바꾼다 (값 충돌은 필드 값을, 삭제 충돌은 기록을 삭제한다)
   */
  async resolveConflict(c: SyncConflict, action: 'keep' | 'other'): Promise<void> {
    const { db } = this.deps
    if (action === 'other') {
      if (c.kind === 'fields') {
        const patch: Record<string, unknown> = {}
        for (const f of c.fields) patch[f.name] = f.kept === 'local' ? f.remote : f.local
        if (c.table === 'trips' || c.table === 'days') patch.updatedAt = this.now()
        const t = db[c.table] as unknown as { update(id: string, p: Record<string, unknown>): Promise<number> }
        await t.update(c.recordId, patch)
      } else if (c.table === 'trips') {
        await db.transaction('rw', db.trips, db.seatEvents, async () => {
          await db.seatEvents.where('tripId').equals(c.recordId).delete()
          await db.trips.delete(c.recordId)
        })
      } else {
        const t = db[c.table] as unknown as { delete(id: string): Promise<void> }
        await t.delete(c.recordId)
      }
    }
    await db.syncConflicts.delete(c.id)
    await this.refreshConflictCount()
    if (action === 'other') this.requestSync()
  }

  // ── 실행 ──
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
      return locks ? locks.request('transitlog-sync', fn) : fn()
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p as Promise<T>
  }

  private async execute(opts: RunOptions, interactive: boolean): Promise<void> {
    const { db, auth, drive } = this.deps
    if (!this.isActive()) return
    if (!this.online()) {
      this.set({ phase: 'offline', dirty: true, message: '오프라인입니다. 연결되면 자동으로 동기화합니다.' })
      return
    }
    this.set({ phase: 'syncing', message: null, dirty: false })
    try {
      if (!auth.getToken()) {
        const hint = await getMeta<string | null>(db, 'accountEmail', null)
        const r = await auth.acquire({ interactive, loginHint: hint })
        if (!r.ok) {
          this.silentFailedAt = this.now()
          const msg =
            r.reason === 'denied'
              ? 'Google 연결이 거부되었습니다. Drive 앱 데이터 접근을 허용해야 동기화할 수 있습니다.'
              : r.reason === 'scope_missing'
                ? '동기화에 필요한 권한(Drive 앱 데이터)이 허용되지 않았습니다. 다시 연결하며 권한을 모두 허용해 주세요.'
                : r.reason === 'popup_blocked'
                  ? '로그인 창이 차단되었습니다. 팝업을 허용한 뒤 다시 연결해 주세요.'
                  : r.reason === 'unavailable'
                    ? 'Google 로그인 구성 요소를 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.'
                    : 'Google 연결이 만료되었습니다. ‘다시 연결’을 눌러 주세요. 기록은 이 기기에 안전하게 저장되어 있습니다.'
          this.set({ phase: 'reauth', message: msg, dirty: true })
          return
        }
      }
      const out = await runSync({ db, drive, now: () => this.now() }, opts)
      if (out.kind === 'confirm') {
        this.set({ phase: 'confirm', confirm: out.request, message: null })
        return
      }
      this.granted = {}
      this.retryCount = 0
      const [lastOkAt, account, conflictCount] = await Promise.all([getMeta<number | null>(db, 'lastOkAt', null), getMeta<string | null>(db, 'accountEmail', null), db.syncConflicts.count()])
      this.set({
        phase: conflictCount > 0 ? 'conflict' : 'ok',
        lastOkAt,
        account,
        conflictCount,
        confirm: null,
        message: out.skipped > 0 ? '동기화 중 수정한 기록이 있어 잠시 뒤 다시 동기화합니다.' : null,
        dirty: out.skipped > 0,
      })
      if (out.skipped > 0) this.requestSync()
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown) {
    if (e instanceof RemoteTooNewError) {
      this.set({ phase: 'error', message: e.message, dirty: true })
      return
    }
    if (e instanceof DriveError) {
      switch (e.kind) {
        case 'auth':
          this.deps.auth.forget()
          this.silentFailedAt = this.now()
          this.set({ phase: 'reauth', dirty: true, message: 'Google 연결이 만료되었습니다. ‘다시 연결’을 눌러 주세요. 기록은 이 기기에 안전하게 저장되어 있습니다.' })
          return
        case 'network':
          this.set({ phase: this.online() ? 'error' : 'offline', dirty: true, message: this.online() ? '네트워크 오류로 동기화하지 못했습니다. 잠시 후 자동으로 다시 시도합니다.' : '오프라인입니다. 연결되면 자동으로 동기화합니다.' })
          this.scheduleRetry()
          return
        case 'rate':
        case 'server':
        case 'conflict':
          this.set({ phase: 'error', dirty: true, message: `${e.message} 자동으로 다시 시도합니다.` })
          this.scheduleRetry()
          return
        default:
          this.set({ phase: 'error', dirty: true, message: e.message })
          return
      }
    }
    this.set({ phase: 'error', dirty: true, message: '동기화 중 예기치 않은 오류가 발생했습니다. 기록은 이 기기에 그대로 있습니다.' })
  }

  private scheduleRetry() {
    if (!this.status.auto || this.retryTimer) return
    const wait = Math.min(RETRY_MAX_MS, (this.deps.retryBaseMs ?? RETRY_BASE_MS) * 2 ** this.retryCount++)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.syncNow({ interactive: false, reason: 'retry' })
    }, wait)
  }
}
