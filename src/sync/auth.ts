/**
 * Google 로그인 (Google Identity Services, 토큰 모델).
 *
 * 브라우저만 쓰는 앱이라 클라이언트 비밀(secret)을 둘 수 없다 — 이 코드는 Client ID 만 사용한다(공개 가능한 값).
 *  - 액세스 토큰은 메모리에만 둔다. localStorage/IndexedDB/URL/로그에 남기지 않는다.
 *  - 토큰은 약 1시간 유효하고 갱신 토큰(refresh token)이 없다. 만료되면 Google 세션이 남아 있을 때만 조용히 다시 받고,
 *    그렇지 않으면 사용자가 '다시 연결'을 눌러야 한다 → 앱은 이를 '재인증 필요'로 표시한다.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const GIS_SRC = 'https://accounts.google.com/gsi/client'

export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'closed' | 'popup_blocked' | 'unavailable' | 'scope_missing' | 'needs_interaction' }

export interface AuthProvider {
  /** Client ID 가 설정되어 있는가 */
  readonly configured: boolean
  /** 만료되지 않은 액세스 토큰 (없으면 null) */
  getToken(): string | null
  /** interactive=false 는 화면 없이 시도(실패하면 needs_interaction), true 는 팝업을 띄울 수 있다(사용자 클릭 안에서 호출) */
  acquire(opts: { interactive: boolean; loginHint?: string | null }): Promise<AcquireResult>
  /** 토큰을 폐기하고 메모리에서 지운다 */
  revoke(): Promise<void>
  /** 메모리의 토큰만 지운다 */
  forget(): void
}

interface TokenResponse {
  access_token?: string
  expires_in?: number | string
  error?: string
  scope?: string
}
interface TokenClient {
  requestAccessToken(cfg?: { prompt?: string; login_hint?: string }): void
}
interface GisOauth2 {
  initTokenClient(cfg: {
    client_id: string
    scope: string
    callback: (r: TokenResponse) => void
    error_callback?: (e: { type?: string }) => void
  }): TokenClient
  revoke(token: string, done?: () => void): void
  hasGrantedAllScopes(r: TokenResponse, ...scopes: string[]): boolean
}

function gis(): GisOauth2 | null {
  const w = globalThis as unknown as { google?: { accounts?: { oauth2?: GisOauth2 } } }
  return w.google?.accounts?.oauth2 ?? null
}

let scriptPromise: Promise<void> | null = null
function loadGis(): Promise<void> {
  if (gis()) return Promise.resolve()
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      scriptPromise = null
      s.remove()
      reject(new Error('gis-load'))
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

export function createGoogleAuth(clientId: string | undefined): AuthProvider {
  let token: string | null = null
  let expiresAt = 0

  return {
    configured: !!clientId,
    getToken() {
      if (token && Date.now() < expiresAt) return token
      token = null
      return null
    },
    async acquire({ interactive, loginHint }) {
      if (!clientId) return { ok: false, reason: 'unavailable' }
      try {
        await loadGis()
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      const oauth = gis()
      if (!oauth) return { ok: false, reason: 'unavailable' }
      return new Promise<AcquireResult>((resolve) => {
        let done = false
        const finish = (r: AcquireResult) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(r)
        }
        // 화면 없는 시도가 응답하지 않는 경우(브라우저가 서드파티 쿠키를 막는 등)를 대비
        const timer = setTimeout(() => finish({ ok: false, reason: 'needs_interaction' }), interactive ? 120_000 : 12_000)
        const client = oauth.initTokenClient({
          client_id: clientId,
          scope: DRIVE_SCOPE,
          callback: (r) => {
            if (r.error || !r.access_token) {
              finish({ ok: false, reason: interactive ? (r.error === 'access_denied' ? 'denied' : 'closed') : 'needs_interaction' })
              return
            }
            if (!oauth.hasGrantedAllScopes(r, DRIVE_SCOPE)) {
              finish({ ok: false, reason: 'scope_missing' })
              return
            }
            token = r.access_token
            expiresAt = Date.now() + Math.max(60, Number(r.expires_in ?? 3600) - 120) * 1000
            finish({ ok: true })
          },
          error_callback: (e) =>
            finish({ ok: false, reason: !interactive ? 'needs_interaction' : e.type === 'popup_failed_to_open' ? 'popup_blocked' : 'closed' }),
        })
        client.requestAccessToken({ prompt: interactive ? '' : 'none', ...(loginHint ? { login_hint: loginHint } : {}) })
      })
    },
    async revoke() {
      const t = token
      token = null
      expiresAt = 0
      const oauth = gis()
      if (t && oauth) await new Promise<void>((r) => (oauth.revoke(t, () => r()), setTimeout(r, 3000)))
    },
    forget() {
      token = null
      expiresAt = 0
    },
  }
}
