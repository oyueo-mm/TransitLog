import { expect, test } from '@playwright/test'
import { type SeatEvent, type Trip } from '../src/domain/types'
import { fakeEvent, fakeTrip, gotoApp, readDb, restoreBackup, selectLine, setTime } from './fixtures'

const DATE = '2026-10-23'
const NOW = new Date(`${DATE}T12:34:56+09:00`)

for (const state of ['standing', 'seated', null, 'changed'] as const) {
  test(`예정역 원터치 하차: 좌석 ${state} 보존, 입력창 없이 현재 시각 저장`, async ({ page }) => {
    await page.clock.setFixedTime(NOW)
    const trip = fakeTrip({ date: DATE, ongoing: true, boardTime: '12:00', alightPlace: '하차예정역', trainDestination: '다른종착역', initialSeat: state === 'changed' ? 'standing' : state, seatLogComplete: state === 'seated' ? true : null })
    const events = state === 'changed' ? [fakeEvent(trip.id, { time: '12:10', state: 'seated', place: '중간역' })] : []
    await restoreBackup(page, { trips: [trip], seatEvents: events })
    const beforeEvents = await readDb<SeatEvent>(page, 'seatEvents')
    await gotoApp(page, 'quick')
    const dialogs: string[] = []
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss() })
    // Dispatch several clicks in one task to exercise the synchronous click guard.
    await page.getByRole('button', { name: '하차', exact: true }).evaluate(button => {
      for (let i = 0; i < 5; i++) (button as HTMLButtonElement).click()
    })
    await expect(page.getByRole('heading', { name: '빠른 기록', exact: true })).toBeVisible()
    await expect(page.locator('.toast')).toContainText('하차를 기록했습니다')
    await expect(page.getByLabel('하차 장소', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '하차 완료', exact: true })).toHaveCount(0)
    expect(dialogs).toEqual([])
    const saved = await readDb<Trip>(page, 'trips')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ ongoing: false, alightTime: '12:34', alightPlace: '하차예정역', initialSeat: trip.initialSeat, seatLogComplete: trip.seatLogComplete })
    expect(await readDb<SeatEvent>(page, 'seatEvents')).toEqual(beforeEvents)
    await page.reload()
    expect((await readDb<Trip>(page, 'trips'))[0]).toMatchObject({ ongoing: false, alightTime: '12:34' })
  })
}

test('빠른 기록에서 예정역 설정 → 원터치 하차 → 오늘 기록에서 시각·역·좌석 수정', async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await gotoApp(page, 'quick')
  await selectLine(page, '1호선')
  await page.getByLabel('승차역 직접 입력', { exact: true }).fill('수원역')
  await page.getByLabel('하차역 직접 입력', { exact: true }).fill('구로역')
  await page.getByRole('button', { name: '서서 탑승', exact: true }).click()
  await page.getByRole('button', { name: '지금 탑승', exact: true }).click()
  await page.getByRole('button', { name: '하차', exact: true }).click()
  await expect(page.getByRole('heading', { name: '빠른 기록', exact: true })).toBeVisible()
  await gotoApp(page)
  const card = page.locator('.timeline .card').first()
  await expect(card).toContainText('구로역')
  await expect(card).toContainText('12:34')
  await expect(card.locator('.live')).toHaveCount(0)
  await card.click()
  await setTime(page, '하차 시각', '12:40')
  await page.getByLabel('하차역 직접 입력', { exact: true }).fill('신도림역')
  await page.getByRole('group', { name: '탑승 시점 좌석', exact: true }).getByRole('button', { name: '앉아서', exact: true }).click()
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByRole('heading', { name: /10월 23일/ })).toBeVisible()
  expect((await readDb<Trip>(page, 'trips'))[0]).toMatchObject({ ongoing: false, alightPlace: '신도림역', alightTime: '12:40', initialSeat: 'seated' })
})

test('예정역이 없으면 기존 하차 입력 절차를 유지하고 종착역을 대신 쓰지 않는다', async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  const trip = fakeTrip({ date: DATE, ongoing: true, boardTime: '12:00', alightPlace: null, trainDestination: '종착역', initialSeat: 'standing' })
  await restoreBackup(page, { trips: [trip] })
  await gotoApp(page, 'quick')
  await page.getByRole('button', { name: '하차', exact: true }).click()
  await expect(page.getByLabel('하차 장소', { exact: true })).toBeVisible()
  expect((await readDb<Trip>(page, 'trips'))[0].ongoing).toBe(true)
  await page.getByLabel('하차 장소', { exact: true }).fill('직접선택역')
  await page.getByRole('button', { name: '하차 완료', exact: true }).click()
  await expect(page.getByRole('heading', { name: '빠른 기록', exact: true })).toBeVisible()
  expect((await readDb<Trip>(page, 'trips'))[0]).toMatchObject({ ongoing: false, alightPlace: '직접선택역', alightTime: '12:34', initialSeat: 'standing' })
})
