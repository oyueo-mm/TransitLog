import { expect, test, type Page } from '@playwright/test'
import { expectLayoutOk, expectNoSeriousA11y, fakeTrip, gotoApp, readDb, restoreBackup, selectLine, setTime, timeOut } from './fixtures'

interface TripRow {
  id: string
  kind: string
  mode: string
  ongoing: boolean
  line: string | null
  boardPlace: string | null
  alightPlace: string | null
  boardTime: string | null
  alightTime: string | null
  initialSeat: string | null
  seatLogComplete: boolean | null
  crowding: string | null
  note: string | null
  car: number | null
  trainDestination: string | null
}

/** 기기 시각을 고정한다 (한국 시간) */
async function freeze(page: Page, iso: string) {
  await page.clock.setFixedTime(new Date(iso))
}

const kindSeg = (page: Page) => page.getByRole('group', { name: '기록 종류' })

test.describe('빠른 기록 — 관찰', () => {
  test('기본은 탑승이고, 관찰로 바꾸면 좌석·하차 입력이 사라진다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await expect(kindSeg(page).getByRole('button', { name: '탑승', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: '지금 탑승' })).toBeVisible()
    await expect(page.getByRole('group', { name: '지금 좌석 상태' })).toBeVisible()

    await kindSeg(page).getByRole('button', { name: '관찰', exact: true }).click()
    await expect(page.getByRole('button', { name: '관찰 기록 저장' })).toBeVisible()
    await expect(page.getByRole('button', { name: '지금 탑승' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '하차 기록 없이 저장' })).toHaveCount(0)
    await expect(page.getByRole('group', { name: '지금 좌석 상태' })).toHaveCount(0)
    await expect(page.getByLabel('하차역 직접 입력')).toHaveCount(0)
    await expect(page.getByRole('group', { name: '관찰역 추천' }).or(page.getByLabel('관찰역 직접 입력'))).not.toHaveCount(0)
  })

  test('관찰 기록은 현재 시각으로 저장되고 좌석·하차 값이 없으며, 연속 관찰에서 노선과 장소가 유지된다', async ({ page }) => {
    await freeze(page, '2026-03-02T14:37:00+09:00')
    await gotoApp(page, 'quick')
    await kindSeg(page).getByRole('button', { name: '관찰', exact: true }).click()
    await selectLine(page, '1호선')
    await page.getByLabel('관찰역 직접 입력').fill('가역')
    await page.getByRole('button', { name: '혼잡', exact: true }).click()
    await page.getByLabel('비고').fill('첫 관찰')
    await page.getByRole('button', { name: '관찰 기록 저장' }).click()
    await expect(page.getByText('관찰 기록을 저장했습니다')).toBeVisible()

    // 저장 후: 노선·장소는 남고, 혼잡도·비고는 비워진다
    await expect(page.getByRole('group', { name: '노선 선택' }).getByRole('button', { name: '1호선', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('관찰역 직접 입력')).toHaveValue('가역')
    await expect(page.getByLabel('비고')).toHaveValue('')

    // 과거 시각을 직접 지정하면 그 값을 보존한다
    await page.getByRole('group', { name: '관찰 시각 설정' }).getByRole('button', { name: '수정' }).click()
    await setTime(page, '관찰 시각', '08:15')
    await page.getByRole('button', { name: '관찰 기록 저장' }).click()

    const rows = (await readDb<TripRow>(page, 'trips')).sort((a, b) => a.boardTime!.localeCompare(b.boardTime!))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      kind: 'observed',
      ongoing: false,
      line: '1호선',
      boardPlace: '가역',
      boardTime: '14:37',
      alightTime: null,
      alightPlace: null,
      initialSeat: null,
      seatLogComplete: null,
      crowding: 'crowded',
      note: '첫 관찰',
    })
    expect(rows[0]).toMatchObject({ kind: 'observed', boardTime: '08:15', note: null, crowding: null })
    expect(await readDb(page, 'seatEvents')).toHaveLength(0)

    // 탑승 횟수에는 들어가지 않는다
    await gotoApp(page, 'stats')
    await expect(page.getByText('이 기간에 탑승 기록이 없습니다')).toBeVisible()
  })

  test('버스 관찰도 저장된다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await kindSeg(page).getByRole('button', { name: '관찰', exact: true }).click()
    await page.getByRole('group', { name: '교통수단' }).getByRole('button', { name: '버스' }).click()
    await page.getByLabel('버스 번호 직접 입력').fill('100')
    await page.getByLabel('관찰정류장 직접 입력').fill('가정류장')
    await page.getByRole('button', { name: '관찰 기록 저장' }).click()
    await expect(page.getByText('관찰 기록을 저장했습니다')).toBeVisible()
    const rows = await readDb<TripRow>(page, 'trips')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'observed', mode: 'bus', line: '100', boardPlace: '가정류장', ongoing: false })
  })

  test('탑승 기능은 그대로 동작한다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await selectLine(page, '1호선')
    await page.getByLabel('승차역 직접 입력').fill('가역')
    await page.getByRole('button', { name: '지금 탑승' }).click()
    await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
    const rows = await readDb<TripRow>(page, 'trips')
    expect(rows[0]).toMatchObject({ kind: 'ride', ongoing: true })
  })

  for (const width of [320, 360, 390]) {
    test(`${width}px 에서 관찰 화면이 깨지지 않는다`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 })
      await gotoApp(page, 'quick')
      await kindSeg(page).getByRole('button', { name: '관찰', exact: true }).click()
      await selectLine(page, '1호선')
      await expectLayoutOk(page, `관찰 ${width}px`)
      await expectNoSeriousA11y(page, `관찰 ${width}px`)
    })
  }
})

