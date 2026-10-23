import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  expectLayoutOk,
  expectNoSeriousA11y,
  fakeEvent,
  fakeTrip,
  gotoApp,
  readDb,
  restoreBackup,
  selectLine,
  setTime,
  timeOut,
} from './fixtures'

interface TripRow {
  id: string
  line: string | null
  boardTime: string | null
  alightTime: string | null
  initialSeat: string | null
  seatLogComplete: boolean | null
  ongoing: boolean
  note: string | null
}
interface EventRow {
  id: string
  tripId: string
  time: string | null
  state: string
  place: string | null
  note?: string | null
  createdAt: number
}

const list = (page: Page) => page.getByRole('list', { name: '좌석 변화 내역' })
const items = (page: Page) => list(page).locator('li.event-item')
// output 요소도 status 역할을 가지므로 안내(토스트)는 클래스로 지정한다
const toastBox = (page: Page) => page.locator('.toast')
const current = (page: Page) => page.getByTestId('current-seat')
const sortedEvents = async (page: Page) => (await readDb<EventRow>(page, 'seatEvents')).sort((a, b) => a.createdAt - b.createdAt)

/** 1호선 서서 탑승을 시작한다. boardTime 을 주면 탑승 시각을 그 값으로 고정한다 (결정적인 시간 계산용) */
async function startOngoing(page: Page, boardTime?: string) {
  await gotoApp(page, 'quick')
  await selectLine(page, '1호선')
  await page.getByRole('button', { name: '서서 탑승', exact: true }).click()
  if (boardTime) {
    await page.getByRole('group', { name: '탑승 시각 설정' }).getByRole('button', { name: '수정' }).click()
    await setTime(page, '탑승 시각', boardTime)
  }
  await page.getByRole('button', { name: '지금 탑승' }).click()
  await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
}

/** 목록의 한 항목에서 '수정' 편집기를 열어 값을 바꾸고 저장한다 */
async function editEvent(page: Page, row: Locator, v: { state?: '착석' | '일어섬'; time?: string; place?: string; note?: string }) {
  await row.getByRole('button', { name: '수정' }).click()
  const ed = page.getByRole('group', { name: '좌석 변화 수정' })
  if (v.state) await ed.getByRole('group', { name: '좌석 상태' }).getByRole('button', { name: v.state, exact: true }).click()
  if (v.time) await setTime(ed, '변경 시각', v.time)
  if (v.place !== undefined) await ed.getByLabel('변경 역·정류장 직접 입력').fill(v.place)
  if (v.note !== undefined) await ed.getByLabel('비고 (선택)').fill(v.note)
  await ed.getByRole('button', { name: '저장', exact: true }).click()
}

