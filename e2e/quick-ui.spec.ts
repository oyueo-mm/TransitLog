import { expect, test, type Page } from '@playwright/test'
import {
  expectLayoutOk,
  expectNoSeriousA11y,
  fakeEvent,
  fakeTrip,
  gotoApp,
  readDb,
  recordRide,
  restoreBackup,
  selectLine,
  setTime,
  timeOut,
} from './fixtures'

interface TripRow {
  id: string
  line: string | null
  boardPlace: string | null
  alightPlace: string | null
  trainOrigin: string | null
  trainDestination: string | null
  initialSeat: string | null
  crowding: string | null
  note: string | null
  car: number | null
  ongoing: boolean
  seatLogComplete: boolean | null
}
interface EventRow {
  tripId: string
  time: string | null
  state: string
  place: string | null
  note?: string | null
}

const lineSeg = (page: Page) => page.getByRole('group', { name: '노선 선택' })
const chipsOf = (page: Page, group: string) => page.getByRole('group', { name: `${group} 추천` }).getByRole('button')
const texts = (page: Page, group: string) => chipsOf(page, group).allTextContents()
const pairChips = (page: Page) => page.getByRole('group', { name: '자주 쓴 운행 구간' }).getByRole('button')
const saveOnly = (page: Page) => page.getByRole('button', { name: '하차 기록 없이 저장' }).click()