test.describe('시각 입력 — 지금 버튼', () => {
  test('기록 추가 화면에서 값이 없을 때 ‘지금’을 누르면 현재 시각(24시간 저장)이 들어간다', async ({ page }) => {
    await freeze(page, '2026-03-02T14:37:00+09:00')
    await gotoApp(page, 'trip/new')
    await page.getByRole('group', { name: '기록 종류' }).getByRole('button', { name: '관찰만' }).click()
    const group = page.getByRole('group', { name: '관찰 시각', exact: true })
    await expect(timeOut(page, '관찰 시각')).toHaveText('시·분을 모두 선택하세요')
    await group.getByRole('button', { name: '지금' }).click()
    await expect(timeOut(page, '관찰 시각')).toHaveText('오후 02:37')

    // 눌러도 수동 수정이 가능하다
    await setTime(page, '관찰 시각', '07:05')
    await expect(timeOut(page, '관찰 시각')).toHaveText('오전 07:05')
    await group.getByRole('button', { name: '지금' }).click()
    await page.getByRole('button', { name: '저장', exact: true }).click()
    const rows = await readDb<TripRow>(page, 'trips')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'observed', boardTime: '14:37' })
  })

  test('자정 경계: 00:05 는 오전 12:05, 12:00 은 오후 12:00', async ({ page }) => {
    await freeze(page, '2026-03-03T00:05:00+09:00')
    await gotoApp(page, 'trip/new')
    await page.getByRole('group', { name: '승차 시각', exact: true }).getByRole('button', { name: '지금' }).click()
    await expect(timeOut(page, '승차 시각')).toHaveText('오전 12:05')
    await freeze(page, '2026-03-03T12:00:00+09:00')
    await page.getByRole('group', { name: '승차 시각', exact: true }).getByRole('button', { name: '지금' }).click()
    await expect(timeOut(page, '승차 시각')).toHaveText('오후 12:00')
  })

  test('기존 기록을 열기만 해서는 시각이 바뀌지 않는다', async ({ page }) => {
    const t = fakeTrip({ kind: 'observed', line: '1호선', boardPlace: '가역', boardTime: '09:10' })
    await restoreBackup(page, { trips: [t] })
    await gotoApp(page, `trip/${t.id}`)
    await expect(timeOut(page, '관찰 시각')).toHaveText('오전 09:10')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    const rows = await readDb<TripRow>(page, 'trips')
    expect(rows[0].boardTime).toBe('09:10')
  })
})
