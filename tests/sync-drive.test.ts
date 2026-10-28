import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGoogleAuth, DRIVE_SCOPE } from '../src/sync/auth'
import { createDriveApi, DriveError } from '../src/sync/drive'

interface Call {
  url: string
  init: RequestInit
}
function stub(responses: Array<Response | Error>) {
  const calls: Call[] = []
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const r = responses.shift()
    if (!r) throw new Error('예상하지 못한 호출')
    if (r instanceof Error) throw r
    return r
  }) as unknown as typeof fetch
  return { fn, calls }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const authHeader = (c: Call) => (c.init.headers as Record<string, string>).Authorization

describe('Drive REST 클라이언트', () => {
  it('appDataFolder 안의 동기화 파일만 조회하고, 토큰은 헤더로만 보낸다 (URL 에 넣지 않는다)', async () => {
    const { fn, calls } = stub([json({ files: [{ id: 'f1', version: '3', createdTime: '2026-01-01T00:00:00Z' }] })])
    const api = createDriveApi(() => 'SECRET-TOKEN', fn)
    const files = await api.list()
    expect(files).toEqual([{ id: 'f1', version: '3', createdTime: '2026-01-01T00:00:00Z' }])
    expect(calls[0].url).toContain('spaces=appDataFolder')
    expect(decodeURIComponent(calls[0].url)).toContain("name='transitlog-sync.json'")
    expect(calls[0].url).not.toContain('SECRET-TOKEN')
    expect(authHeader(calls[0])).toBe('Bearer SECRET-TOKEN')
  })

  it('처음 만들 때는 부모를 appDataFolder 로 지정한다', async () => {
    const { fn, calls } = stub([json({ id: 'new', version: '1' })])
    const api = createDriveApi(() => 't', fn)
    await api.create('{"a":1}')
    expect(calls[0].init.method).toBe('POST')
    expect(String(calls[0].init.body)).toContain('"parents":["appDataFolder"]')
    expect(String(calls[0].init.body)).toContain('{"a":1}')
  })

  it('갱신 전에 파일 버전을 확인해 다른 기기가 먼저 바꿨다면 쓰지 않고 충돌로 알린다', async () => {
    const { fn, calls } = stub([json({ id: 'f', version: '5' })])
    const api = createDriveApi(() => 't', fn)
    await expect(api.update('f', 'x', '4')).rejects.toMatchObject({ kind: 'conflict' })
    expect(calls).toHaveLength(1) // PATCH 는 보내지 않았다
  })

  it('버전이 같으면 PATCH 로 내용을 갱신한다', async () => {
    const { fn, calls } = stub([json({ id: 'f', version: '4' }), json({ id: 'f', version: '5' })])
    const meta = await createDriveApi(() => 't', fn).update('f', 'body', '4')
    expect(meta.version).toBe('5')
    expect(calls[1].init.method).toBe('PATCH')
    expect(calls[1].url).toContain('uploadType=media')
  })

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'notfound'],
    [429, 'rate'],
    [503, 'server'],
    [418, 'badresponse'],
  ])('HTTP %i 는 %s 오류로 구분한다', async (status, kind) => {
    const { fn } = stub([json({ error: { message: 'x' } }, status as number)])
    await expect(createDriveApi(() => 't', fn).list()).rejects.toMatchObject({ kind })
  })

  it('네트워크 오류와 토큰 없음을 구분한다', async () => {
    const { fn } = stub([new TypeError('Failed to fetch')])
    await expect(createDriveApi(() => 't', fn).list()).rejects.toMatchObject({ kind: 'network' })
    const none = stub([])
    await expect(createDriveApi(() => null, none.fn).list()).rejects.toMatchObject({ kind: 'auth' })
    expect(none.calls).toHaveLength(0)
  })

  it('계정 정보를 읽는다', async () => {
    const { fn } = stub([json({ user: { emailAddress: 'a@example.test', permissionId: 'p1' } })])
    expect(await createDriveApi(() => 't', fn).about()).toEqual({ account: 'a@example.test', permissionId: 'p1' })
  })

  it('DriveError 는 종류를 가진다', () => {
    expect(new DriveError('auth', 'm').kind).toBe('auth')
  })
})

