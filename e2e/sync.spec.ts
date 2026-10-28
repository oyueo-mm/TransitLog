import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { expectLayoutOk, expectNoSeriousA11y, fakeTrip, gotoApp, readDb, restoreBackup } from './fixtures'

/**
 * Google Drive 동기화.
 *  - 클라이언트 ID 없이 빌드된 경우: ‘설정 필요’ 안내만 나오고 다른 기능에 영향이 없다.
 *  - 클라이언트 ID 가 있는 경우(VITE_GOOGLE_CLIENT_ID=… 로 빌드): Google 로그인 스크립트와 Drive API 를 가상 서버로 대체해
 *    서로 다른 두 브라우저 컨텍스트(=두 기기) 사이의 실제 동기화 흐름을 검증한다. 실제 Google 계정·네트워크는 쓰지 않는다.
 */
const configured = !!process.env.VITE_GOOGLE_CLIENT_ID

const FAKE_GIS = `
window.__gisRequests = [];
window.google = { accounts: { oauth2: {
  initTokenClient: (cfg) => ({ requestAccessToken: (r) => { window.__gisRequests.push(r || {}); setTimeout(() => {
    const mode = sessionStorage.getItem('e2e.gis')
    if (mode === 'denied') cfg.callback({ error: 'access_denied' })
    else if (mode === 'blocked') cfg.error_callback && cfg.error_callback({ type: 'popup_failed_to_open' })
    else if (mode === 'closed') cfg.error_callback && cfg.error_callback({ type: 'popup_closed' })
    else cfg.callback({ access_token: 'fake-token', expires_in: 3600 })
  }, 0) } }),
  revoke: (t, cb) => { window.__revoked = (window.__revoked || 0) + 1; sessionStorage.setItem('e2e.revoked', String(window.__revoked)); cb && cb() },
  hasGrantedAllScopes: () => true,
} } };`

/** 메모리 안의 가상 Drive (두 컨텍스트가 공유) */
class MockDrive {
  file: { id: string; text: string; version: number } | null = null
  fail401 = 0
  email = 'tester@example.test'
  permissionId = 'p-1'
  /** PATCH(쓰기) 응답을 늦춰 ‘동기화 중 새로고침’을 재현한다 */
  patchDelayMs = 0
  requests: string[] = []

  async attach(ctx: BrowserContext) {
    await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_GIS }))
    await ctx.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request()
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE' }
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      expect(req.headers().authorization).toBe('Bearer fake-token')
      const url = new URL(req.url())
      this.requests.push(`${req.method()} ${url.pathname}`)
      const json = (body: unknown, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) })
      if (this.fail401 > 0) {
        this.fail401--
        return json({ error: { code: 401 } }, 401)
      }
      if (url.pathname === '/drive/v3/about') return json({ user: { emailAddress: this.email, permissionId: this.permissionId } })
      if (url.pathname === '/drive/v3/files' && req.method() === 'GET') {
        expect(url.searchParams.get('spaces')).toBe('appDataFolder')
        return json({ files: this.file ? [{ id: this.file.id, version: String(this.file.version), createdTime: '2026-01-01T00:00:00Z' }] : [] })
      }
      const m = url.pathname.match(/\/files\/([^/]+)$/)
      if (m && req.method() === 'GET') {
        if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: this.file!.text })
        return json({ id: this.file!.id, version: String(this.file!.version) })
      }
      if (url.pathname === '/upload/drive/v3/files' && req.method() === 'POST') {
        const body = req.postData() ?? ''
        expect(body).toContain('appDataFolder')
        const text = body.split('\r\n\r\n').slice(2).join('\r\n\r\n').replace(/\r\n--[^\r\n]+--\s*$/, '')
        this.file = { id: 'mock-file', text, version: 1 }
        return json({ id: this.file.id, version: String(this.file.version), createdTime: '2026-01-01T00:00:00Z' })
      }
      if (m && req.method() === 'PATCH') {
        if (this.patchDelayMs) await new Promise((r) => setTimeout(r, this.patchDelayMs))
        this.file!.text = req.postData() ?? ''
        this.file!.version++
        return json({ id: this.file!.id, version: String(this.file!.version) })
      }
      return json({ error: 'unexpected' }, 400)
    })
  }
}

