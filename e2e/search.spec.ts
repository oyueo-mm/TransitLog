import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { expectLayoutOk, expectNoSeriousA11y, fakeEvent, fakeTrip, gotoApp, restoreBackup } from './fixtures'

const OUT = 'test-results/screens'

function seed() {
  const a = fakeTrip({ date: '2026-03-02', line: '1호선', boardPlace: '가가역', alightPlace: '나나역', boardTime: '08:24', alightTime: '09:20', initialSeat: 'standing', seatLogComplete: true, car: 10, door: 3, crowding: 'crowded', trainDestination: '다다' })
  const b = fakeTrip({ date: '2026-03-02', line: '2호선', boardPlace: '가가', alightPlace: '마마역', boardTime: '12:00', alightTime: '12:30', initialSeat: 'seated', crowding: 'free' })
  const c = fakeTrip({ date: '2026-03-03', line: '1호선', boardPlace: '나나역', alightPlace: '가가역', boardTime: '18:00', alightTime: '18:40', initialSeat: 'standing', seatLogComplete: true, delayMinutes: 5, incident: '신호 대기' })
  const d = fakeTrip({ date: '2026-03-04', line: '수인분당선', boardPlace: '바바역', boardTime: '07:30', note: '메모만 있음' })
  const seatEvents = [fakeEvent(a.id, { time: '08:30', state: 'seated', place: '라라역', note: '자리 남' })]
  return { trips: [a, b, c, d], seatEvents, a, b, c, d }
}

async function openSearch(page: Page) {
  await gotoApp(page, 'calendar')
  await page.getByRole('button', { name: '검색·목록' }).click()
  await expect(page.getByTestId('search-panel')).toBeVisible()
}
const count = (page: Page) => page.getByTestId('result-count')
const cards = (page: Page) => page.locator('[data-testid="search-panel"] .result-item')
const advanced = async (page: Page) => {
  if (!(await page.getByTestId('adv-filters').isVisible().catch(() => false))) await page.getByRole('button', { name: /상세 조건/ }).click()
}
const chip = (page: Page, group: string, name: string | RegExp) => page.getByRole('group', { name: group, exact: true }).getByRole('button', { name })