test.describe('노선 토글과 역 추천', () => {
  test('노선 버튼은 수인분당선·1호선·2호선이 먼저, 선택하면 추천이 즉시 바뀌고 선택만으로는 저장되지 않는다', async ({ page }) => {
    await gotoApp(page, 'quick')
    expect(await lineSeg(page).getByRole('button').allTextContents()).toEqual(['수인분당선', '1호선', '2호선', '기타'])

    await lineSeg(page).getByRole('button', { name: '수인분당선', exact: true }).click()
    await expect(lineSeg(page).getByRole('button', { name: '수인분당선', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await texts(page, '승차역')).toEqual(['오목천역', '수원역', '고색역'])
    expect(await texts(page, '하차역')).toEqual(['오목천역', '수원역', '고색역'])

    await lineSeg(page).getByRole('button', { name: '1호선', exact: true }).click()
    await expect(lineSeg(page).getByRole('button', { name: '수인분당선', exact: true })).toHaveAttribute('aria-pressed', 'false')
    expect(await texts(page, '승차역')).toEqual(['수원역', '신도림역', '구로역'])
    expect(await texts(page, '하차역')).toEqual(['수원역', '신도림역', '구로역'])

    await lineSeg(page).getByRole('button', { name: '2호선', exact: true }).click()
    expect(await texts(page, '승차역')).toEqual(['신도림역', '홍대입구역', '합정역'])
    expect(await texts(page, '하차역')).toEqual(['신도림역', '홍대입구역', '합정역'])

    // 같은 버튼을 다시 누르면 선택이 해제된다(미기록)
    await lineSeg(page).getByRole('button', { name: '2호선', exact: true }).click()
    await expect(lineSeg(page).getByRole('button', { name: '2호선', exact: true })).toHaveAttribute('aria-pressed', 'false')

    // 추천 칩을 누르기 전에는 선택된 값이 없고, 아무것도 저장되지 않았다
    await lineSeg(page).getByRole('button', { name: '1호선', exact: true }).click()
    for (const c of await chipsOf(page, '승차역').all()) await expect(c).toHaveAttribute('aria-pressed', 'false')
    expect(await readDb(page, 'trips')).toHaveLength(0)
    expect(await readDb(page, 'seatEvents')).toHaveLength(0)
  })

  test('승차역을 고르면 하차역 추천에서 그 역은 빠지고, 노선을 바꾸면 이전 노선의 역은 비워진다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await lineSeg(page).getByRole('button', { name: '1호선', exact: true }).click()
    await chipsOf(page, '승차역').getByText('수원역', { exact: true }).click()
    await expect(chipsOf(page, '승차역').getByText('수원역', { exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await texts(page, '하차역')).toEqual(['신도림역', '구로역'])

    await lineSeg(page).getByRole('button', { name: '2호선', exact: true }).click()
    await expect(page.getByLabel('승차역 직접 입력')).toHaveValue('') // 1호선 역을 2호선 기록에 끌고 가지 않는다
    expect(await texts(page, '승차역')).toEqual(['신도림역', '홍대입구역', '합정역'])
  })

  test('추천에 없는 역·노선도 직접 입력할 수 있고, 입력한 이름은 알려진 표기로 통일된다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await selectLine(page, '가상선') // '기타' → 직접 입력
    await expect(lineSeg(page).getByRole('button', { name: '기타', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByLabel('승차역 직접 입력').fill('가가역')
    await page.getByLabel('하차역 직접 입력').fill('나나역')
    await saveOnly(page)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(1)
    const [t] = await readDb<TripRow>(page, 'trips')
    expect(t).toMatchObject({ line: '가상선', boardPlace: '가가역', alightPlace: '나나역' })

    // '수원'이라고 입력하면 이미 쓰는 표기 '수원역'으로 맞춘다 (프리셋 포함)
    await page.reload()
    await selectLine(page, '1호선')
    const input = page.getByLabel('승차역 직접 입력')
    await input.fill('수원')
    await input.blur()
    await expect(input).toHaveValue('수원역')
    // 방금 저장한 가상선 역은 검색(자동완성) 후보에 들어 있다
    expect(await page.locator('datalist option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(expect.arrayContaining(['가가역', '나나역', '오목천역']))
  })
})

test.describe('열차 운행 출발지·종착역', () => {
  test('노선별 추천이 다르고, 출발지와 종착역을 각각 독립적으로 고르거나 입력한다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await lineSeg(page).getByRole('button', { name: '수인분당선', exact: true }).click()
    expect(await texts(page, '운행 출발지')).toEqual(['인천', '왕십리'])
    expect(await texts(page, '종착역')).toEqual(['인천', '왕십리'])
    expect(await pairChips(page).allTextContents()).toEqual(['인천 → 왕십리행', '왕십리 → 인천행'])

    await lineSeg(page).getByRole('button', { name: '1호선', exact: true }).click()
    expect(await texts(page, '운행 출발지')).toEqual(['서동탄', '천안', '신창', '청량리', '구로'])
    expect(await texts(page, '종착역')).toEqual(['서동탄', '천안', '신창', '청량리', '구로'])

    await lineSeg(page).getByRole('button', { name: '2호선', exact: true }).click()
    expect(await texts(page, '운행 출발지')).toEqual(['성수', '신도림', '까치산'])
    expect(await texts(page, '종착역')).toEqual(['성수', '신도림', '까치산'])

    // 1호선: 출발지는 추천 칩, 종착역은 목록에 없는 값을 직접 입력 → 독립 저장
    await lineSeg(page).getByRole('button', { name: '1호선', exact: true }).click()
    await chipsOf(page, '운행 출발지').getByText('서동탄', { exact: true }).click()
    await expect(page.getByText('운행: 서동탄 출발')).toBeVisible() // 한쪽만 입력해도 허용
    await page.getByLabel('종착역 직접 입력').fill('광운대')
    await expect(page.getByText('서동탄 → 광운대행').last()).toBeVisible()
    await saveOnly(page)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(1)
    let rows = await readDb<TripRow>(page, 'trips')
    expect(rows[0]).toMatchObject({ line: '1호선', trainOrigin: '서동탄', trainDestination: '광운대', boardPlace: null, alightPlace: null }) // 승·하차역과 별개
  })

  test('성수 → 성수 순환 운행, 한쪽만 입력, 모르면 빈칸으로 저장', async ({ page }) => {
    await gotoApp(page, 'quick')
    await lineSeg(page).getByRole('button', { name: '2호선', exact: true }).click()
    await chipsOf(page, '운행 출발지').getByText('성수', { exact: true }).click()
    await chipsOf(page, '종착역').getByText('성수', { exact: true }).click()
    await expect(page.getByText('성수 → 성수행').last()).toBeVisible()
    await expect(page.getByText('(순환 운행)')).toBeVisible()
    await saveOnly(page)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(1)

    // 종착역만
    await page.reload()
    await lineSeg(page).getByRole('button', { name: '수인분당선', exact: true }).click()
    await chipsOf(page, '종착역').getByText('왕십리', { exact: true }).click()
    await saveOnly(page)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(2)

    // 아무것도 모름
    await page.reload()
    await saveOnly(page)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(3)

    const rows = (await readDb<TripRow>(page, 'trips')).sort((a, b) => a.id.localeCompare(b.id))
    const by = (f: (t: TripRow) => boolean) => rows.find(f)!
    expect(by((t) => t.line === '2호선')).toMatchObject({ trainOrigin: '성수', trainDestination: '성수' })
    expect(by((t) => t.line === '수인분당선')).toMatchObject({ trainOrigin: null, trainDestination: '왕십리' })
    expect(by((t) => t.line === null)).toMatchObject({ trainOrigin: null, trainDestination: null })
  })

  test('수인분당선 대표 조합 칩 한 번으로 출발지·종착역이 함께 입력되고 다시 누르면 해제', async ({ page }) => {
    await gotoApp(page, 'quick')
    await lineSeg(page).getByRole('button', { name: '수인분당선', exact: true }).click()
    const pair = pairChips(page).getByText('왕십리 → 인천행', { exact: true })
    await pair.click()
    await expect(pair).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('운행 출발지 직접 입력')).toHaveValue('왕십리')
    await expect(page.getByLabel('종착역 직접 입력')).toHaveValue('인천')
    await pair.click()
    await expect(page.getByLabel('운행 출발지 직접 입력')).toHaveValue('')
  })
})

test.describe('이전 기록을 이용한 자동완성', () => {
  const seed = () => {
    let k = 0 // 시각이 같으면 복원이 같은 기록(중복)으로 보므로 기록마다 다른 시각을 준다
    const mk = (p: Parameters<typeof fakeTrip>[0]) => fakeTrip({ line: '1호선', boardPlace: '수원역', boardTime: `08:0${k++}`, ...p })
    return [
      // 수원역에서 타면 구로역에서 자주 내림 (프리셋 순서(신도림역 먼저)와 다르다)
      mk({ alightPlace: '구로역', trainOrigin: '서동탄', trainDestination: '광운대', car: 10, door: 3, side: 'right' }),
      mk({ alightPlace: '구로역', trainOrigin: '서동탄', trainDestination: '광운대', car: 10, door: 3, side: 'right' }),
      mk({ alightPlace: '구로역', trainOrigin: '서동탄', trainDestination: '광운대' }),
      mk({ alightPlace: '신도림역', trainOrigin: '병점', trainDestination: '동묘앞' }),
      // 관측값(좌석·혼잡도)이 기록되어 있어도 추천은 이를 자동으로 채우지 않는다
      mk({ alightPlace: '구로역', initialSeat: 'seated', crowding: 'free', waitOrder: 1 }),
    ]
  }

  test('승차역 기준 자주 간 하차역·운행 구간·위치를 추천하되 눌러야 입력된다', async ({ page }) => {
    // 다른 노선의 기록도 하나 있다 — 노선을 고르면 그 노선의 경로만 추천되어야 한다
    const other = fakeTrip({ line: '2호선', boardTime: '09:30', boardPlace: '신도림역', alightPlace: '합정역' })
    await restoreBackup(page, { trips: [...seed(), other] })
    expect(await readDb(page, 'trips')).toHaveLength(6)

    await gotoApp(page, 'quick')
    await lineSeg(page).getByRole('button', { name: '1호선', exact: true }).click()
    await chipsOf(page, '승차역').getByText('수원역', { exact: true }).click()
    const routeChips = await page.locator('button.chip.route').allTextContents()
    expect(routeChips.length).toBeGreaterThan(0)
    expect(routeChips.every((t) => t.startsWith('1호선'))).toBe(true) // 2호선 경로는 숨겨진다

    // 하차역: 수원역에서 가장 자주 내린 구로역이 프리셋(신도림역)보다 앞
    expect((await texts(page, '하차역')).slice(0, 2)).toEqual(['구로역', '신도림역'])
    // 운행 종착역: 프리셋 5개 다음에 기록의 값(광운대·동묘앞)
    expect((await texts(page, '종착역')).slice(0, 5)).toEqual(['서동탄', '천안', '신창', '청량리', '구로'])
    expect((await texts(page, '종착역')).slice(5)).toEqual(['광운대', '동묘앞'])
    // 자주 쓴 운행 구간
    expect((await pairChips(page).allTextContents()).slice(0, 2)).toEqual(['서동탄 → 광운대행', '병점 → 동묘앞행'])

    // 아직 아무것도 선택되지 않았다 — 추천값 ≠ 확인된 입력값
    await expect(page.getByLabel('하차역 직접 입력')).toHaveValue('')
    await expect(page.getByLabel('종착역 직접 입력')).toHaveValue('')
    await expect(page.getByRole('button', { name: '서서 탑승', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('button', { name: '앉아서 탑승', exact: true })).toHaveAttribute('aria-pressed', 'false')
    for (const c of ['한산', '보통', '혼잡', '매우 혼잡']) await expect(page.getByRole('button', { name: c, exact: true })).toHaveAttribute('aria-pressed', 'false')

    // 위치(칸·문·좌우) 추천
    await page.getByRole('button', { name: /위치·대기 순서/ }).click()
    const pos = page.getByRole('group', { name: '자주 탄 위치' }).getByRole('button', { name: '10-3 오른쪽' })
    await expect(pos).toHaveAttribute('aria-pressed', 'false')
    await pos.click()
    await expect(page.locator('#q-car')).toHaveValue('10')
    await expect(page.locator('#q-door')).toHaveValue('3')

    // 추천을 눌러 확정하고 추천에 없는 값도 선택 가능
    await chipsOf(page, '하차역').getByText('구로역', { exact: true }).click()
    await pairChips(page).getByText('서동탄 → 광운대행', { exact: true }).click()
    await page.getByLabel('하차역 직접 입력').fill('다다역') // 추천 대신 다른 역
    await saveOnly(page)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(7)
    const added = (await readDb<TripRow>(page, 'trips')).find((t) => !t.id.startsWith('fake-'))!
    expect(added).toMatchObject({ line: '1호선', boardPlace: '수원역', alightPlace: '다다역', trainOrigin: '서동탄', trainDestination: '광운대', car: 10 })
    // 관측값은 과거 기록에서 자동으로 채워지지 않았다
    expect(added.initialSeat).toBeNull()
    expect(added.crowding).toBeNull()
  })
})

test.describe('중간 착석 기록', () => {
  test('서서 탑승을 고르면 + 중간에 앉음 기록이 나타나고, 시각·역·비고가 저장된다 (이벤트는 하나)', async ({ page }) => {
    await gotoApp(page, 'quick')
    await expect(page.getByRole('button', { name: '+ 중간에 앉음 기록' })).toHaveCount(0) // 서서 탑승 전에는 없음
    await page.getByRole('button', { name: '앉아서 탑승', exact: true }).click()
    await expect(page.getByRole('button', { name: '+ 중간에 앉음 기록' })).toHaveCount(0)
    await page.getByRole('button', { name: '서서 탑승', exact: true }).click()
    await selectLine(page, '1호선')
    await page.getByLabel('승차역 직접 입력').fill('가역')

    await page.getByRole('button', { name: '+ 중간에 앉음 기록' }).click()
    const mid = page.getByRole('group', { name: '중간 착석 기록' })
    await expect(mid).toBeVisible()
    await expect(page.getByRole('button', { name: '+ 중간에 앉음 기록' })).toHaveCount(0) // 눌러도 두 개가 생기지 않는다
    await setTime(mid, '착석한 시각', '08:30')
    await mid.getByLabel('착석한 역·정류장 직접 입력').fill('성균관대역') // 노선 역 목록에 없는 역
    await mid.getByLabel('비고 (선택)').fill('앞 사람이 내림')
    await page.getByRole('button', { name: '지금 탑승' }).click()
    await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
    await expect(page.locator('.event-list')).toContainText('08:30 · 착석 · 성균관대역 (앞 사람이 내림)')

    const events = await readDb<EventRow>(page, 'seatEvents')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ time: '08:30', place: '성균관대역', state: 'seated', note: '앞 사람이 내림' })
    expect((await readDb<TripRow>(page, 'trips'))[0]).toMatchObject({ initialSeat: 'standing', boardPlace: '가역' })
  })

  test('지금 앉음은 현재 시각을 채우고, 시각·역을 모르면 비운 채로 저장하며, 노선 역 추천을 쓸 수 있다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await selectLine(page, '2호선')
    await page.getByRole('button', { name: '서서 탑승', exact: true }).click()
    await page.getByRole('button', { name: '+ 중간에 앉음 기록' }).click()
    const mid = page.getByRole('group', { name: '중간 착석 기록' })
    // 선택한 노선의 역이 추천된다
    expect(await mid.getByRole('group', { name: '착석한 역·정류장' }).getByRole('button').allTextContents()).toEqual(expect.arrayContaining(['신도림역', '홍대입구역', '합정역']))
    await mid.getByRole('button', { name: '지금 앉음' }).click()
    await expect(timeOut(mid, '착석한 시각')).toHaveText(/^(오전|오후) \d\d:\d\d$/)
    // 시각을 지우고 역도 비운 채로 저장 (모르는 값은 미기록)
    await mid.getByRole('group', { name: '착석한 시각', exact: true }).getByRole('button', { name: '지우기' }).click()
    await saveOnly(page)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(1)
    const events = await readDb<EventRow>(page, 'seatEvents')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ time: null, place: null, state: 'seated' })
  })

  test('삭제 버튼으로 중간 착석을 취소하면 저장되지 않는다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await page.getByRole('button', { name: '서서 탑승', exact: true }).click()
    await page.getByRole('button', { name: '+ 중간에 앉음 기록' }).click()
    await page.getByRole('button', { name: '중간 착석 삭제' }).click()
    await expect(page.getByRole('button', { name: '+ 중간에 앉음 기록' })).toBeVisible()
    await saveOnly(page)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(1)
    expect(await readDb(page, 'seatEvents')).toHaveLength(0)
  })

  test('기록 수정 화면에서 중간 착석을 수정·삭제·재추가해도 이벤트가 중복되지 않는다', async ({ page }) => {
    const t = fakeTrip({ line: '1호선', boardTime: '08:24', alightTime: '09:20', boardPlace: '수원역', alightPlace: '신도림역', initialSeat: 'standing', seatLogComplete: true })
    await restoreBackup(page, { trips: [t], seatEvents: [fakeEvent(t.id, { time: '08:30', place: '성균관대역', state: 'seated' })] })

    await gotoApp(page, `trip/${t.id}`)
    const mid = page.getByRole('group', { name: '중간 착석 기록' })
    await expect(timeOut(mid, '착석한 시각')).toHaveText('오전 08:30')
    await expect(mid.getByLabel('착석한 역·정류장 직접 입력')).toHaveValue('성균관대역')
    await expect(page.getByRole('button', { name: '+ 중간에 앉음 기록' })).toHaveCount(0)

    // 수정: 시각 변경, 역 변경, 비고 추가
    await setTime(mid, '착석한 시각', '08:40')
    await mid.getByLabel('착석한 역·정류장 직접 입력').fill('라라역')
    await mid.getByLabel('비고 (선택)').fill('수정함')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: '3월 2일 (월)' })).toBeVisible()
    let events = await readDb<EventRow>(page, 'seatEvents')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ time: '08:40', place: '라라역', note: '수정함', tripId: t.id })

    // 삭제 후 저장 → 0건
    await gotoApp(page, `trip/${t.id}`)
    await page.getByRole('button', { name: '중간 착석 삭제' }).click()
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: '3월 2일 (월)' })).toBeVisible()
    expect(await readDb(page, 'seatEvents')).toHaveLength(0)
    expect((await readDb<TripRow>(page, 'trips'))[0]).toMatchObject({ initialSeat: 'standing', boardPlace: '수원역', alightPlace: '신도림역' }) // 다른 값은 그대로

    // 다시 추가 (시각만 입력, 역은 모름)
    await gotoApp(page, `trip/${t.id}`)
    await page.getByRole('button', { name: '+ 중간에 앉음 기록' }).click()
    await setTime(page.getByRole('group', { name: '중간 착석 기록' }), '착석한 시각', '08:35')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: '3월 2일 (월)' })).toBeVisible()
    events = await readDb<EventRow>(page, 'seatEvents')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ time: '08:35', place: null })
  })

  test('여러 번 좌석이 바뀌어도 순서와 상태가 정확히 저장된다 (탑승 중 버튼 + 수정 화면)', async ({ page }) => {
    await gotoApp(page, 'quick')
    await selectLine(page, '1호선')
    await page.getByRole('button', { name: '서서 탑승', exact: true }).click()
    await page.getByRole('button', { name: '지금 탑승' }).click()
    await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
    await page.getByRole('button', { name: '앉았다' }).click()
    await expect(page.getByRole('button', { name: '앉았다' })).toBeDisabled() // 같은 상태를 중복으로 만들 수 없다
    // 어느 역에서 앉았는지 노선 추천에서 고른다
    await page.locator('section', { hasText: '어느 역에서요' }).getByRole('button', { name: '신도림역' }).click()
    await page.getByRole('button', { name: '일어섰다' }).click()
    await page.getByRole('button', { name: '앉았다' }).click()
    await expect.poll(async () => (await readDb(page, 'seatEvents')).length).toBe(3)
    const ev = (await readDb<EventRow & { createdAt: number }>(page, 'seatEvents')).sort((a, b) => a.createdAt - b.createdAt)
    expect(ev.map((e) => e.state)).toEqual(['seated', 'standing', 'seated'])
    expect(ev[0].place).toBe('신도림역')

    // 수정 화면: 중간 착석(첫 착석)과 그 밖의 변화가 따로 보이고 총 3개가 유지된다
    const [trip] = await readDb<TripRow>(page, 'trips')
    await gotoApp(page, `trip/${trip.id}`)
    await expect(page.getByRole('group', { name: '중간 착석 기록' })).toBeVisible()
    await expect(page.locator('.event-card')).toHaveCount(2) // 일어섬, 두 번째 착석
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: /\d+월 \d+일/ }).first()).toBeVisible()
    const after = (await readDb<EventRow & { createdAt: number }>(page, 'seatEvents')).sort((a, b) => a.createdAt - b.createdAt)
    expect(after.map((e) => e.state)).toEqual(['seated', 'standing', 'seated'])
  })
})