test.describe('탑승 중 좌석 변화 수정·삭제·실행 취소', () => {
  test('착석 등록 → 수정 → 삭제 → 현재 상태 복구, 삭제는 이벤트 하나만 지우고 실행 취소로 되돌린다', async ({ page }) => {
    await startOngoing(page, '17:23')
    await expect(current(page)).toContainText('서 있음')
    await expect(items(page)).toHaveCount(0)

    await page.getByRole('button', { name: '앉았다' }).click()
    await expect(items(page)).toHaveCount(1)
    await expect(items(page).first()).toContainText('착석')
    await expect(current(page)).toContainText('앉아 있음')
    await expect(toastBox(page)).toContainText('착석을 기록했습니다')
    await expect(toastBox(page).getByRole('button', { name: '실행 취소' })).toBeVisible()
    const [first] = await sortedEvents(page)

    // 수정: 시각·역·비고
    await editEvent(page, items(page).first(), { time: '17:30', place: '가역', note: '메모' })
    await expect(items(page).first()).toContainText('17:30 · 착석 · 가역 (메모)')
    await expect(page.getByTestId('first-seat')).toContainText('7분') // 17:23 → 17:30
    let ev = await sortedEvents(page)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ id: first.id, time: '17:30', place: '가역', note: '메모', state: 'seated' })

    // 삭제: 이벤트만 사라지고 탑승 기록은 그대로, 현재 좌석은 탑승 시 상태(서서)로 복구
    await items(page).first().getByRole('button', { name: '삭제' }).click()
    await expect(items(page)).toHaveCount(0)
    await expect(current(page)).toContainText('서 있음')
    await expect(page.getByTestId('first-seat')).toHaveCount(0)
    await expect(toastBox(page)).toContainText('좌석 변화를 삭제했습니다')
    const trips = await readDb<TripRow>(page, 'trips')
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({ ongoing: true, boardTime: '17:23', line: '1호선' })

    // 실행 취소: 같은 이벤트(식별자·내용)가 돌아오고 현재 좌석·첫 착석 시간도 복구
    await toastBox(page).getByRole('button', { name: '실행 취소' }).click()
    await expect(items(page)).toHaveCount(1)
    await expect(items(page).first()).toContainText('17:30 · 착석 · 가역 (메모)')
    await expect(current(page)).toContainText('앉아 있음')
    await expect(page.getByTestId('first-seat')).toContainText('7분')
    ev = await sortedEvents(page)
    expect(ev.map((e) => e.id)).toEqual([first.id])
  })

  test('착석 → 일어섬 → 마지막 이벤트 삭제 → 착석 상태 복구, 현재 상태에 맞는 버튼이 강조된다', async ({ page }) => {
    await startOngoing(page)
    const sit = page.getByRole('button', { name: '앉았다' })
    const stand = page.getByRole('button', { name: '일어섰다' })
    // 서 있는 상태: '앉았다' 강조, '일어섰다' 비활성
    await expect(sit).toHaveClass(/btn-primary/)
    await expect(stand).toBeDisabled()

    await sit.click()
    await expect(current(page)).toContainText('앉아 있음')
    // 앉아 있는 상태: '일어섰다' 강조, '앉았다' 비활성
    await expect(stand).toHaveClass(/btn-primary/)
    await expect(sit).toBeDisabled()
    await stand.click()
    await expect(items(page)).toHaveCount(2)
    await expect(current(page)).toContainText('서 있음')

    await items(page).nth(1).getByRole('button', { name: '삭제' }).click()
    await expect(items(page)).toHaveCount(1)
    await expect(current(page)).toContainText('앉아 있음')
    await expect(stand).toHaveClass(/btn-primary/)
    // 첫 번째(착석)는 그대로
    await expect(items(page).first()).toContainText('착석')
    expect((await sortedEvents(page)).map((e) => e.state)).toEqual(['seated'])
  })

  test('잘못 누른 이벤트를 상세 화면 이동이나 전체 삭제 없이 바로잡는다 (착석→일어섬으로 수정)', async ({ page }) => {
    await startOngoing(page)
    await page.getByRole('button', { name: '앉았다' }).click()
    await expect(current(page)).toContainText('앉아 있음')
    // 사실은 '일어섬'을 눌러야 했던 상황: 상태를 일어섬으로 수정
    await editEvent(page, items(page).first(), { state: '일어섬' })
    await expect(items(page).first()).toContainText('일어섬')
    await expect(current(page)).toContainText('서 있음')
    expect(page.url()).toContain('/quick') // 화면 이동 없음
    expect((await readDb(page, 'trips'))).toHaveLength(1)
  })

  test('같은 분의 서로 다른 이벤트는 합쳐지거나 자동 삭제되지 않고 입력 순서와 식별자가 유지된다', async ({ page }) => {
    await startOngoing(page, '17:23')
    await page.getByRole('button', { name: '앉았다' }).click()
    await page.getByRole('button', { name: '일어섰다' }).click()
    await expect(items(page)).toHaveCount(2)
    const [a, b] = await sortedEvents(page)
    // 두 이벤트의 시각을 같은 17:30 으로 맞춘다
    await editEvent(page, items(page).nth(0), { time: '17:30' })
    await editEvent(page, items(page).nth(1), { time: '17:30' })
    await expect(items(page)).toHaveCount(2)
    await expect(items(page).nth(0)).toContainText('17:30 · 착석')
    await expect(items(page).nth(1)).toContainText('17:30 · 일어섬')
    await expect(current(page)).toContainText('서 있음')

    // 새로고침해도 순서·식별자 유지
    await page.reload()
    await expect(items(page)).toHaveCount(2)
    await expect(items(page).nth(0)).toContainText('착석')
    await expect(items(page).nth(1)).toContainText('일어섬')
    const after = await sortedEvents(page)
    expect(after.map((e) => e.id)).toEqual([a.id, b.id])
    expect(after.map((e) => e.state)).toEqual(['seated', 'standing'])
    expect(after[1].createdAt).toBeGreaterThan(after[0].createdAt)
  })

  test('버튼을 아주 빠르게 여러 번 눌러도 중복 이벤트가 생기지 않는다', async ({ page }) => {
    await startOngoing(page)
    // 렌더링이 끝나기 전에 같은 클릭이 연달아 들어오는 상황을 재현
    await page.getByRole('button', { name: '앉았다' }).evaluate((el) => {
      const b = el as HTMLButtonElement
      b.click()
      b.click()
      b.click()
    })
    await expect(items(page)).toHaveCount(1)
    await expect(current(page)).toContainText('앉아 있음')
    expect(await readDb(page, 'seatEvents')).toHaveLength(1)

    // 서로 다른 동작을 번갈아 빠르게 누르면 모두 기록된다
    await page.getByRole('button', { name: '일어섰다' }).click()
    await page.getByRole('button', { name: '앉았다' }).click()
    await expect(items(page)).toHaveCount(3)
    expect((await sortedEvents(page)).map((e) => e.state)).toEqual(['seated', 'standing', 'seated'])
  })

  test('좌석 상태가 기록되지 않은 탑승은 상태를 지정할 수 있다 (잘못 지정하면 실행 취소)', async ({ page }) => {
    await gotoApp(page, 'quick')
    await page.getByRole('button', { name: '지금 탑승' }).click() // 아무것도 고르지 않음
    await expect(current(page)).toContainText('미기록')
    const grp = page.getByRole('group', { name: '탑승 시 좌석 상태 지정' })
    await grp.getByRole('button', { name: '서서 탑승' }).click()
    await expect(current(page)).toContainText('서 있음')
    expect((await readDb<TripRow>(page, 'trips'))[0].initialSeat).toBe('standing')
    await toastBox(page).getByRole('button', { name: '실행 취소' }).click()
    await expect(current(page)).toContainText('미기록')
    expect((await readDb<TripRow>(page, 'trips'))[0].initialSeat).toBeNull()
  })
})