interface TripRow {
  id: string
  line: string | null
  kind: string
}

async function openSync(page: Page) {
  await gotoApp(page, 'settings')
  return page.locator('section', { hasText: 'Google Drive 동기화' }).first()
}

test.describe('Google Drive 동기화 — 설정 전 배포', () => {
  test.skip(configured, '클라이언트 ID 로 빌드된 경우에는 아래 연결 테스트를 사용')

  test('설정 필요 안내만 보이고 Google 스크립트를 불러오지 않는다', async ({ page }) => {
    const google: string[] = []
    page.on('request', (r) => /google/.test(new URL(r.url()).hostname) && google.push(r.url()))
    const section = await openSync(page)
    await expect(section).toContainText('설정되어 있지 않아')
    await expect(page.getByRole('button', { name: 'Google 계정 연결' })).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(google).toEqual([])
    await expectNoSeriousA11y(page, '동기화 설정 전')
  })

  test('기존 백업·복원 기능은 그대로 동작한다', async ({ page }) => {
    const t = fakeTrip({ line: '1호선', boardTime: '08:00' })
    await restoreBackup(page, { trips: [t] })
    expect(await readDb<TripRow>(page, 'trips')).toHaveLength(1)
  })
})

test.describe('Google Drive 동기화 — 연결됨(가상 Drive)', () => {
  test.skip(!configured, 'VITE_GOOGLE_CLIENT_ID 로 빌드했을 때만 실행')

  test('두 기기 사이에서 기록이 양방향으로 전달된다', async ({ browser, baseURL }) => {
    const drive = new MockDrive()
    const mk = async () => {
      const ctx = await browser.newContext({ baseURL: baseURL!, locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })
      await drive.attach(ctx)
      return { ctx, page: await ctx.newPage() }
    }
    const A = await mk()
    const B = await mk()
    try {
      const t1 = fakeTrip({ line: '1호선', boardTime: '08:00', kind: 'observed' })
      await restoreBackup(A.page, { trips: [t1] })

      // A: 연결 → 확인 전에는 Drive 에 아무것도 없다
      await gotoApp(A.page, 'settings')
      await A.page.getByRole('button', { name: 'Google 계정 연결' }).click()
      await expect(A.page.getByRole('alertdialog', { name: '처음 연결 확인' })).toBeVisible()
      expect(drive.file).toBeNull()
      await expectLayoutOk(A.page, '동기화 확인 360px')
      await A.page.getByRole('button', { name: '합치고 동기화 시작' }).click()
      await expect(A.page.getByRole('status').filter({ hasText: '동기화 완료' })).toBeVisible()
      await expect(A.page.getByText('tester@example.test')).toBeVisible()
      expect(drive.file?.text).toContain(t1.id)

      // B: 같은 계정으로 연결 → A 의 기록이 들어온다
      await gotoApp(B.page, 'settings')
      await B.page.getByRole('button', { name: 'Google 계정 연결' }).click()
      await B.page.getByRole('button', { name: '합치고 동기화 시작' }).click()
      await expect(B.page.getByRole('status').filter({ hasText: '동기화 완료' })).toBeVisible()
      expect((await readDb<TripRow>(B.page, 'trips')).map((t) => t.id)).toEqual([t1.id])

      // B 에서 관찰 기록 추가 → 자동 동기화(저장 후) → A 에서 지금 동기화하면 보인다
      await gotoApp(B.page, 'quick')
      await B.page.getByRole('group', { name: '기록 종류' }).getByRole('button', { name: '관찰', exact: true }).click()
      await B.page.getByRole('group', { name: '노선 선택' }).getByRole('button', { name: '2호선', exact: true }).click()
      await B.page.getByLabel('관찰역 직접 입력').fill('가역')
      await B.page.getByRole('button', { name: '관찰 기록 저장' }).click()
      await expect.poll(() => drive.file?.text.includes('가역'), { timeout: 15_000 }).toBe(true)

      await gotoApp(A.page, 'settings')
      await A.page.getByRole('button', { name: '지금 동기화' }).click()
      await expect.poll(async () => (await readDb<TripRow>(A.page, 'trips')).length, { timeout: 15_000 }).toBe(2)
      const rows = await readDb<TripRow>(A.page, 'trips')
      expect(rows.some((r) => r.kind === 'observed' && r.line === '2호선')).toBe(true)

      // 연결 해제: 기록은 남는다
      A.page.once('dialog', (d) => d.accept())
      await A.page.getByRole('button', { name: '이 기기에서 연결 해제' }).click()
      await expect(A.page.getByRole('button', { name: 'Google 계정 연결' })).toBeVisible()
      expect(await readDb<TripRow>(A.page, 'trips')).toHaveLength(2)
      // 이 기기만 해제: Google 권한 철회(revoke)는 호출되지 않았고, 저장된 로그인도 지워졌다
      expect(await A.page.evaluate(() => sessionStorage.getItem('e2e.revoked'))).toBeNull()
      expect(await A.page.evaluate(() => sessionStorage.getItem('transitlog.gtoken'))).toBeNull()
      // 다른 기기(B)는 계속 동기화된다
      await gotoApp(B.page, 'settings')
      await B.page.getByRole('button', { name: '지금 동기화' }).click()
      await expect(B.page.getByRole('status').filter({ hasText: '동기화 완료' })).toBeVisible()
      expect(await readDb<TripRow>(B.page, 'trips')).toHaveLength(2)
    } finally {
      await A.ctx.close()
      await B.ctx.close()
    }
  })

  test('로그인이 만료(401)되면 재인증 필요를 표시하고 기록은 유지된다', async ({ browser, baseURL }) => {
    const drive = new MockDrive()
    const ctx = await browser.newContext({ baseURL: baseURL!, locale: 'ko-KR', viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true })
    await drive.attach(ctx)
    const page = await ctx.newPage()
    try {
      await restoreBackup(page, { trips: [fakeTrip({ line: '1호선' })] })
      await gotoApp(page, 'settings')
      await page.getByRole('button', { name: 'Google 계정 연결' }).click()
      await page.getByRole('button', { name: '합치고 동기화 시작' }).click()
      await expect(page.getByRole('status').filter({ hasText: '동기화 완료' })).toBeVisible()
      drive.fail401 = 99
      await page.getByRole('button', { name: '지금 동기화' }).click()
      await expect(page.getByRole('status').filter({ hasText: '재인증 필요' })).toBeVisible()
      await expect(page.getByRole('button', { name: '다시 연결' })).toBeVisible()
      expect(await readDb<TripRow>(page, 'trips')).toHaveLength(1)
      await expectLayoutOk(page, '재인증 320px')
      drive.fail401 = 0
      await page.getByRole('button', { name: '다시 연결' }).click()
      await expect(page.getByRole('status').filter({ hasText: '동기화 완료' })).toBeVisible()
    } finally {
      await ctx.close()
    }
  })
})

