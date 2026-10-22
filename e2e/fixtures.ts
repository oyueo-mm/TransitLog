import { expect, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { emptyTripDraft, type SeatEvent, type Trip } from '../src/domain/types'

/** 가상의 노트 샘플 (형식만 흉내 낸 예시이며 실제 개인 기록이 아니다) */
export const SAMPLE_NOTES = `2026-03-02 월요일
(07:50 집에서 출발)
08:00 1호선, 가역->나역, 다->라행
3-2, 왼쪽, 1번째, 서서감->다역에서 앉음(08:10)
사람 ㅈㄴ 많음
08:05 마행
5-4, 오른쪽, ??, 앉아서감
10:00 바행
전방향 사람 많음, 다 서서 가는듯
(09:55 학교 도착)
`

export async function gotoApp(page: Page, hash = '') {
  await page.goto(`./#/${hash}`)
  await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible()
}

export const PRESET_LINES = ['수인분당선', '1호선', '2호선']

/** 노선 선택: 프리셋은 토글 버튼, 그 밖의 노선은 '기타' 후 직접 입력 */
export async function selectLine(page: Page, line: string) {
  const group = page.getByRole('group', { name: '노선 선택' })
  if (PRESET_LINES.includes(line)) await group.getByRole('button', { name: line, exact: true }).click()
  else {
    await group.getByRole('button', { name: '기타', exact: true }).click()
    await page.getByLabel('노선 직접 입력').fill(line)
  }
}

/** 지하철 탑승을 시작해 하차까지 기록한다 (빠른 기록 화면) */
export async function recordRide(page: Page, opts: { line: string; board: string; alight: string }) {
  await gotoApp(page, 'quick')
  await selectLine(page, opts.line)
  await page.getByLabel('승차역 직접 입력').fill(opts.board)
  await page.getByRole('button', { name: '서서 탑승', exact: true }).click()
  await page.getByRole('button', { name: '지금 탑승' }).click()
  await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
  await page.getByRole('button', { name: '앉았다' }).click()
  await page.getByRole('button', { name: '하차', exact: true }).click()
  await page.getByLabel('하차 장소').fill(opts.alight)
  await page.getByRole('button', { name: '하차 완료' }).click()
  await expect(page.getByRole('heading', { name: '빠른 기록' })).toBeVisible()
}

/** IndexedDB 를 직접 읽어 실제로 저장되었는지 확인한다 */
export async function readDb<T = unknown>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(
    (name) =>
      new Promise<unknown[]>((resolve, reject) => {
        const req = indexedDB.open('TransitLog')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(name, 'readonly')
          const all = tx.objectStore(name).getAll()
          all.onsuccess = () => {
            db.close()
            resolve(all.result)
          }
          all.onerror = () => reject(all.error)
        }
      }),
    table,
  ) as Promise<T[]>
}

let seq = 0
/** 가상 기록 한 건 (백업 JSON 에 넣어 복원하는 용도) */
export function fakeTrip(p: Partial<Trip> = {}): Trip {
  seq++
  return { ...emptyTripDraft('2026-03-02'), id: `fake-${seq}`, createdAt: 1_000 + seq, updatedAt: 1_000 + seq, ...p }
}
export function fakeEvent(tripId: string, p: Partial<SeatEvent> = {}): SeatEvent {
  seq++
  return { id: `fev-${seq}`, tripId, time: null, state: 'seated', place: null, createdAt: 2_000 + seq, ...p }
}

/** 설정 화면에서 백업 JSON 을 병합 복원한다 */
export async function restoreBackup(page: Page, data: { trips: Trip[]; seatEvents?: SeatEvent[] }) {
  const backup = {
    app: 'TransitLog',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data: { trips: data.trips, seatEvents: data.seatEvents ?? [], days: [], templates: [], settings: [] },
  }
  await gotoApp(page, 'settings')
  await page.locator('input[type="file"]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) })
  await page.getByRole('button', { name: /병합 복원/ }).click()
  await expect(page.getByText(/병합 복원 완료/)).toBeVisible()
}

/** 가로 스크롤이 없고(고정 폭 비교) 조작 요소가 너무 작지 않은지 */
export async function expectLayoutOk(page: Page, label: string) {
  const sw = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))
  // 폭을 넘긴 요소를 함께 보고해 원인을 바로 찾을 수 있게 한다
  const wide = await page.evaluate((limit) => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('main *')) {
      if (el.closest('.tl-scroller')) continue // 가로로 스크롤되는 그래프 내부
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > limit + 1 && getComputedStyle(el).position !== 'fixed') out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 12) ?? ''}] right=${Math.round(r.right)}`)
    }
    return out.slice(0, 6)
  }, page.viewportSize()!.width)
  expect(sw, `${label}: 가로 스크롤 발생 → ${wide.join(' | ')}`).toBeLessThanOrEqual(page.viewportSize()!.width)
  const small = await page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('main button, main a, main select, main input, nav a')) {
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden') continue
      if (el instanceof HTMLInputElement && ['checkbox', 'hidden', 'file'].includes(el.type)) continue
      if (el.closest('label.check')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.height < 36 || r.width < 36) out.push(`${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`)
    }
    return out
  })
  expect(small, `${label}: 작은 조작 요소`).toEqual([])
  // 텍스트가 화면 오른쪽 밖으로 잘리지 않는지
  const clipped = await page.evaluate(() => {
    const w = document.documentElement.clientWidth
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('main *')) {
      if (el.closest('.tl-scroller')) continue
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > w + 1 && getComputedStyle(el).position !== 'fixed') out.push(`${el.tagName}.${el.className}`.slice(0, 40))
    }
    return out.slice(0, 5)
  })
  expect(clipped, `${label}: 화면 밖으로 넘친 요소`).toEqual([])
}

export async function expectNoSeriousA11y(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).analyze()
  const bad = res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
  expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 90)}`), `${label}: axe`).toEqual([])
}

/**
 * 시각 입력(오전/오후 버튼 + 시·분 선택)에 'HH:mm'(24시간제) 값을 넣는다.
 * scope 는 page 또는 그 안의 영역(Locator), label 은 시각 입력의 이름(예: '착석한 시각').
 */
export async function setTime(scope: Page | Locator, label: string, hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  const ap = h >= 12 ? '오후' : '오전'
  const h12 = h % 12 === 0 ? 12 : h % 12
  const group = scope.getByRole('group', { name: label, exact: true })
  await group.getByRole('button', { name: ap, exact: true }).click()
  await group.getByLabel(`${label} 시`, { exact: true }).selectOption(String(h12))
  await group.getByLabel(`${label} 분`, { exact: true }).selectOption(String(m).padStart(2, '0'))
}

/** 시각 입력이 보여 주는 값('오전 08:30') */
export function timeOut(scope: Page | Locator, label: string): Locator {
  return scope.getByRole('group', { name: label, exact: true }).locator('output')
}
