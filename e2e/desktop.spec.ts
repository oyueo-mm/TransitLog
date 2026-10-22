import { expect, test } from '@playwright/test'
import { gotoApp, recordRide } from './fixtures'

// Windows PC 환경(넓은 화면, 마우스·키보드)
test('데스크톱에서도 같은 흐름으로 기록하고 캘린더·통계에서 확인할 수 있다', async ({ page }) => {
  await recordRide(page, { line: '2호선', board: '가역', alight: '나역' })
  await gotoApp(page, 'calendar')
  const today = new Date().getDate()
  await page.getByRole('button', { name: new RegExp(`^\\d+월 ${today}일, 탑승 1건`) }).click()
  await expect(page.locator('.card', { hasText: '2호선' })).toBeVisible()

  await gotoApp(page, 'stats')
  await expect(page.locator('.totals > div', { hasText: '탑승' }).first()).toContainText('1회')

  // 내용이 한 칼럼 폭으로 가운데에 놓이고 가로 스크롤이 없다
  const box = await page.locator('.page').first().boundingBox()
  expect(box!.width).toBeLessThanOrEqual(700)
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  expect(sw).toBeLessThanOrEqual(cw)
})

test('키보드만으로 빠른 기록을 시작할 수 있다', async ({ page }) => {
  await gotoApp(page, 'quick')
  await page.getByRole('button', { name: '지금 탑승' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
})