async function connectedPage(browser: import('@playwright/test').Browser, baseURL: string, drive: MockDrive, width = 360) {
  const ctx = await browser.newContext({ baseURL, locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width, height: 740 }, hasTouch: true, isMobile: true })
  await drive.attach(ctx)
  const page = await ctx.newPage()
  await restoreBackup(page, { trips: [fakeTrip({ line: '1호선', boardTime: '08:00' })] })
  await gotoApp(page, 'settings')
  await page.getByRole('button', { name: 'Google 계정 연결' }).click()
  await page.getByRole('button', { name: '합치고 동기화 시작' }).click()
  await expect(page.getByRole('status').filter({ hasText: '동기화 완료' })).toBeVisible()
  return { ctx, page }
}
const done = (page: Page) => expect(page.getByRole('status').filter({ hasText: '동기화 완료' })).toBeVisible()

test.describe('Google Drive 동기화 — 새로고침과 재인증(가상 Drive)', () => {
  test.skip(!configured, 'VITE_GOOGLE_CLIENT_ID 로 빌드했을 때만 실행')

  test('F5: 로그인이 남아 있으면 다시 연결 없이 연결 상태가 유지되고, 토큰은 이 탭의 sessionStorage 에만 있다', async ({ browser, baseURL }) => {
    const drive = new MockDrive()
    const { ctx, page } = await connectedPage(browser, baseURL!, drive)
    try {
      await page.evaluate(() => (window as unknown as { __gisRequests: unknown[] }).__gisRequests.length)
      await page.reload()
      await expect(page.getByText('tester@example.test')).toBeVisible()
      await done(page)
      await expect(page.getByRole('button', { name: '다시 연결' })).toHaveCount(0)
      // 새로고침 뒤 로그인 창을 다시 요청하지 않았다
      expect(await page.evaluate(() => (window as unknown as { __gisRequests?: unknown[] }).__gisRequests?.length ?? 0)).toBe(0)
      // 토큰은 sessionStorage 에만 있고 만료 시각이 함께 저장된다. localStorage·IndexedDB 설정에는 없다
      const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('transitlog.gtoken') ?? 'null'))
      expect(stored.t).toBe('fake-token')
      expect(stored.exp).toBeGreaterThan(Date.now())
      expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('fake-token')
      expect(JSON.stringify(await readDb(page, 'settings'))).not.toContain('fake-token')
      expect(JSON.stringify(await readDb(page, 'syncMeta'))).not.toContain('fake-token')
      expect(page.url()).not.toContain('fake-token')
    } finally {
      await ctx.close()
    }
  })

  test('저장된 토큰이 만료되었으면 쓰지 않고 재인증 필요를 표시하며 계정·마지막 동기화는 유지된다. 다시 연결하면 이어진다', async ({ browser, baseURL }) => {
    const drive = new MockDrive()
    const { ctx, page } = await connectedPage(browser, baseURL!, drive, 320)
    try {
      await page.evaluate(() => {
        const s = JSON.parse(sessionStorage.getItem('transitlog.gtoken')!)
        s.exp = Date.now() - 1000
        sessionStorage.setItem('transitlog.gtoken', JSON.stringify(s))
      })
      const before = drive.requests.length
      await page.reload()
      await expect(page.getByRole('status').filter({ hasText: '재인증 필요' })).toBeVisible()
      await expect(page.getByText('tester@example.test')).toBeVisible()
      await expect(page.getByRole('button', { name: '다시 연결' })).toBeVisible()
      expect(drive.requests.length).toBe(before) // 만료된 토큰으로 Drive 를 호출하지 않았다
      expect(await page.evaluate(() => sessionStorage.getItem('transitlog.gtoken'))).toBeNull()
      expect(await readDb<TripRow>(page, 'trips')).toHaveLength(1)
      await expectLayoutOk(page, '재인증 필요 320px')
      await expectNoSeriousA11y(page, '재인증 필요')
      // 재인증 필요 중에도 기록 저장은 된다
      await gotoApp(page, 'quick')
      await page.getByRole('button', { name: '하차 기록 없이 저장' }).click()
      await expect.poll(async () => (await readDb<TripRow>(page, 'trips')).length).toBe(2)
      await gotoApp(page, 'settings')
      await page.getByRole('button', { name: '다시 연결' }).click()
      await done(page)
      // 계정 힌트가 전달되었다
      expect(await page.evaluate(() => (window as unknown as { __gisRequests: Array<{ login_hint?: string }> }).__gisRequests.at(-1)?.login_hint)).toBe('tester@example.test')
      await expect.poll(() => (drive.file?.text.match(/"k":"trips:/g) ?? []).length).toBe(2)
    } finally {
      await ctx.close()
    }
  })

  test('재인증 중 팝업 차단·창 닫기는 재인증 필요를 유지하고 이유를 알린다', async ({ browser, baseURL }) => {
    const drive = new MockDrive()
    const { ctx, page } = await connectedPage(browser, baseURL!, drive)
    try {
      await page.evaluate(() => {
        sessionStorage.removeItem('transitlog.gtoken')
        sessionStorage.setItem('e2e.gis', 'blocked')
      })
      await page.reload()
      await page.getByRole('button', { name: '다시 연결' }).click()
      await expect(page.getByText(/로그인 창이 차단/)).toBeVisible()
      await expect(page.getByRole('status').filter({ hasText: '재인증 필요' })).toBeVisible()
      await page.evaluate(() => sessionStorage.setItem('e2e.gis', 'closed'))
      await page.getByRole('button', { name: '다시 연결' }).click()
      await expect(page.getByText(/로그인 창이 닫혀/)).toBeVisible()
      await page.evaluate(() => sessionStorage.removeItem('e2e.gis'))
      await page.getByRole('button', { name: '다시 연결' }).click()
      await done(page)
    } finally {
      await ctx.close()
    }
  })

  test('권한 철회는 경고를 확인했을 때만 revoke 를 호출한다 (이 기기 연결 해제와 구분)', async ({ browser, baseURL }) => {
    const drive = new MockDrive()
    const { ctx, page } = await connectedPage(browser, baseURL!, drive)
    try {
      await page.getByText('고급: Google 접근 권한 철회').click()
      let message = ''
      page.once('dialog', (d) => (message = d.message(), void d.dismiss()))
      await page.getByRole('button', { name: /Google 접근 권한 철회/ }).click()
      await expect.poll(() => message).toContain('다른 기기')
      expect(await page.evaluate(() => sessionStorage.getItem('e2e.revoked'))).toBeNull() // 취소하면 호출 없음
      page.once('dialog', (d) => d.accept())
      await page.getByRole('button', { name: /Google 접근 권한 철회/ }).click()
      await expect(page.getByRole('button', { name: 'Google 계정 연결' })).toBeVisible()
      expect(await page.evaluate(() => sessionStorage.getItem('e2e.revoked'))).toBe('1')
      expect(await readDb<TripRow>(page, 'trips')).toHaveLength(1) // 기록 유지
      expect(drive.file?.text).toContain('trips:') // Drive 기록 유지
    } finally {
      await ctx.close()
    }
  })

  test('동기화 중 새로고침해도 기록이 중복·유실되지 않고 다시 이어진다', async ({ browser, baseURL }) => {
    const drive = new MockDrive()
    const { ctx, page } = await connectedPage(browser, baseURL!, drive)
    try {
      await restoreBackup(page, { trips: [fakeTrip({ line: '2호선', boardTime: '09:00' })] })
      await gotoApp(page, 'settings')
      drive.patchDelayMs = 1500
      await page.getByRole('button', { name: '지금 동기화' }).click()
      await expect(page.getByRole('status').filter({ hasText: '동기화 중' })).toBeVisible()
      await page.reload() // 쓰기 응답을 기다리는 중에 새로고침
      drive.patchDelayMs = 0
      await done(page)
      await expect.poll(() => (drive.file?.text.match(/"k":"trips:/g) ?? []).length).toBe(2)
      expect(await readDb<TripRow>(page, 'trips')).toHaveLength(2)
    } finally {
      await ctx.close()
    }
  })

  test('다른 Google 계정으로 로그인하면 확인 전에는 새 계정에 올리지 않는다', async ({ browser, baseURL }) => {
    const drive = new MockDrive()
    const { ctx, page } = await connectedPage(browser, baseURL!, drive)
    try {
      const other = new MockDrive()
      other.email = 'other@example.test'
      other.permissionId = 'p-2'
      await ctx.unroute('https://www.googleapis.com/**')
      await other.attach(ctx)
      await page.getByRole('button', { name: '지금 동기화' }).click() // 같은 토큰으로 다른 계정 Drive 에 접속한 상황
      await expect(page.getByRole('alertdialog', { name: '다른 계정 연결 확인' })).toBeVisible()
      expect(other.file).toBeNull()
      expect(await readDb<TripRow>(page, 'trips')).toHaveLength(1)
    } finally {
      await ctx.close()
    }
  })
})