interface FakeTokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
}
function installGis(behavior: (cfg: { callback: (r: FakeTokenResponse) => void; error_callback?: (e: { type?: string }) => void }, req: { prompt?: string; login_hint?: string }) => void, granted = true) {
  const revoke = vi.fn((_t: string, done?: () => void) => done?.())
  const requests: Array<{ prompt?: string; login_hint?: string }> = []
  const configs: Array<{ scope?: string; client_id?: string }> = []
  ;(globalThis as unknown as { google: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: { scope?: string; client_id?: string; callback: (r: FakeTokenResponse) => void; error_callback?: (e: { type?: string }) => void }) => (configs.push(cfg), {
          requestAccessToken: (req: { prompt?: string; login_hint?: string }) => {
            requests.push(req)
            behavior(cfg, req)
          },
        }),
        revoke,
        hasGrantedAllScopes: () => granted,
      },
    },
  }
  return { revoke, requests, configs }
}

describe('Google 로그인(토큰 모델)', () => {
  afterEach(() => {
    delete (globalThis as unknown as { google?: unknown }).google
    vi.useRealTimers()
  })

  it('Client ID 가 없으면 설정되지 않은 상태이고 아무것도 하지 않는다', async () => {
    const auth = createGoogleAuth(undefined)
    expect(auth.configured).toBe(false)
    expect(await auth.acquire({ interactive: true })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('토큰을 받으면 메모리에서 쓰고, 만료되면 사라진다. drive.appdata 범위만 요청한다', async () => {
    vi.useFakeTimers()
    const { requests, configs } = installGis((cfg) => cfg.callback({ access_token: 'abc', expires_in: 3600 }))
    const auth = createGoogleAuth('client-id')
    expect(auth.getToken()).toBeNull()
    expect(await auth.acquire({ interactive: true })).toEqual({ ok: true })
    expect(configs[0].scope).toBe(DRIVE_SCOPE)
    expect(configs[0].client_id).toBe('client-id')
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.appdata')
    expect(requests[0].prompt).toBe('')
    expect(auth.getToken()).toBe('abc')
    vi.advanceTimersByTime(3600 * 1000)
    expect(auth.getToken()).toBeNull()
  })

  it('화면 없는 갱신은 prompt=none 으로 시도하고 실패하면 사용자 조작이 필요하다고 알린다', async () => {
    const { requests } = installGis((cfg) => cfg.callback({ error: 'interaction_required' }))
    const auth = createGoogleAuth('client-id')
    expect(await auth.acquire({ interactive: false, loginHint: 'a@example.test' })).toEqual({ ok: false, reason: 'needs_interaction' })
    expect(requests[0]).toEqual({ prompt: 'none', login_hint: 'a@example.test' })
    expect(auth.getToken()).toBeNull()
  })

  it('사용자가 거부하거나 창을 닫거나 팝업이 차단된 경우를 구분한다', async () => {
    installGis((cfg) => cfg.callback({ error: 'access_denied' }))
    expect(await createGoogleAuth('c').acquire({ interactive: true })).toEqual({ ok: false, reason: 'denied' })
    installGis((cfg) => cfg.error_callback?.({ type: 'popup_closed' }))
    expect(await createGoogleAuth('c').acquire({ interactive: true })).toEqual({ ok: false, reason: 'closed' })
    installGis((cfg) => cfg.error_callback?.({ type: 'popup_failed_to_open' }))
    expect(await createGoogleAuth('c').acquire({ interactive: true })).toEqual({ ok: false, reason: 'popup_blocked' })
  })

  it('Drive 앱 데이터 권한을 체크 해제하면 토큰을 쓰지 않는다', async () => {
    installGis((cfg) => cfg.callback({ access_token: 'abc', expires_in: 3600 }), false)
    const auth = createGoogleAuth('c')
    expect(await auth.acquire({ interactive: true })).toEqual({ ok: false, reason: 'scope_missing' })
    expect(auth.getToken()).toBeNull()
  })

  it('연결 해제하면 토큰을 폐기하고 메모리에서 지운다', async () => {
    const { revoke } = installGis((cfg) => cfg.callback({ access_token: 'abc', expires_in: 3600 }))
    const auth = createGoogleAuth('c')
    await auth.acquire({ interactive: true })
    await auth.revoke()
    expect(revoke).toHaveBeenCalledWith('abc', expect.any(Function))
    expect(auth.getToken()).toBeNull()
  })

  it('응답이 없는 화면 없는 갱신은 시간 제한 뒤 사용자 조작이 필요하다고 본다', async () => {
    vi.useFakeTimers()
    installGis(() => undefined)
    const p = createGoogleAuth('c').acquire({ interactive: false })
    await vi.advanceTimersByTimeAsync(13_000)
    expect(await p).toEqual({ ok: false, reason: 'needs_interaction' })
  })
})

class MemStorage implements Storage {
  m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  clear() {
    this.m.clear()
  }
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
}

describe('토큰 보관 (새로고침 유지, 탭 한정)', () => {
  afterEach(() => {
    delete (globalThis as unknown as { google?: unknown }).google
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage
  })
  const grant = (token = 'abc', expires = 3600) => installGis((cfg) => cfg.callback({ access_token: token, expires_in: expires }))

  it('받은 토큰은 실제 만료 시각과 함께 탭 저장소에 두고, 새로고침 후 새 인스턴스가 유효하면 그대로 쓴다', async () => {
    let t = 1_000_000
    const store = new MemStorage()
    grant('tok-1', 3600)
    const a = createGoogleAuth('cid', store, () => t)
    await a.acquire({ interactive: true })
    const saved = JSON.parse(store.getItem('transitlog.gtoken')!)
    expect(saved).toEqual({ t: 'tok-1', exp: t + 3600 * 1000, cid: 'cid' })
    // 새로고침: 메모리는 사라지고 같은 탭의 저장소만 남는다
    t += 10 * 60 * 1000
    const b = createGoogleAuth('cid', store, () => t)
    expect(b.getToken()).toBe('tok-1')
  })

  it('만료되었거나 만료 직전(여유 60초)인 토큰은 쓰지 않고 저장소에서도 지운다', async () => {
    let t = 0
    const store = new MemStorage()
    store.setItem('transitlog.gtoken', JSON.stringify({ t: 'old', exp: 3_600_000, cid: 'cid' }))
    t = 3_600_000 - 59_000
    expect(createGoogleAuth('cid', store, () => t).getToken()).toBeNull()
    expect(store.getItem('transitlog.gtoken')).toBeNull()
    store.setItem('transitlog.gtoken', JSON.stringify({ t: 'old', exp: 3_600_000, cid: 'cid' }))
    t = 3_600_001
    expect(createGoogleAuth('cid', store, () => t).getToken()).toBeNull()
  })

  it('실행 중에 만료 시각이 지나면 메모리 토큰도 더 이상 쓰지 않는다', async () => {
    let t = 0
    const store = new MemStorage()
    grant('tok', 3600)
    const a = createGoogleAuth('cid', store, () => t)
    await a.acquire({ interactive: true })
    expect(a.getToken()).toBe('tok')
    t = 3600 * 1000 - 30_000
    expect(a.getToken()).toBeNull()
    expect(store.length).toBe(0)
  })

  it('다른 Client ID 의 토큰, 손상된 값, 형식이 다른 값은 무시하고 지운다', () => {
    const store = new MemStorage()
    for (const bad of [JSON.stringify({ t: 'x', exp: 9e15, cid: 'other' }), '{깨짐', JSON.stringify({ t: '', exp: 9e15, cid: 'cid' }), JSON.stringify({ t: 'x', exp: 'soon', cid: 'cid' }), 'null']) {
      store.setItem('transitlog.gtoken', bad)
      expect(createGoogleAuth('cid', store, () => 0).getToken()).toBeNull()
      expect(store.getItem('transitlog.gtoken')).toBeNull()
    }
  })

  it('forget(연결 해제·401·계정 변경)은 저장된 토큰도 지우고 Google 권한은 철회하지 않는다', async () => {
    const store = new MemStorage()
    const { revoke } = grant('tok')
    const a = createGoogleAuth('cid', store, () => 0)
    await a.acquire({ interactive: true })
    expect(store.length).toBe(1)
    a.forget()
    expect(store.length).toBe(0)
    expect(a.getToken()).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('revoke 는 저장소를 비우고 Google 에 철회를 요청한다. 토큰이 없으면 false', async () => {
    const store = new MemStorage()
    const { revoke } = grant('tok')
    const a = createGoogleAuth('cid', store, () => 0)
    await a.acquire({ interactive: true })
    expect(await a.revoke()).toBe(true)
    expect(revoke).toHaveBeenCalledWith('tok', expect.any(Function))
    expect(store.length).toBe(0)
    expect(await a.revoke()).toBe(false)
  })

  it('localStorage 는 절대 사용하지 않고, 저장되는 것은 토큰·만료·Client ID 뿐이다 (갱신 토큰·비밀 없음)', async () => {
    const touched: string[] = []
    ;(globalThis as unknown as { localStorage: unknown }).localStorage = new Proxy({}, { get: (_t, p) => (touched.push(String(p)), undefined) })
    const store = new MemStorage()
    installGis((cfg) => cfg.callback({ access_token: 'tok', expires_in: 3600, refresh_token: 'NOPE', client_secret: 'NOPE' } as never))
    const a = createGoogleAuth('cid', store, () => 0)
    await a.acquire({ interactive: true })
    a.getToken()
    a.forget()
    expect(touched).toEqual([])
    store.setItem('x', 'y')
    await a.acquire({ interactive: true })
    expect(Object.keys(JSON.parse(store.getItem('transitlog.gtoken')!)).sort()).toEqual(['cid', 'exp', 't'])
    expect(store.getItem('transitlog.gtoken')).not.toMatch(/NOPE/)
  })

  it('저장소를 쓸 수 없는 환경(null)에서도 메모리만으로 동작한다', async () => {
    grant('tok')
    const a = createGoogleAuth('cid', null, () => 0)
    await a.acquire({ interactive: true })
    expect(a.getToken()).toBe('tok')
  })

  it('저장소가 예외를 던져도 동작한다', async () => {
    grant('tok')
    const bad = new MemStorage()
    bad.setItem = () => {
      throw new Error('quota')
    }
    bad.getItem = () => {
      throw new Error('denied')
    }
    const a = createGoogleAuth('cid', bad, () => 0)
    await a.acquire({ interactive: true })
    expect(a.getToken()).toBe('tok')
  })

  it('로그인 요청이 진행 중이면 두 번째 요청은 새 팝업을 만들지 않는다', async () => {
    const calls: number[] = []
    installGis((cfg) => {
      calls.push(1)
      setTimeout(() => cfg.callback({ access_token: 'tok', expires_in: 3600 }), 20)
    })
    const a = createGoogleAuth('cid', new MemStorage(), () => 0)
    const [r1, r2] = await Promise.all([a.acquire({ interactive: true }), a.acquire({ interactive: true })])
    expect(calls).toHaveLength(1)
    expect([r1, r2]).toContainEqual({ ok: false, reason: 'busy' })
    expect([r1, r2]).toContainEqual({ ok: true })
  })

  it('계정 선택 요청은 select_account 이고 로그인 힌트를 보내지 않는다', async () => {
    const { requests } = grant('tok')
    const a = createGoogleAuth('cid', new MemStorage(), () => 0)
    await a.acquire({ interactive: true, loginHint: 'a@example.test', selectAccount: true })
    expect(requests[0]).toEqual({ prompt: 'select_account' })
  })

  it('GIS 가 이미 불러와져 있으면 같은 동작 안에서 바로 팝업을 요청한다 (await 이전)', () => {
    const { requests } = grant('tok')
    const a = createGoogleAuth('cid', new MemStorage(), () => 0)
    void a.acquire({ interactive: true })
    expect(requests).toHaveLength(1) // 동기 호출 직후 이미 요청됨
  })
})
