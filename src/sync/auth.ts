/**
 * Google 로그인 (Google Identity Services, 토큰 모델).
 *
 * 브라우저만 쓰는 앱이라 클라이언트 비밀(secret)·갱신 토큰(refresh token)을 둘 수 없다 — Client ID 만 사용한다(공개 가능한 값).
 *
 * 토큰 보관 정책 (이전의 '메모리 전용'에서 완화됨):
 *  - 액세스 토큰은 메모리에 두고, 새로고침(F5)을 견디도록 **sessionStorage 에도** 사본을 둔다.
 *    sessionStorage 는 그 탭이 닫히면 사라지고 다른 탭·다음 방문과 공유되지 않는다. localStorage/IndexedDB 에는 절대 두지 않는다.
 *  - 실제 만료 시각(expiresAt)을 함께 저장하고, 읽을 때마다 검증한다. 만료(여유 60초 포함)·형식 오류·다른 Client ID 의 토큰은 쓰지 않고 지운다.
 *  - 연결 해제·재인증 실패(401)·계정 변경 시 즉시 삭제한다. URL·로그·저장소에는 남기지 않는다.
 *  - GIS 토큰 모델에는 조용한 갱신이 없다: 만료되면 사용자 클릭 안에서 requestAccessToken() 을 다시 호출해야 한다(공식 문서).
 *    그래서 화면 없는 자동 갱신을 시도하지 않는다(팝업이 차단되어 오히려 경고만 뜬다). 대신 '다시 연결' 버튼을 제공한다.
 *
 * 위험 절충: 같은 출처(origin)에서 실행되는 스크립트(XSS)는 sessionStorage 의 토큰을 읽을 수 있다.
 * 그러나 토큰은 이 앱 전용 숨김 폴더(drive.appdata)만 접근하는 약 1시간짜리이고, 앱은 외부 스크립트를 GIS 한 곳에서만 불러온다.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const GIS_SRC = 'https://accounts.google.com/gsi/client'
const STORE_KEY = 'transitlog.gtoken'
/** 만료 직전에 쓰다 요청 도중 만료되는 일을 피하는 여유 */
const SKEW_MS = 60_000

export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'closed' | 'popup_blocked' | 'unavailable' | 'scope_missing' | 'needs_interaction' | 'busy' }

export interface AcquireOptions {
  /** true = 팝업을 띄울 수 있음(반드시 사용자 클릭과 같은 동작 안에서 호출). false = 화면 없는 시도(prompt=none) */
  interactive: boolean
  /** 이전에 연결한 계정(이메일). 계정 선택 창을 건너뛰는 데 쓴다 */
  loginHint?: string | null
  /** 다른 계정을 고르게 한다 (login_hint 를 쓰지 않음) */
  selectAccount?: boolean
}

