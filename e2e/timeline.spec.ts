import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { expectLayoutOk, expectNoSeriousA11y, fakeEvent, fakeTrip, gotoApp, recordRide, restoreBackup, setTime } from './fixtures'

const D = '2026-03-02'
const OUT = 'test-results/screens'

/** 가상의 하루: 서로 다른 노선 둘, 같은 노선 반복, 겹치는 구간, 좌석 변화 */
function seed() {
  const a = fakeTrip({ date: D, line: '1호선', boardPlace: '가가역', alightPlace: '나나역', boardTime: '08:24', alightTime: '09:20', initialSeat: 'standing', seatLogComplete: true })
  const b = fakeTrip({ date: D, line: '2호선', boardPlace: '다다역', alightPlace: '라라역', boardTime: '12:00', alightTime: '12:30', initialSeat: 'seated' })
  const c = fakeTrip({ date: D, line: '1호선', boardPlace: '나나역', alightPlace: '마마역', boardTime: '18:00', alightTime: '18:40' })
  const d = fakeTrip({ date: D, line: '수인분당선', boardPlace: '바바역', alightPlace: '사사역', boardTime: '18:10', alightTime: '18:50', initialSeat: 'standing' })
  const trips = [a, b, c, d]
  const seatEvents = [fakeEvent(a.id, { time: '08:30', state: 'seated', place: '나나역' })]
  return { trips, seatEvents, a, b, c, d }
}

async function openDay(page: Page, date = D) {
  await gotoApp(page, `day/${date}`)
  await expect(page.getByTestId('day-timeline')).toBeVisible()
}