test.describe('기존 데이터 호환', () => {
  test('이전 버전 형식의 기록(note 없는 이벤트, 종착역만 있는 구간)이 그대로 표시되고 통계가 유지된다', async ({ page }) => {
    const a = fakeTrip({ line: '1호선', boardTime: '08:00', alightTime: '08:40', trainDestination: '광운대', initialSeat: 'standing', seatLogComplete: true, boardPlace: '수원역' })
    const b = fakeTrip({ line: '2호선', boardTime: '09:00', trainOrigin: '성수', trainDestination: '성수', initialSeat: 'seated' })
    const c = fakeTrip({ line: '수인분당선', boardTime: '10:00', trainOrigin: '인천', initialSeat: 'standing' })
    await restoreBackup(page, { trips: [a, b, c], seatEvents: [fakeEvent(a.id, { time: '08:10', place: '가역', state: 'seated' })] })

    await gotoApp(page, 'day/2026-03-02')
    await expect(page.locator('.card', { hasText: '1호선' })).toContainText('광운대행')
    await expect(page.locator('.card', { hasText: '1호선' })).toContainText('서서 탑승')
    await expect(page.locator('.card', { hasText: '1호선' })).toContainText('08:10 가역 착석')
    await expect(page.locator('.card', { hasText: '1호선' })).toContainText('착석까지 10분')
    await expect(page.locator('.card', { hasText: '2호선' })).toContainText('성수 → 성수행')
    await expect(page.locator('.card', { hasText: '수인분당선' })).toContainText('인천 출발')

    await gotoApp(page, 'stats')
    const metric = (n: string) => page.locator('.metrics > div', { hasText: n })
    await expect(metric('즉시 착석률')).toContainText('(1/3)') // 앉아서 1 / 좌석 기록 3
    await expect(metric('한 번이라도 착석한 비율')).toContainText('(2/2)') // a(중간 착석), b(앉아서) — c 는 변화 미확인이라 제외
    await expect(metric('서서 탄 뒤 착석까지 평균')).toContainText('10분')

    // 수정 화면도 열리고 값이 유지된다
    await gotoApp(page, `trip/${a.id}`)
    await expect(page.getByRole('group', { name: '노선 선택' }).getByRole('button', { name: '1호선', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('종착역 직접 입력')).toHaveValue('광운대')
    await expect(page.getByLabel('운행 출발지 직접 입력')).toHaveValue('')
    await expect(page.getByLabel('승차역 직접 입력')).toHaveValue('수원역')
  })

  test('PDF 이관으로 가져온 구간(출발지→종착역, 순환)이 새 입력 화면에 그대로 반영된다', async ({ page }) => {
    const notes = ['2026-03-02 월요일', '08:00 2호선, 가역->나역, 성수->성수행', '3-2, 왼쪽, 1번째, 서서감', '09:00 1호선, 가역->나역, 서동탄->광운대행', '5-4, 오른쪽, 2번째, 앉아서감', ''].join('\n')
    await gotoApp(page, 'import')
    await page.getByLabel('노트 내용을 직접 붙여 넣을 수도 있습니다').fill(notes)
    await page.getByRole('button', { name: '붙여 넣은 내용 분석' }).click()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: /승인하고 2건 저장/ }).click()
    await expect(page.getByRole('heading', { name: '가져오기 완료' })).toBeVisible()
    const rows = await readDb<TripRow>(page, 'trips')
    expect(rows.find((t) => t.line === '2호선')).toMatchObject({ trainOrigin: '성수', trainDestination: '성수' })
    await gotoApp(page, 'day/2026-03-02')
    await expect(page.locator('.card', { hasText: '2호선' })).toContainText('성수 → 성수행')
    await expect(page.locator('.card', { hasText: '1호선' })).toContainText('서동탄 → 광운대행')
  })

  test('노선 토글을 쓰는 새 화면 이후에도 기존 백업·복원·통계가 계속 동작한다 (저장→백업→전체 삭제→복원)', async ({ page }) => {
    await recordRide(page, { line: '수인분당선', board: '오목천역', alight: '수원역' })
    await gotoApp(page, 'settings')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON 백업 파일 저장' }).click()])
    const path = await download.path()
    page.on('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: '이 기기의 모든 데이터 삭제' }).click()
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(0)
    await page.locator('input[type="file"]').setInputFiles(path)
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/병합 복원 완료/)).toBeVisible()
    const [t] = await readDb<TripRow>(page, 'trips')
    expect(t).toMatchObject({ line: '수인분당선', boardPlace: '오목천역', alightPlace: '수원역' })
    expect(await readDb(page, 'seatEvents')).toHaveLength(1)
  })
})