export interface AuthProvider {
  /** Client ID 가 설정되어 있는가 */
  readonly configured: boolean
  /** 만료되지 않은 액세스 토큰 (없으면 null) */
  getToken(): string | null
  /** 로그인 구성 요소(GIS 스크립트)를 미리 불러온다. 클릭 때 팝업을 바로 열 수 있게 해 준다 */
  preload(): void
  /** 토큰 받기. 같은 시점에 하나만 진행하고, 이미 진행 중이면 'busy' */
  acquire(opts: AcquireOptions): Promise<AcquireResult>
  /** Google 에 이 앱의 접근 권한 철회를 요청한다 — 같은 계정으로 연결한 다른 기기의 토큰도 무효가 된다. 토큰이 없으면 false */
  revoke(): Promise<boolean>
  /** 이 기기의 토큰만 지운다 (Google 권한은 그대로) */
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

/** 이 탭의 sessionStorage (사용할 수 없는 환경이면 null → 메모리만 사용) */
export function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

interface Stored {
  t: string
  exp: number
  cid: string
}

export function createGoogleAuth(clientId: string | undefined, storage: Storage | null = tabStorage(), now: () => number = Date.now): AuthProvider {
  let token: string | null = null
  let expiresAt = 0
  let pending: Promise<AcquireResult> | null = null

  const wipeStore = () => {
    try {
      storage?.removeItem(STORE_KEY)
    } catch {
      /* 저장소를 쓸 수 없으면 지울 것도 없다 */
    }
  }
  const clear = () => {
    token = null
    expiresAt = 0
    wipeStore()
  }
  const save = () => {
    try {
      if (token && clientId) storage?.setItem(STORE_KEY, JSON.stringify({ t: token, exp: expiresAt, cid: clientId } satisfies Stored))
    } catch {
      /* 저장 실패는 새로고침 후 다시 연결이 필요할 뿐 */
    }
  }
  /** 메모리에 없으면 새로고침 전에 저장해 둔 토큰을 검증해서 되살린다 */
  const restore = () => {
    if (token || !storage) return
    let raw: string | null = null
    try {
      raw = storage.getItem(STORE_KEY)
    } catch {
      return
    }
    if (!raw) return
    try {
      const s = JSON.parse(raw) as Partial<Stored>
      if (typeof s.t === 'string' && s.t && typeof s.exp === 'number' && s.cid === clientId && s.exp - SKEW_MS > now()) {
        token = s.t
        expiresAt = s.exp
        return
      }
    } catch {
      /* 형식 오류 → 아래에서 삭제 */
    }
    wipeStore()
  }

  return {
    configured: !!clientId,
    getToken() {
      restore()
      if (token && now() < expiresAt - SKEW_MS) return token
      if (token) clear()
      return null
    },
    preload() {
      if (clientId && typeof document !== 'undefined') void loadGis().catch(() => undefined)
    },
    acquire(opts) {
      if (!clientId) return Promise.resolve({ ok: false, reason: 'unavailable' })
      if (pending) return Promise.resolve({ ok: false, reason: 'busy' })
      const cid: string = clientId
      const run = (oauth: GisOauth2): Promise<AcquireResult> =>
        new Promise<AcquireResult>((resolve) => {
          let done = false
          const finish = (r: AcquireResult) => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve(r)
          }
          // 화면 없는 시도가 응답하지 않는 경우를 대비
          const timer = setTimeout(() => finish({ ok: false, reason: 'needs_interaction' }), opts.interactive ? 120_000 : 12_000)
          const client = oauth.initTokenClient({
            client_id: cid,
            scope: DRIVE_SCOPE,
            callback: (r) => {
              if (r.error || !r.access_token) {
                finish({ ok: false, reason: opts.interactive ? (r.error === 'access_denied' ? 'denied' : 'closed') : 'needs_interaction' })
                return
              }
              if (!oauth.hasGrantedAllScopes(r, DRIVE_SCOPE)) {
                finish({ ok: false, reason: 'scope_missing' })
                return
              }
              token = r.access_token
              expiresAt = now() + Math.max(120, Number(r.expires_in ?? 3600)) * 1000
              save()
              finish({ ok: true })
            },
            error_callback: (e) =>
              finish({ ok: false, reason: !opts.interactive ? 'needs_interaction' : e.type === 'popup_failed_to_open' ? 'popup_blocked' : 'closed' }),
          })
          const prompt = !opts.interactive ? 'none' : opts.selectAccount ? 'select_account' : ''
          client.requestAccessToken({ prompt, ...(opts.loginHint && !opts.selectAccount ? { login_hint: opts.loginHint } : {}) })
        })
      // GIS 가 이미 불러와져 있으면 await 없이 같은 동작 안에서 바로 요청한다 (사용자 클릭의 팝업 허용이 사라지기 전에)
      const ready = gis()
      const p: Promise<AcquireResult> = ready
        ? run(ready)
        : loadGis().then(
            () => (gis() ? run(gis()!) : { ok: false as const, reason: 'unavailable' as const }),
            () => ({ ok: false as const, reason: 'unavailable' as const }),
          )
      pending = p.finally(() => {
        pending = null
      })
      return pending
    },
    async revoke() {
      restore()
      const t = token
      clear()
      const oauth = gis()
      if (!t || !oauth) return false
      await new Promise<void>((r) => (oauth.revoke(t, () => r()), setTimeout(r, 3000)))
      return true
    },
    forget() {
      clear()
    },
  }
}