test.describe('좌석 기록 완결 확인(seatLogComplete)과 통계 재계산', () => {
  test('이벤트를 고치면 이전의 완결 확인이 해제되어 부정확하게 남지 않는다', async ({ page }) => {
    await startOngoing(page, '17:23')
    await page.getByRole('button', { name: '앉았다' }).click()
    await page.getByRole('button', { name: '하차', exact: true }).click()
    await page.getByRole('group', { name: '탑승 중 좌석 변화를 모두 기록했나요?' }).getByRole('button', { name: '예, 더 없음' }).click()
    await page.getByRole('button', { name: '하차 완료' }).click()
    await expect(page.getByRole('heading', { name: '빠른 기록' })).toBeVisible()
    const [trip] = await readDb<TripRow>(page, 'trips')
    expect(trip.seatLogComplete).toBe(true)

    // 수정 화면에서 중간 착석 시각을 바꾸고 저장 → 완결 확인이 해제된다
    await gotoApp(page, `trip/${trip.id}`)
    const yes = page.getByRole('group', { name: '좌석 변화 기록이 완결되었나요?' }).getByRole('button', { name: '예, 더 없음' })
    await expect(yes).toHaveAttribute('aria-pressed', 'true')
    await setTime(page.getByRole('group', { name: '중간 착석 기록' }), '착석한 시각', '17:31')
    await expect(yes).toHaveAttribute('aria-pressed', 'false') // 화면에서 즉시 해제
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: /\d+월 \d+일/ }).first()).toBeVisible()
    expect((await readDb<TripRow>(page, 'trips'))[0].seatLogComplete).toBeNull()

    // 다시 확인하면 저장되고, 역·비고만 고쳐서는 유지된다
    await gotoApp(page, `trip/${trip.id}`)
    await page.getByRole('group', { name: '좌석 변화 기록이 완결되었나요?' }).getByRole('button', { name: '예, 더 없음' }).click()
    await page.getByRole('group', { name: '중간 착석 기록' }).getByLabel('비고 (선택)').fill('메모만 수정')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: /\d+월 \d+일/ }).first()).toBeVisible()
    expect((await readDb<TripRow>(page, 'trips'))[0].seatLogComplete).toBe(true)
  })

  test('이벤트 수정·삭제 후 통계가 즉시 다시 계산되고, 판정 불가 기록은 서서/앉아서로 추정되지 않는다', async ({ page }) => {
    const t = fakeTrip({ line: '1호선', boardTime: '17:00', alightTime: '17:40', initialSeat: 'standing', seatLogComplete: true })
    await restoreBackup(page, { trips: [t], seatEvents: [fakeEvent(t.id, { time: '17:10', state: 'seated' })] })

    await gotoApp(page, 'stats')
    const metric = (name: string) => page.locator('.metric, .metrics > div', { hasText: name }).first()
    await expect(metric('한 번이라도 착석한 비율')).toContainText('(1/1)')
    await expect(metric('서서 탄 뒤 착석까지 평균')).toContainText('10분')
    // 100% (1/1) 은 숫자보다 '표본 부족' 경고가 더 눈에 띈다
    const weak = metric('한 번이라도 착석한 비율')
    await expect(weak.locator('.caution.strong')).toContainText('표본 부족 (1건)')
    const sizes = await weak.evaluate((el) => ({
      caution: parseFloat(getComputedStyle(el.querySelector('.caution')!).fontSize),
      value: parseFloat(getComputedStyle(el.querySelector('.value')!).fontSize),
      order: Array.from(el.children).map((c) => c.className),
    }))
    expect(sizes.caution).toBeGreaterThan(sizes.value)
    expect(sizes.order.indexOf('caution strong')).toBeLessThan(sizes.order.findIndex((c) => c.startsWith('value')))

    // 시각 수정 → 평균 시간 갱신 (완결 확인은 해제되어 서서 이동 시간 등은 미확인)
    await gotoApp(page, `trip/${t.id}`)
    await setTime(page.getByRole('group', { name: '중간 착석 기록' }), '착석한 시각', '17:25')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: /\d+월 \d+일/ }).first()).toBeVisible()
    await gotoApp(page, 'stats')
    await expect(metric('서서 탄 뒤 착석까지 평균')).toContainText('25분')
    await expect(metric('한 번이라도 착석한 비율')).toContainText('(1/1)') // 앉은 것은 여전히 확인됨
    await expect(metric('최종 착석률')).toContainText('표본 없음') // 완결 미확인

    // 착석 이벤트 삭제 → 미확인이므로 한 번이라도 착석 표본에서 빠진다
    await gotoApp(page, `trip/${t.id}`)
    await page.getByRole('button', { name: '중간 착석 삭제' }).click()
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: /\d+월 \d+일/ }).first()).toBeVisible()
    await gotoApp(page, 'stats')
    await expect(metric('한 번이라도 착석한 비율')).toContainText('표본 없음')
    await expect(metric('한 번이라도 착석한 비율')).toContainText('제외 1건')
    await expect(metric('서서 탄 뒤 착석까지 평균')).toContainText('—')
  })

  test('전체 대비 판정 가능한 건수·제외 건수·분모 차이를 보여 주고, 일부만 판정된 비율에 주의를 준다', async ({ page }) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const trips = Array.from({ length: 30 }, (_, i) => {
      const m = 360 + i * 3
      const seated = i < 12
      return fakeTrip({ line: '1호선', boardTime: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, initialSeat: seated ? 'seated' : 'standing' })
    })
    await restoreBackup(page, { trips })
    await gotoApp(page, 'stats')
    await expect(page.locator('.sample-overview')).toContainText('전체 탑승 30건')
    await expect(page.locator('.sample-overview')).toContainText('즉시 30건 · 한 번이라도 12건 · 최종 0건')
    await page.locator('.sample-overview summary').click()
    await expect(page.locator('.sample-overview')).toContainText('분모가 서로 다른 이유')

    const ever = page.locator('.metric', { hasText: '한 번이라도 착석한 비율' })
    await expect(ever).toContainText('판정 가능 12건 / 전체 30건 · 제외 18건')
    await expect(ever.locator('.caution')).toContainText('전체의 40%만 판정')
    await ever.locator('summary').click()
    await expect(ever).toContainText('서서 탔지만 이후 앉았는지 확인하지 않음')
    await expect(ever).toContainText('18건')
    // 판정 가능 표본이 충분한 즉시 착석률에는 경고가 없다
    const imm = page.locator('.metric', { hasText: '즉시 착석률' })
    await expect(imm).toContainText('(12/30)')
    await expect(imm.locator('.caution')).toHaveCount(0)
    // 제외된 18건을 어느 쪽으로도 세지 않는다
    await expect(ever).toContainText('(12/12)')
    await expectNoSeriousA11y(page, '통계')
  })
})