test.describe('하루 이동 타임라인', () => {
  test('막대 위치·길이가 시각에 비례하고, 같은 노선 반복·겹침이 모두 보인다', async ({ page }) => {
    const s = seed()
    await restoreBackup(page, s)
    await openDay(page)
    const svg = page.locator('svg.tl-svg')
    const ppm = Number(await svg.getAttribute('data-px-per-min'))
    const bar = (id: string) => svg.locator(`g.tl-item[data-trip-id="${id}"]`)
    // 모든 탑승이 별도의 막대로 그려진다
    await expect(svg.locator('g.tl-item')).toHaveCount(4)
    for (const t of [s.a, s.b, s.c, s.d]) {
      const g = bar(t.id)
      const start = Number(await g.getAttribute('data-start'))
      const end = Number(await g.getAttribute('data-end'))
      const x = Number(await g.getAttribute('data-x'))
      const w = Number(await g.getAttribute('data-w'))
      const [bh, bm] = t.boardTime!.split(':').map(Number)
      const [ah, am] = t.alightTime!.split(':').map(Number)
      expect(start).toBe(bh * 60 + bm)
      expect(end).toBe(ah * 60 + am)
      expect(x).toBeCloseTo(start * ppm, 1)
      expect(w).toBeCloseTo((end - start) * ppm, 1)
    }
    // 각 항목의 중심(막대+레이블 영역의 중심)을 눌러도 그 항목이 눌린다 (글꼴 폭이 달라도 눌림 영역이 어긋나지 않음)
    const wrong = await page.evaluate(() => {
      const out: string[] = []
      for (const g of document.querySelectorAll<SVGGElement>('svg.tl-svg g.tl-item')) {
        g.scrollIntoView({ block: 'center', inline: 'center' })
        const r = g.getBoundingClientRect()
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (el?.closest('g.tl-item') !== g) out.push(g.getAttribute('data-trip-id') ?? '?')
      }
      return out
    })
    expect(wrong).toEqual([])
    // 1호선이 같은 날 두 번 → 두 막대
    await expect(svg.locator('g.tl-item[aria-label^="1호선"]')).toHaveCount(2)
    await expect(page.getByTestId('tl-untimed')).toHaveCount(0)
  })

  test('좌석 변화에서 막대가 서서/앉아서 구간으로 나뉜다', async ({ page }) => {
    const s = seed()
    await restoreBackup(page, s)
    await openDay(page)
    const segs = page.locator(`g.tl-item[data-trip-id="${s.a.id}"] rect[data-seg-state]`)
    await expect(segs).toHaveCount(2)
    await expect(segs.nth(0)).toHaveAttribute('data-seg-state', 'standing')
    await expect(segs.nth(0)).toHaveAttribute('data-seg-start', String(8 * 60 + 24))
    await expect(segs.nth(0)).toHaveAttribute('data-seg-end', String(8 * 60 + 30))
    await expect(segs.nth(1)).toHaveAttribute('data-seg-state', 'seated')
    await expect(segs.nth(1)).toHaveAttribute('data-seg-end', String(9 * 60 + 20))
    // 좌석 기록이 없는 탑승(c)은 미확인으로만 표시된다
    const unk = page.locator(`g.tl-item[data-trip-id="${s.c.id}"] rect[data-seg-state]`)
    await expect(unk).toHaveCount(1)
    await expect(unk.first()).toHaveAttribute('data-seg-state', 'unknown')
  })

  test('막대를 누르면 상세가 나오고 수정 화면으로 이동한다', async ({ page }) => {
    const s = seed()
    await restoreBackup(page, s)
    await openDay(page)
    await page.locator(`g.tl-item[data-trip-id="${s.b.id}"]`).click()
    const detail = page.getByTestId('tl-detail')
    await expect(detail).toContainText('2호선')
    await expect(detail).toContainText('다다역')
    await expect(detail).toContainText('라라역')
    await detail.getByRole('link', { name: '기록 수정으로 이동' }).click()
    await expect(page).toHaveURL(new RegExp(`#/trip/${s.b.id}`))
  })

  test('시각이 없는 기록은 그래프 아래 목록에, 한 시각만 있으면 표식으로 나온다', async ({ page }) => {
    const none = fakeTrip({ date: D, line: '2호선', boardPlace: '가가역', alightPlace: '나나역' })
    const onlyBoard = fakeTrip({ date: D, line: '1호선', boardPlace: '다다역', boardTime: '10:00' })
    const onlyAlight = fakeTrip({ date: D, line: '1호선', alightPlace: '라라역', alightTime: '11:00' })
    await restoreBackup(page, { trips: [none, onlyBoard, onlyAlight] })
    await openDay(page)
    const un = page.getByTestId('tl-untimed')
    await expect(un).toContainText('시각 미기록 (1건)')
    await expect(page.locator('svg.tl-svg g.tl-item')).toHaveCount(2)
    await expect(page.locator(`g.tl-item[data-trip-id="${onlyBoard.id}"] text`).first()).toContainText('하차 미기록')
    await expect(page.locator(`g.tl-item[data-trip-id="${onlyAlight.id}"] text`).first()).toContainText('승차 미기록')
    // 요약은 소요 시간을 추정하지 않는다
    await expect(page.getByTestId('day-summary')).toContainText('0/3건 계산')
  })

  test('자정을 넘긴 하차는 다음 날 연장 구간으로 그려진다', async ({ page }) => {
    const t = fakeTrip({ date: D, line: '2호선', boardPlace: '가가역', alightPlace: '나나역', boardTime: '23:40', alightTime: '00:20' })
    await restoreBackup(page, { trips: [t] })
    await openDay(page)
    await expect(page.getByTestId('tl-extension')).toBeVisible()
    const g = page.locator(`g.tl-item[data-trip-id="${t.id}"]`)
    await expect(g).toHaveAttribute('data-start', String(23 * 60 + 40))
    await expect(g).toHaveAttribute('data-end', String(24 * 60 + 20))
  })

  test('승·하차 시각이 같으면 24시간짜리가 아니라 점으로 그려진다', async ({ page }) => {
    const t = fakeTrip({ date: D, line: '2호선', boardTime: '09:00', alightTime: '09:00', boardPlace: '가가역', alightPlace: '나나역' })
    await restoreBackup(page, { trips: [t] })
    await openDay(page)
    const g = page.locator(`g.tl-item[data-trip-id="${t.id}"]`)
    await expect(g).toHaveAttribute('data-kind', 'point-same')
    await expect(g).toHaveAttribute('data-start', '540')
    await expect(g).toHaveAttribute('data-end', '540')
  })

  test('놓침·관찰은 탑승 통계가 아닌 별도 행에 속이 빈 표식으로 나온다', async ({ page }) => {
    const ride = fakeTrip({ date: D, line: '1호선', boardTime: '08:00', alightTime: '08:30', boardPlace: '가가역', alightPlace: '나나역' })
    const missed = fakeTrip({ date: D, kind: 'missed', line: '1호선', boardTime: '07:50', boardPlace: '가가역' })
    await restoreBackup(page, { trips: [ride, missed] })
    await openDay(page)
    await expect(page.getByTestId('day-summary')).toContainText('1회')
    await expect(page.getByTestId('day-timeline')).toContainText('놓침·관찰 1건은 탑승 통계에서 제외')
    await expect(page.locator(`g.tl-item[data-trip-id="${missed.id}"]`)).toHaveAttribute('data-kind', 'skipped')
  })

  test('날짜를 바꾸면 그래프와 요약이 함께 바뀐다', async ({ page }) => {
    const s = seed()
    const other = fakeTrip({ date: '2026-03-03', line: '2호선', boardTime: '07:00', alightTime: '07:20', boardPlace: '가가역', alightPlace: '나나역' })
    await restoreBackup(page, { trips: [...s.trips, other], seatEvents: s.seatEvents })
    await openDay(page)
    await expect(page.locator('svg.tl-svg g.tl-item')).toHaveCount(4)
    await expect(page.getByTestId('day-summary')).toContainText('4회')
    await page.getByRole('button', { name: '다음날' }).click()
    await expect(page.locator('svg.tl-svg g.tl-item')).toHaveCount(1)
    await expect(page.getByTestId('day-summary')).toContainText('1회')
  })

  test('확대·이동 단추와 전체 보기', async ({ page }) => {
    const s = seed()
    await restoreBackup(page, s)
    await openDay(page)
    const svg = page.locator('svg.tl-svg')
    const focusW = Number(await svg.getAttribute('width'))
    await page.getByRole('button', { name: '24시간 전체' }).click()
    const fullPpm = Number(await svg.getAttribute('data-px-per-min'))
    const fullW = Number(await svg.getAttribute('width'))
    expect(fullW).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.getByRole('button', { name: '확대' }).click()
    expect(Number(await svg.getAttribute('data-px-per-min'))).toBeGreaterThan(fullPpm)
    expect(Number(await svg.getAttribute('width'))).toBeGreaterThan(fullW)
    await page.getByRole('button', { name: '이동 시간대' }).click()
    expect(focusW).toBeGreaterThan(0)
  })

  for (const w of [320, 360, 390]) {
    test(`${w}px 에서 레이아웃이 깨지지 않는다`, async ({ page }) => {
      const s = seed()
      await page.setViewportSize({ width: w, height: 800 })
      await restoreBackup(page, s)
      await openDay(page)
      await page.locator(`g.tl-item[data-trip-id="${s.a.id}"]`).click()
      await expectLayoutOk(page, `timeline ${w}`)
      await expectNoSeriousA11y(page, `timeline ${w}`)
      mkdirSync(OUT, { recursive: true })
      await page.getByTestId('day-timeline').screenshot({ path: `${OUT}/timeline-${w}.png` })
      await page.getByRole('button', { name: '24시간 전체' }).click()
      await page.getByTestId('day-timeline').screenshot({ path: `${OUT}/timeline-full-${w}.png` })
    })
  }

  test('가로 방향에서도 그래프가 화면 폭에 맞춰진다', async ({ page }) => {
    const s = seed()
    await page.setViewportSize({ width: 740, height: 360 })
    await restoreBackup(page, s)
    await openDay(page)
    await page.getByRole('button', { name: '24시간 전체' }).click()
    const fw = await page.locator('.tl-scroll').evaluate((e) => e.clientWidth)
    const svgW = Number(await page.locator('svg.tl-svg').getAttribute('width'))
    expect(svgW).toBeLessThanOrEqual(fw + 1)
  })

  test('기록을 수정하면 돌아온 날짜 화면의 그래프와 요약이 바로 바뀐다', async ({ page }) => {
    const s = seed()
    await restoreBackup(page, s)
    await openDay(page)
    const g = page.locator(`g.tl-item[data-trip-id="${s.b.id}"]`)
    await expect(g).toHaveAttribute('data-end', String(12 * 60 + 30))
    await g.click()
    await page.getByTestId('tl-detail').getByRole('link', { name: '기록 수정으로 이동' }).click()
    await setTime(page, '하차 시각', '12:50')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    // 타임라인에서 들어왔으므로 같은 날짜 화면으로 돌아온다
    await expect(page).toHaveURL(new RegExp(`#/day/${D}`))
    await expect(page.locator(`g.tl-item[data-trip-id="${s.b.id}"]`)).toHaveAttribute('data-end', String(12 * 60 + 50))
    await expect(page.getByTestId('day-summary')).toContainText('3시간 6분')
  })

  test('오늘의 기록 화면에서도 이동 기록 목록 아래에 타임라인이 나온다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가가역', alight: '나나역' })
    await gotoApp(page, '')
    const list = page.getByRole('heading', { name: /이동 기록/ })
    const tl = page.getByRole('heading', { name: '하루 이동 타임라인' })
    await expect(tl).toBeVisible()
    const a = await list.boundingBox()
    const b = await tl.boundingBox()
    expect(b!.y).toBeGreaterThan(a!.y)
    await expect(page.getByTestId('day-timeline')).toContainText('1호선')
  })

  test('글꼴이 달라져 글자 폭이 달라도 막대를 눌러 상세를 열 수 있다 (CI 의 Linux 글꼴 재현)', async ({ page }) => {
    await page.addInitScript(() => {
      const st = document.createElement('style')
      st.textContent = "body, svg text { font-family: 'Courier New', monospace !important; }"
      document.documentElement.appendChild(st)
    })
    const s = seed()
    await restoreBackup(page, s)
    await openDay(page)
    for (const t of [s.a, s.b, s.c, s.d]) {
      await page.locator(`g.tl-item[data-trip-id="${t.id}"]`).click({ timeout: 5000 })
      await expect(page.getByTestId('tl-detail')).toBeVisible()
    }
    const wrong = await page.evaluate(() => {
      const out: string[] = []
      for (const g of document.querySelectorAll<SVGGElement>('svg.tl-svg g.tl-item')) {
        g.scrollIntoView({ block: 'center', inline: 'center' })
        const r = g.getBoundingClientRect()
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (el?.closest('g.tl-item') !== g) out.push(g.getAttribute('data-trip-id') ?? '?')
      }
      return out
    })
    expect(wrong).toEqual([])
  })
})
