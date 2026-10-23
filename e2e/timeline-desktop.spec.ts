import { expect, test } from '@playwright/test'
import { expectLayoutOk } from './fixtures'
import { expectLabelsSeparate, openGestureTimeline, viewportState } from './timeline-gestures'

test('PC 휠은 페이지 스크롤, Ctrl+휠은 포인터 중심 확대, 드래그 후 클릭', async ({ page }) => {
  const trips = await openGestureTimeline(page)
  const sc = page.locator('.tl-scroller')
  const box = (await sc.boundingBox())!
  const x = box.x + box.width * 0.7, y = box.y + 22
  await page.mouse.move(x, y)
  const initial = await viewportState(page, 0.7)
  const sy = await page.evaluate(() => window.scrollY)
  await page.mouse.wheel(0, 60)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(sy)
  expect((await viewportState(page)).scale).toBe(initial.scale)
  await sc.scrollIntoViewIfNeeded()
  const b = (await sc.boundingBox())!
  await page.mouse.move(b.x + b.width * 0.7, b.y + 22)
  const before = await viewportState(page, 0.7)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await viewportState(page)).scale).toBeGreaterThan(before.scale)
  const zoomed = await viewportState(page, 0.7)
  expect(Math.abs(zoomed.minute - before.minute)).toBeLessThan(1 / zoomed.scale)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width * 0.7 - 80, b.y + 22, { steps: 8 })
  await page.mouse.up()
  expect((await viewportState(page)).left).toBeGreaterThan(zoomed.left + 70)
  await expect(page.getByTestId('tl-detail')).toHaveCount(0)
  // A quick move outside the graph must still end the drag cleanly.
  await page.mouse.move(b.x + 5, b.y + 22)
  const edge = (await viewportState(page)).left
  await page.mouse.down()
  await page.mouse.move(b.x - 30, b.y + 22)
  await page.mouse.up()
  expect((await viewportState(page)).left).toBeGreaterThan(edge + 25)
  const released = (await viewportState(page)).left
  await page.mouse.move(b.x + 40, b.y + 22)
  expect((await viewportState(page)).left).toBe(released)
  await page.getByRole('button', { name: '이동 시간대', exact: true }).click()
  await page.locator(`.tl-item[data-trip-id="${trips[0].id}"]`).click()
  await expect(page.getByTestId('tl-detail')).toContainText('08:01')
  await expectLabelsSeparate(page)
  // Automatic ticks reach minute precision without changing stored coordinates.
  for (let i = 0; i < 40 && Number(await page.locator('.tl-svg').getAttribute('data-tick-step')) > 1; i++) {
    await page.getByRole('button', { name: '확대', exact: true }).click()
  }
  await expect(page.locator('.tl-svg')).toHaveAttribute('data-tick-step', '1')
  await expectLabelsSeparate(page)
  await page.getByRole('button', { name: '24시간 전체' }).click()
  await expectLabelsSeparate(page)
  await expectLayoutOk(page, 'desktop gestures')
  await page.getByTestId('day-timeline').screenshot({ path: 'test-results/screens/timeline-gestures-desktop.png' })
})