test.describe('승·하차 시각 입력 (모바일)', () => {
  const trip = () => fakeTrip({ line: '1호선', boardTime: '09:24', alightTime: '18:05', initialSeat: 'standing', boardPlace: '수원역' })

  for (const width of [320, 360, 390]) {
    test(`${width}px: 승차·하차 시각이 한 행씩 전체 너비로 잘리지 않고 표시된다`, async ({ page }) => {
      mkdirSync('test-results/shots', { recursive: true })
      const t = trip()
      await page.setViewportSize({ width, height: 800 })
      await restoreBackup(page, { trips: [t] })
      await gotoApp(page, `trip/${t.id}`)

      for (const [label, shown] of [
        ['승차 시각', '오전 09:24'],
        ['하차 시각', '오후 06:05'],
      ] as const) {
        const g = page.getByRole('group', { name: label, exact: true })
        await expect(g.locator('output')).toHaveText(shown) // 한국어 오전/오후 표기
        const geo = await g.evaluate((el, w) => {
          const box = el.getBoundingClientRect()
          const out = el.querySelector('output')!
          const sels = Array.from(el.querySelectorAll('select'))
          const btns = Array.from(el.querySelectorAll('.ti-ap button'))
          return {
            left: box.left,
            right: box.right,
            width: box.width,
            viewport: w,
            outClipped: out.scrollWidth > out.clientWidth + 1,
            selClipped: sels.some((s) => s.scrollWidth > s.clientWidth + 1),
            selBoxes: sels.map((s) => s.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, h: r.height })),
            btnBoxes: btns.map((b) => b.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, h: r.height })),
          }
        }, width)
        expect(geo.left, `${label}@${width} 왼쪽`).toBeGreaterThanOrEqual(0)
        expect(geo.right, `${label}@${width} 오른쪽`).toBeLessThanOrEqual(width)
        expect(geo.width, `${label}@${width} 너비`).toBeGreaterThan(width - 48) // 한 행 전체 너비
        expect(geo.outClipped, `${label} 표시 값 잘림`).toBe(false)
        expect(geo.selClipped, `${label} 선택칸 글자 잘림`).toBe(false)
        for (const s of geo.selBoxes) {
          expect(s.r).toBeLessThanOrEqual(width)
          expect(s.h).toBeGreaterThanOrEqual(44)
        }
        for (const b of geo.btnBoxes) {
          expect(b.r).toBeLessThanOrEqual(width)
          expect(b.h).toBeGreaterThanOrEqual(44)
        }
      }
      // 승차·하차 시각이 서로 다른 행에 있다 (옆에 나란히 있지 않음)
      const rows = await page.evaluate(() => ['승차 시각', '하차 시각'].map((n) => document.querySelector(`[role="group"][aria-label="${n}"]`)!.getBoundingClientRect().top))
      expect(rows[1]).toBeGreaterThan(rows[0] + 100)
      await expectLayoutOk(page, `기록 수정 ${width}px`)
      await page.screenshot({ path: `test-results/shots/editor-${width}.png`, fullPage: true })
    })
  }

  test('글자 크기를 150%·200%로 키워도 시각 입력이 잘리지 않는다', async ({ page }) => {
    const t = trip()
    await restoreBackup(page, { trips: [t] })
    for (const pct of [150, 200]) {
      await gotoApp(page, `trip/${t.id}`)
      await page.addStyleTag({ content: `html { font-size: ${pct}% !important; }` })
      const g = page.getByRole('group', { name: '승차 시각', exact: true })
      await expect(g.locator('output')).toHaveText('오전 09:24')
      const r = await g.evaluate((el) => {
        const w = document.documentElement.clientWidth
        const out = el.querySelector('output')!
        return {
          sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          w,
          boxRight: el.getBoundingClientRect().right,
          outClipped: out.scrollWidth > out.clientWidth + 1,
          selClipped: Array.from(el.querySelectorAll('select')).some((s) => s.scrollWidth > s.clientWidth + 1),
          overflow: Array.from(el.querySelectorAll('*')).filter((n) => n.getBoundingClientRect().right > w + 1).length,
          wide: Array.from(document.querySelectorAll('main *'))
            .filter((n) => n.getBoundingClientRect().right > w + 1 && getComputedStyle(n).position !== 'fixed')
            .slice(0, 6)
            .map((n) => `${n.tagName.toLowerCase()}.${String((n as HTMLElement).className).slice(0, 24)}[${(n.getAttribute('aria-label') ?? n.textContent ?? '').trim().slice(0, 14)}] right=${Math.round(n.getBoundingClientRect().right)}`),
        }
      })
      expect(r.sw, `${pct}% 가로 스크롤 → ${r.wide.join(' | ')}`).toBeLessThanOrEqual(360)
      expect(r.boxRight).toBeLessThanOrEqual(360)
      expect(r.outClipped).toBe(false)
      expect(r.selClipped).toBe(false)
      expect(r.overflow, `${pct}% 폭 초과 요소`).toBe(0)
      await page.screenshot({ path: `test-results/shots/editor-font${pct}.png`, fullPage: false })
    }
  })

  test('오전/오후 표기와 24시간제 저장 형식(기존 데이터 형식 유지)', async ({ page }) => {
    const t = trip()
    await restoreBackup(page, { trips: [t] })
    await gotoApp(page, `trip/${t.id}`)
    const cases: Array<[string, string]> = [
      ['00:05', '오전 12:05'],
      ['11:59', '오전 11:59'],
      ['12:00', '오후 12:00'],
      ['13:07', '오후 01:07'],
      ['23:59', '오후 11:59'],
    ]
    for (const [hhmm, shown] of cases) {
      await setTime(page, '승차 시각', hhmm)
      await expect(timeOut(page, '승차 시각')).toHaveText(shown)
    }
    await setTime(page, '승차 시각', '13:07')
    await setTime(page, '하차 시각', '00:10')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: /\d+월 \d+일/ }).first()).toBeVisible()
    const [saved] = await readDb<TripRow>(page, 'trips')
    expect(saved.boardTime).toBe('13:07') // 저장은 여전히 24시간제 HH:mm
    expect(saved.alightTime).toBe('00:10') // 자정을 넘기는 이동 계산도 같은 형식
  })

  test('시·분을 모두 고르기 전에는 값이 저장되지 않고(미기록), 지우기로 비울 수 있다', async ({ page }) => {
    const t = fakeTrip({ line: '1호선', boardTime: null, alightTime: null })
    await restoreBackup(page, { trips: [t] })
    await gotoApp(page, `trip/${t.id}`)
    const g = page.getByRole('group', { name: '승차 시각', exact: true })
    await expect(g.locator('output')).toHaveText('시·분을 모두 선택하세요')
    await g.getByRole('listbox', { name: '승차 시각 시', exact: true }).getByRole('option', { name: '9', exact: true }).click()
    await expect(g.locator('output')).toHaveText('시·분을 모두 선택하세요') // 분이 없으면 값 없음
    await g.getByRole('listbox', { name: '승차 시각 분', exact: true }).getByRole('option', { name: '30', exact: true }).click()
    await expect(g.locator('output')).toHaveText('오전 09:30')
    await g.getByRole('button', { name: '지우기' }).click()
    await expect(g.locator('output')).toHaveText('시·분을 모두 선택하세요')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: /\d+월 \d+일/ }).first()).toBeVisible()
    expect((await readDb<TripRow>(page, 'trips'))[0].boardTime).toBeNull()
  })

  test('탑승 중·하차·하루 기록 화면의 시각 입력도 320px에서 잘리지 않는다', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await startOngoing(page, '17:23')
    await page.getByRole('button', { name: '앉았다' }).click()
    // 실행 취소 안내가 좁은 화면에서 찌그러지지 않는다 (글자가 세로로 쪼개지면 높이가 커진다)
    const box = await toastBox(page).boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(260)
    expect(box!.height).toBeLessThanOrEqual(80)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
    await items(page).first().getByRole('button', { name: '수정' }).click()
    await expectLayoutOk(page, '좌석 변화 수정 320px')
    await expectNoSeriousA11y(page, '좌석 변화 수정')
    await page.screenshot({ path: 'test-results/shots/ongoing-edit-320.png', fullPage: true })
    await page.getByRole('group', { name: '좌석 변화 수정' }).getByRole('button', { name: '취소' }).click()
    await page.getByRole('button', { name: '하차', exact: true }).click()
    await expect(timeOut(page, '하차 시각')).toHaveText(/^(오전|오후) \d\d:\d\d$/)
    await expectLayoutOk(page, '하차 시각 320px')
    await gotoApp(page, '')
    await page.getByRole('button', { name: /집 출발/ }).click()
    await expect(page.getByRole('group', { name: '집 출발', exact: true })).toBeVisible()
    await expectLayoutOk(page, '하루 기록 320px')
    await page.screenshot({ path: 'test-results/shots/day-320.png', fullPage: true })
  })
})

