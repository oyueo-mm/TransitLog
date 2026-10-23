import { expect, type Page } from '@playwright/test'
import { fakeTrip, gotoApp, restoreBackup } from './fixtures'

export async function openGestureTimeline(page: Page) {
  const trips = [
    fakeTrip({ line: '수인분당선', boardTime: '08:01', alightTime: '08:21', initialSeat: 'standing' }),
    fakeTrip({ line: '1호선', boardTime: '08:26', alightTime: '08:46', initialSeat: 'seated' }),
    fakeTrip({ line: '2호선', boardTime: '09:01', alightTime: '09:31' }),
  ]
  await restoreBackup(page, { trips })
  await gotoApp(page, 'day/2026-03-02')
  await expect(page.locator('.tl-item')).toHaveCount(3)
  await page.locator('.tl-scroller').scrollIntoViewIfNeeded()
  return trips
}

export async function viewportState(page: Page, fraction = 0.5) {
  return page.locator('.tl-scroller').evaluate((el, f) => {
    const scale = Number(el.querySelector('svg')!.getAttribute('data-px-per-min'))
    return { scale, left: el.scrollLeft, minute: (el.scrollLeft + el.clientWidth * f) / scale, width: el.clientWidth }
  }, fraction)
}

export async function expectLabelsSeparate(page: Page) {
  const collisions = await page.locator('.tl-svg').evaluate(svg => {
    const texts = [...svg.querySelectorAll<SVGTextElement>('text')].map(el => ({ text: el.textContent, r: el.getBBox() }))
    return texts.flatMap((a, i) => texts.slice(i + 1).filter(b => a.r.x < b.r.x + b.r.width && b.r.x < a.r.x + a.r.width && a.r.y < b.r.y + b.r.height && b.r.y < a.r.y + a.r.height).map(b => `${a.text}/${b.text}`))
  })
  expect(collisions).toEqual([])
}