test.describe('고급 검색', () => {
  test('키워드: 공백 무시·여러 단어 AND·역 이름 정규화·동의어·좌석 이벤트', async ({ page }) => {
    await restoreBackup(page, seed())
    await openSearch(page)
    await expect(count(page)).toContainText('전체 4건')
    const q = page.getByLabel('검색', { exact: true })
    await q.fill('1 호 선')
    await expect(cards(page)).toHaveCount(2)
    await q.fill('1호선 나나역')
    await expect(cards(page)).toHaveCount(2)
    // 가가 = 가가역
    await q.fill('가가역')
    await expect(cards(page)).toHaveCount(3)
    // 좌석 이벤트의 역/메모/시각
    await q.fill('라라역')
    await expect(cards(page)).toHaveCount(1)
    await q.fill('자리')
    await expect(cards(page)).toHaveCount(1)
    await q.fill('08:30')
    await expect(cards(page)).toHaveCount(1)
    // 동의어와 칸-문
    await q.fill('착석')
    await expect(cards(page)).toHaveCount(2)
    await q.fill('10-3')
    await expect(cards(page)).toHaveCount(1)
    await expect(page.locator('.match-tags mark').first()).toBeVisible()
    // 기록되지 않은 값은 맞추지 않는다
    await q.fill('서서 메모만')
    await expect(cards(page)).toHaveCount(0)
    await expect(page.getByText('조건에 맞는 기록이 없습니다')).toBeVisible()
  })

  test('복합 조건 AND: 노선 + 승차 시각 + 승차역 + 서서 탑승 + 중간 착석', async ({ page }) => {
    await restoreBackup(page, seed())
    await openSearch(page)
    await advanced(page)
    await page.getByRole('group', { name: '노선·버스 번호', exact: true }).getByRole('button', { name: '1호선' }).click()
    await page.getByLabel('승차 시각 시작').fill('07:00')
    await page.getByLabel('승차 시각 끝').fill('09:00')
    await page.getByRole('group', { name: '승차역', exact: true }).getByRole('button', { name: /^가가/ }).click()
    await chip(page, '탑승 시 좌석', '서서 탑승').click()
    await chip(page, '탑승 중 좌석 변화', '중간 착석함').click()
    await expect(cards(page)).toHaveCount(1)
    await expect(cards(page).first()).toContainText('가가역 → 나나역')
    // 조건 하나를 바꾸면 결과가 사라진다
    await page.getByLabel('승차 시각 끝').fill('08:00')
    await expect(cards(page)).toHaveCount(0)
    // 같은 그룹의 여러 값은 OR
    await page.getByLabel('승차 시각 끝').fill('09:00')
    await chip(page, '탑승 시 좌석', '처음부터 앉아서').click()
    await expect(cards(page)).toHaveCount(1)
    await page.getByRole('button', { name: /조건 초기화/ }).click()
    await expect(cards(page)).toHaveCount(4)
  })

  test('좌석 조건: 끝까지 서 있었음(확인)·최종 미확인, 지연, 소요 시간', async ({ page }) => {
    await restoreBackup(page, seed())
    await openSearch(page)
    await advanced(page)
    await chip(page, '탑승 중 좌석 변화', /끝까지 서 있었음/).click()
    await expect(cards(page)).toHaveCount(1)
    await expect(cards(page).first()).toContainText('신호 대기')
    await page.getByRole('button', { name: /조건 초기화/ }).click()
    await chip(page, '최종 좌석 상태', '미확인').click()
    await expect(cards(page)).toHaveCount(2) // 완결 확인이 없는 b, d
    await page.getByRole('button', { name: /조건 초기화/ }).click()
    await chip(page, '지연', '지연 있음').click()
    await expect(cards(page)).toHaveCount(1)
    await page.getByRole('button', { name: /조건 초기화/ }).click()
    await page.getByLabel('소요 시간 최소').fill('50')
    await expect(cards(page)).toHaveCount(1)
  })

  test('정렬: 소요 시간 정렬에서 시간을 모르는 기록은 맨 뒤', async ({ page }) => {
    await restoreBackup(page, seed())
    await openSearch(page)
    await page.getByLabel('정렬').selectOption('durationDesc')
    await expect(cards(page).nth(0)).toContainText('08:24')
    await expect(cards(page).nth(3)).toContainText('바바역')
    await expect(page.getByText(/소요 시간을 알 수 없는 1건/)).toBeVisible()
    await page.getByLabel('정렬').selectOption('oldest')
    await expect(cards(page).nth(0)).toContainText('08:24')
    await page.getByLabel('정렬').selectOption('newest')
    await expect(cards(page).nth(0)).toContainText('바바역')
  })

  test('결과 통계는 통계 화면과 같은 값이고 표본 수·부족 안내가 나온다', async ({ page }) => {
    await restoreBackup(page, seed())
    await openSearch(page)
    const st = page.getByTestId('result-stats')
    await expect(st).toContainText('탑승 4건')
    await expect(st).toContainText('표본이 부족')
    const dur = await page.getByTestId('stat-duration').innerText()
    const toSeat = await page.getByTestId('stat-toseat').innerText()
    await gotoApp(page, 'stats')
    const body = await page.locator('main').innerText()
    // 통계 화면의 같은 항목(전체 기간)과 같은 값
    const norm = (s: string) => s.replace(/\s+/g, ' ')
    expect(norm(body)).toContain(norm(dur).replace(/\s*\(표본 \d+\)/, ''))
    expect(norm(body)).toContain(norm(toSeat).replace(/\s*\(표본 \d+\)/, ''))
    for (const label of ['즉시 착석률', '한 번이라도 착석한 비율']) expect(body).toContain(label)
    // 조건을 좁히면 결과 통계의 표본이 줄어든다
    await openSearch(page)
    await page.getByLabel('검색', { exact: true }).fill('1호선')
    await expect(page.getByTestId('result-stats')).toContainText('탑승 2건')
  })

  test('상세 화면으로 갔다 돌아와도 검색 조건과 스크롤 위치가 유지되고, 저장하면 결과가 바로 갱신된다', async ({ page }) => {
    const base = seed()
    const many = Array.from({ length: 40 }, (_, i) => fakeTrip({ date: `2026-02-${String((i % 27) + 1).padStart(2, '0')}`, line: '2호선', boardPlace: '가가역', alightPlace: '나나역', boardTime: `10:${String(i).padStart(2, '0')}`, alightTime: '11:30' }))
    await restoreBackup(page, { trips: [...base.trips, ...many], seatEvents: base.seatEvents })
    await openSearch(page)
    await page.getByLabel('검색', { exact: true }).fill('2호선')
    await expect(count(page)).toContainText('41건 일치')
    // 30건씩 표시 + 더 보기
    await expect(cards(page)).toHaveCount(30)
    await page.getByTestId('more').click()
    await expect(cards(page)).toHaveCount(41)
    await expect(page.getByTestId('more')).toHaveCount(0)
    await cards(page).nth(35).scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await cards(page).nth(35).locator('a.card').click()
    await expect(page).toHaveURL(/#\/trip\//)
    await page.getByLabel('비고').fill('수정 확인')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    // 검색 화면으로 돌아오고 조건·표시 건수가 유지된다
    await expect(page).toHaveURL(/#\/calendar/)
    await expect(page.getByTestId('search-panel')).toBeVisible()
    await expect(page.getByLabel('검색', { exact: true })).toHaveValue('2호선')
    await expect(cards(page)).toHaveCount(41)
    // 수정한 내용이 바로 검색된다
    await page.getByLabel('검색', { exact: true }).fill('수정 확인')
    await expect(cards(page)).toHaveCount(1)
  })

  test('오프라인에서도 검색과 타임라인이 동작한다', async ({ page, context }) => {
    await restoreBackup(page, seed())
    await gotoApp(page, 'calendar')
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload()
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    await context.setOffline(true)
    await page.reload()
    await page.getByRole('button', { name: '검색·목록' }).click()
    await page.getByLabel('검색', { exact: true }).fill('착석')
    await expect(cards(page)).toHaveCount(2)
    await gotoApp(page, 'day/2026-03-02')
    await expect(page.locator('svg.tl-svg g.tl-item')).toHaveCount(2)
    await context.setOffline(false)
  })

  test('기존 백업(좌석 이벤트에 note 없음 등 옛 형식)도 검색된다', async ({ page }) => {
    const s = seed()
    const old = { ...s.seatEvents[0] } as Record<string, unknown>
    delete old.note
    await restoreBackup(page, { trips: s.trips, seatEvents: [old as never] })
    await openSearch(page)
    await page.getByLabel('검색', { exact: true }).fill('라라역')
    await expect(cards(page)).toHaveCount(1)
  })

  for (const w of [320, 360, 390]) {
    test(`${w}px 검색 화면 레이아웃`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 })
      await restoreBackup(page, seed())
      await openSearch(page)
      await page.getByLabel('검색', { exact: true }).fill('가가역')
      await advanced(page)
      await chip(page, '탑승 시 좌석', '서서 탑승').click()
      await expectLayoutOk(page, `search ${w}`)
      await expectNoSeriousA11y(page, `search ${w}`)
      mkdirSync(OUT, { recursive: true })
      await page.screenshot({ path: `${OUT}/search-${w}.png`, fullPage: true })
      await page.getByTestId('result-stats').screenshot({ path: `${OUT}/search-stats-${w}.png` })
      await page.getByTestId('result-group').first().screenshot({ path: `${OUT}/search-result-${w}.png` })
    })
  }
})