test.describe('오프라인과 데이터 호환', () => {
  test('오프라인에서도 좌석 이벤트를 수정·삭제·실행 취소할 수 있다', async ({ page, context }) => {
    await gotoApp(page, '')
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    await page.reload()
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    await context.setOffline(true)

    await startOngoing(page, '17:23')
    await page.getByRole('button', { name: '앉았다' }).click()
    await editEvent(page, items(page).first(), { time: '17:30', place: '가역' })
    await expect(items(page).first()).toContainText('17:30 · 착석 · 가역')
    await items(page).first().getByRole('button', { name: '삭제' }).click()
    await expect(items(page)).toHaveCount(0)
    await toastBox(page).getByRole('button', { name: '실행 취소' }).click()
    await expect(items(page)).toHaveCount(1)
    await page.reload()
    await expect(items(page).first()).toContainText('17:30 · 착석 · 가역')
    expect(await readDb(page, 'seatEvents')).toHaveLength(1)
    await context.setOffline(false)
  })

  test('이전 버전에서 저장한 탑승 중 기록(note 없는 이벤트)을 그대로 열어 수정·삭제하고, 백업·복원해도 보존된다', async ({ page }) => {
    const t = fakeTrip({ line: '1호선', boardTime: '17:23', initialSeat: 'standing', ongoing: true })
    const e1 = fakeEvent(t.id, { time: '17:30', state: 'seated' }) // note 필드 없음(이전 형식)
    const e2 = fakeEvent(t.id, { time: '17:40', state: 'standing' })
    await restoreBackup(page, { trips: [t], seatEvents: [e1, e2] })

    await gotoApp(page, 'quick')
    await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
    await expect(items(page)).toHaveCount(2)
    await expect(current(page)).toContainText('서 있음')
    await editEvent(page, items(page).nth(0), { note: '이전 기록 수정' })
    await expect(items(page).nth(0)).toContainText('(이전 기록 수정)')
    await items(page).nth(1).getByRole('button', { name: '삭제' }).click()
    await expect(items(page)).toHaveCount(1)
    await expect(current(page)).toContainText('앉아 있음')
    const kept = await readDb<EventRow>(page, 'seatEvents')
    expect(kept.map((e) => e.id)).toEqual([e1.id]) // 다른 이벤트·식별자 손상 없음

    // 백업 → 전체 삭제 → 복원: 수정 내용이 그대로 돌아온다
    await gotoApp(page, 'settings')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON 백업 파일 저장' }).click()])
    const path = await download.path()
    const json = JSON.parse(await readFile(path, 'utf8'))
    expect(json.data.seatEvents).toHaveLength(1)
    expect(json.data.seatEvents[0]).toMatchObject({ id: e1.id, note: '이전 기록 수정' })
    page.on('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: '이 기기의 모든 데이터 삭제' }).click()
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(0)
    await page.locator('input[type="file"]').setInputFiles(path)
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/병합 복원 완료/)).toBeVisible()
    const restored = await readDb<EventRow>(page, 'seatEvents')
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ id: e1.id, note: '이전 기록 수정', time: '17:30' })
  })
})
