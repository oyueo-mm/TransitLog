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
