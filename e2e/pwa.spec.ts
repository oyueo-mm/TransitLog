import { expect, test } from '@playwright/test'
import { gotoApp, readDb, recordRide } from './fixtures'

async function waitForControl(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
}

test.describe('PWA: /TransitLog/ 경로 설정', () => {
  test('서비스 워커 범위와 캐시 경로가 /TransitLog/ 아래에 있다', async ({ page }) => {
    await gotoApp(page, '')
    await waitForControl(page)
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      const urls: string[] = []
      for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(req.url)
      return { scope: reg.scope, script: reg.active?.scriptURL ?? '', urls }
    })
    expect(new URL(info.scope).pathname).toBe('/TransitLog/')
    expect(new URL(info.script).pathname).toBe('/TransitLog/sw.js')
    expect(info.urls.length).toBeGreaterThan(5)
    for (const u of info.urls) expect(new URL(u).pathname.startsWith('/TransitLog/'), u).toBe(true)
    // 앱 셸과 pdf.js 워커가 미리 캐시되어 오프라인에서도 가져오기 화면이 열린다
    expect(info.urls.some((u) => /pdf\.worker/.test(u))).toBe(true)
    expect(info.urls.some((u) => /index\.html|\/TransitLog\/$/.test(u))).toBe(true)
  })

  test('Chrome 설치 가능성 검사(Installability)에서 오류가 없다', async ({ page, context }) => {
    await gotoApp(page, '')
    await waitForControl(page)
    const cdp = await context.newCDPSession(page)
    const res = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: Array<{ errorId: string }> }
    expect(res.installabilityErrors.map((e) => e.errorId)).toEqual([])
    const manifest = (await cdp.send('Page.getAppManifest')) as { url?: string; errors?: Array<{ message: string }> }
    expect(manifest.errors ?? []).toEqual([])
  })

  test('오프라인에서 홈(시작 주소)·하위 화면이 열리고 기록이 남는다', async ({ page, context }) => {
    await gotoApp(page, '')
    await waitForControl(page)
    await context.setOffline(true)
    // 시작 주소(start_url)로 직접 진입
    await page.goto('./')
    await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible()
    await gotoApp(page, 'import') // pdf.js 를 쓰는 화면
    await expect(page.getByRole('heading', { name: '기존 노트 가져오기' })).toBeVisible()
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await page.goto('./')
    await page.reload()
    await expect(page.locator('.card', { hasText: '가역 → 나역' })).toBeVisible()
    await context.setOffline(false)
  })

  test('앱 캐시를 지우고 서비스 워커를 교체해도(업데이트 상황) 저장된 기록은 사라지지 않는다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await waitForControl(page)
    const before = await readDb(page, 'trips')
    expect(before).toHaveLength(1)

    await page.evaluate(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
      for (const k of await caches.keys()) await caches.delete(k)
    })
    await page.reload()
    await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible()
    await gotoApp(page, '')
    await expect(page.locator('.card', { hasText: '가역 → 나역' })).toBeVisible()
    expect(await readDb(page, 'trips')).toEqual(before)

    // 새 서비스 워커가 다시 등록되어도 마찬가지
    await waitForControl(page)
    expect(await readDb(page, 'trips')).toEqual(before)
    expect(await readDb(page, 'seatEvents')).toHaveLength(1)
  })

  test('시작 시 저장소 보호를 요청하고 데이터를 지우는 코드 경로가 없다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    // 새로고침을 여러 번 해도(서비스 워커 갱신 포함) 데이터 유지
    for (let i = 0; i < 3; i++) await page.reload()
    expect(await readDb(page, 'trips')).toHaveLength(1)
  })
})