test.describe('360px 레이아웃 (펼친 상태)', () => {
  test('빠른 기록: 기타 노선·운행 정보·중간 착석·위치를 모두 펼쳐도 잘리거나 가로 스크롤이 없다', async ({ page }) => {
    await restoreBackup(page, {
      trips: [fakeTrip({ line: '1호선', boardPlace: '수원역', alightPlace: '구로역', trainOrigin: '서동탄', trainDestination: '광운대', car: 10, door: 3, side: 'right' })],
    })
    await gotoApp(page, 'quick')
    await expectLayoutOk(page, '빠른 기록(초기)')
    await lineSeg(page).getByRole('button', { name: '1호선', exact: true }).click()
    await expectLayoutOk(page, '빠른 기록(1호선)')
    await selectLine(page, '매우긴이름의노선가상선')
    await page.getByLabel('승차역 직접 입력').fill('아주 긴 이름의 가상 역 이름입니다')
    await page.getByRole('button', { name: '서서 탑승', exact: true }).click()
    await page.getByRole('button', { name: '+ 중간에 앉음 기록' }).click()
    await page.getByRole('button', { name: /위치·대기 순서/ }).click()
    await expectLayoutOk(page, '빠른 기록(모두 펼침)')
    await expectNoSeriousA11y(page, '빠른 기록(모두 펼침)')
  })

  test('기록 수정: 운행 정보·중간 착석·좌석 변화 목록이 잘리지 않고 접근성 위반이 없다', async ({ page }) => {
    const t = fakeTrip({ line: '2호선', boardTime: '08:24', alightTime: '09:20', boardPlace: '신도림역', trainOrigin: '성수', trainDestination: '성수', initialSeat: 'standing', seatLogComplete: true })
    await restoreBackup(page, {
      trips: [t],
      seatEvents: [fakeEvent(t.id, { time: '08:30', place: '홍대입구역' }), fakeEvent(t.id, { time: '08:50', state: 'standing' }), fakeEvent(t.id, { time: '09:00', place: '합정역' })],
    })
    await gotoApp(page, `trip/${t.id}`)
    await expect(page.getByRole('group', { name: '중간 착석 기록' })).toBeVisible()
    await expectLayoutOk(page, '기록 수정')
    await expectNoSeriousA11y(page, '기록 수정')
  })
})
