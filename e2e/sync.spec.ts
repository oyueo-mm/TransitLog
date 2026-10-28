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
window.google = { accounts: { oauth2: {
  initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => {
    if (window.__gisFail) cfg.callback({ error: 'access_denied' })
    else cfg.callback({ access_token: 'fake-token', expires_in: 3600 })
  }, 0) }),
  revoke: (t, cb) => cb && cb(),
  hasGrantedAllScopes: () => true,
} } };`

/** 메모리 안의 가상 Drive (두 컨텍스트가 공유) */
class MockDrive {
  file: { id: string; text: string; version: number } | null = null
  fail401 = 0
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
      if (url.pathname === '/drive/v3/about') return json({ user: { emailAddress: 'tester@example.test', permissionId: 'p-1' } })
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
      await A.page.getByRole('button', { name: '연결 해제' }).click()
      await expect(A.page.getByRole('button', { name: 'Google 계정 연결' })).toBeVisible()
      expect(await readDb<TripRow>(A.page, 'trips')).toHaveLength(2)
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
