import { expect, test } from '@playwright/test'
import { expectLayoutOk } from './fixtures'
import { expectLabelsSeparate, openGestureTimeline, viewportState } from './timeline-gestures'

for (const width of [320, 360]) {
  test(`${width}px 연속 보기 압축, 정확한 좌표, 핀치 중심과 터치 이동`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 })
    const trips = await openGestureTimeline(page)
    await page.getByTestId('day-timeline').screenshot({ path: `test-results/screens/timeline-continuous-${width}.png` })
    await page.locator(`.tl-item[data-trip-id="${trips[0].id}"]`).tap()
    await expect(page.getByTestId('tl-detail')).toContainText('08:01')
    await page.getByTestId('tl-detail').getByRole('button', { name: '닫기' }).click()
    const svg = page.locator('.tl-svg')
    await expect(svg).toHaveAttribute('data-grouping', 'continuous')
    expect(Number(await svg.getAttribute('height'))).toBe(74)
    await expect(page.locator('.tl-legend-fold')).not.toHaveAttribute('open')
    await page.locator('.tl-legend-fold summary').click()
    await expect(page.getByRole('list', { name: '범례', exact: true })).toBeVisible()
    await page.locator('.tl-legend-fold summary').click()
    await page.getByRole('button', { name: '노선별 보기' }).click()
    expect(Number(await svg.getAttribute('height'))).toBe(162)
    await page.getByTestId('day-timeline').screenshot({ path: `test-results/screens/timeline-lines-${width}.png` })
    await page.getByRole('button', { name: '연속 보기' }).click()
    await expectLabelsSeparate(page)
    const before = await viewportState(page)
    await page.getByRole('button', { name: '확대', exact: true }).click()
    const after = await viewportState(page)
    expect(after.scale / before.scale).toBeCloseTo(1.25, 4)
    expect(Math.abs(after.minute - before.minute)).toBeLessThan(1 / after.scale)

    const sc = page.locator('.tl-scroller')
    await sc.scrollIntoViewIfNeeded()
    const box = (await sc.boundingBox())!
    const x = box.x + box.width / 2, y = box.y + 22
    const cdp = await page.context().newCDPSession(page)
    const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', distance: number) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x: x - distance / 2, y, id: 1 }, { x: x + distance / 2, y, id: 2 }],
    })
    const pinchBefore = await viewportState(page)
    await touch('touchStart', 60)
    for (const d of [70, 85, 100, 120]) await touch('touchMove', d)
    await touch('touchEnd', 0)
    await expect.poll(async () => (await viewportState(page)).scale).toBeGreaterThan(pinchBefore.scale * 1.8)
    const pinched = await viewportState(page)
    expect(Math.abs(pinched.minute - pinchBefore.minute)).toBeLessThan(1 / pinched.scale)
    const dragStart = pinched.left
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    for (const dx of [10, 25, 45, 60]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - dx, y, id: 1 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    expect((await viewportState(page)).left).toBeGreaterThan(dragStart + 45)
    await expect(page.getByTestId('tl-detail')).toHaveCount(0)

    await page.getByRole('button', { name: '이동 시간대', exact: true }).click()
    const item = page.locator(`.tl-item[data-trip-id="${trips[0].id}"]`)
    const scale = (await viewportState(page)).scale
    expect(Number(await item.getAttribute('data-x'))).toBeCloseTo(481 * scale, 6)
    expect(Number(await item.getAttribute('data-w'))).toBeCloseTo(20 * scale, 6)
    await item.scrollIntoViewIfNeeded()
    await item.tap()
    await expect(page.getByTestId('tl-detail')).toContainText('08:01')
    await expectLabelsSeparate(page)
    await expectLayoutOk(page, `gesture ${width}`)
    await page.getByTestId('day-timeline').screenshot({ path: `test-results/screens/timeline-gestures-${width}.png` })
    // Check native vertical scrolling last: a tap during its inertial animation
    // is consumed by Chromium to stop that animation, as on a physical phone.
    await sc.scrollIntoViewIfNeeded()
    const verticalBox = (await sc.boundingBox())!
    const vx = verticalBox.x + verticalBox.width / 2, vy = verticalBox.y + 22
    const verticalStart = await page.evaluate(() => window.scrollY)
    const horizontalStart = (await viewportState(page)).left
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vx, y: vy, id: 1 }] })
    for (const dy of [10, 25, 50, 80]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vx, y: vy - dy, id: 1 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(verticalStart + 10)
    expect(Math.abs((await viewportState(page)).left - horizontalStart)).toBeLessThan(2)
    await cdp.detach()
  })
}
