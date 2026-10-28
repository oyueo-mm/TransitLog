import 'fake-indexeddb/auto'
import { TransitDB } from '../src/db/db'
import { DriveError, type DriveApi, type DriveFileMeta } from '../src/sync/drive'
import { SYNC_FILE_NAME } from '../src/sync/types'
import type { AcquireResult, AuthProvider } from '../src/sync/auth'

/** 메모리 안의 가상 Google Drive (appDataFolder). 모든 기기가 공유한다. 실제 개인 데이터는 쓰지 않는다. */
export class FakeCloud {
  files: Array<{ id: string; text: string; version: number; createdTime: string }> = []
  private seq = 0
  writes = 0
  reads = 0
  /** 다음 호출들에서 던질 오류 (앞에서부터 하나씩 소비) */
  failures: DriveError[] = []
  onBeforeUpdate?: () => Promise<void> | void
  onAfterUpdate?: () => Promise<void> | void
  onAfterCreate?: () => Promise<void> | void
  permissionId = 'perm-1'
  email = 'tester@example.test'

  private maybeFail() {
    const f = this.failures.shift()
    if (f) throw f
  }

  api(): DriveApi {
    return {
      list: async (): Promise<DriveFileMeta[]> => {
        this.maybeFail()
        return this.files
          .filter((f) => f.id)
          .sort((a, b) => a.createdTime.localeCompare(b.createdTime))
          .map((f) => ({ id: f.id, version: String(f.version), createdTime: f.createdTime }))
      },
      read: async (id) => {
        this.maybeFail()
        this.reads++
        const f = this.files.find((x) => x.id === id)
        if (!f) throw new DriveError('notfound', 'nf', 404)
        return { text: f.text, version: String(f.version) }
      },
      create: async (text) => {
        this.maybeFail()
        this.writes++
        const f = { id: `file-${++this.seq}`, text, version: 1, createdTime: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString() }
        this.files.push(f)
        await this.onAfterCreate?.()
        return { id: f.id, version: String(f.version), createdTime: f.createdTime }
      },
      update: async (id, text, expect) => {
        this.maybeFail()
        await this.onBeforeUpdate?.()
        const f = this.files.find((x) => x.id === id)
        if (!f) throw new DriveError('notfound', 'nf', 404)
        if (String(f.version) !== expect) throw new DriveError('conflict', 'conflict')
        f.text = text
        f.version++
        this.writes++
        await this.onAfterUpdate?.()
        return { id, version: String(f.version) }
      },
      remove: async (id) => {
        this.files = this.files.filter((f) => f.id !== id)
      },
      about: async () => {
        this.maybeFail()
        return { account: this.email, permissionId: this.permissionId }
      },
    }
  }

  /** 다른 기기가 같은 파일을 직접 갱신한 것처럼 만든다 */
  overwrite(text: string) {
    const f = this.files[0]
    f.text = text
    f.version++
  }
  get text(): string {
    return this.files[0]?.text ?? ''
  }
  get doc() {
    return JSON.parse(this.text) as { records: Record<string, { deleted?: true; data?: Record<string, unknown> }>; revision: number }
  }
}

let n = 0
export function newDevice(): TransitDB {
  return new TransitDB(`sync-test-${++n}-${Math.random().toString(36).slice(2)}`)
}

export class FakeAuth implements AuthProvider {
  configured = true
  token: string | null = 'tok'
  next: AcquireResult = { ok: true }
  acquires: Array<{ interactive: boolean }> = []
  revoked = 0
  getToken() {
    return this.token
  }
  async acquire(o: { interactive: boolean }): Promise<AcquireResult> {
    this.acquires.push({ interactive: o.interactive })
    if (this.next.ok) this.token = 'tok'
    return this.next
  }
  async revoke() {
    this.revoked++
    this.token = null
  }
  forget() {
    this.token = null
  }
}

export { SYNC_FILE_NAME }
