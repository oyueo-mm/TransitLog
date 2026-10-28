import { db } from '../db/db'
import { createGoogleAuth } from './auth'
import { SyncController } from './controller'
import { createDriveApi } from './drive'
import { applyState } from './engine'
import { SYNC_TABLES } from './types'

/**
 * 실제 앱에서 쓰는 동기화 인스턴스.
 * Client ID 는 빌드할 때 환경 변수 VITE_GOOGLE_CLIENT_ID 로 넣는다 (공개 가능한 값. 클라이언트 비밀은 쓰지 않는다).
 * 값이 없으면 동기화 기능은 꺼진 상태('unconfigured')이고 나머지 기능은 그대로 동작한다.
 */
const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || undefined

export const googleAuth = createGoogleAuth(clientId)
export const syncController = new SyncController({
  db,
  auth: googleAuth,
  drive: createDriveApi(() => googleAuth.getToken()),
})

let started = false
export function startSync(): void {
  if (started) return
  started = true
  // 기록이 바뀔 때마다(동기화 자신이 쓴 변경은 제외) 짧게 모아서 한 번 동기화한다
  for (const t of SYNC_TABLES) {
    const table = db[t] as unknown as { hook: (ev: string, fn: () => void) => void }
    for (const ev of ['creating', 'updating', 'deleting']) {
      table.hook(ev, () => {
        if (applyState.applying === 0) syncController.requestSync()
      })
    }
  }
  window.addEventListener('online', () => syncController.requestSync())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncController.onVisible()
  })
  void syncController.init()
}
