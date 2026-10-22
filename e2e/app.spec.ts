import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { SAMPLE_NOTES, gotoApp, readDb, recordRide } from './fixtures'

interface TripRow {
  id: string
  line: string | null
  boardPlace: string | null
  alightPlace: string | null
  alightTime: string | null
  initialSeat: string | null
  crowding: string | null
  kind: string
  waitOrder: number | null
  note: string | null
  ongoing: boolean
}
interface EventRow {
  state: string
  tripId: string
}

test.describe('빠른 기록과 저장', () => {
  test('탑승 → 좌석 변화 → 하차를 기록하면 저장되고 새로고침·재접속 후에도 남는다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })

    // 실제로 IndexedDB 에 저장되었는지
    const trips = await readDb<TripRow>(page, 'trips')
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({ line: '1호선', boardPlace: '가역', alightPlace: '나역', initialSeat: 'standing', ongoing: false })
    expect(trips[0].alightTime).toMatch(/^\d\d:\d\d$/)
    const events = await readDb<EventRow>(page, 'seatEvents')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ state: 'seated', tripId: trips[0].id })

    await gotoApp(page, '')
    const card = page.locator('.card', { hasText: '1호선' })
    await expect(card).toContainText('가역 → 나역')
    await expect(card).toContainText('서서 탑승')
    await expect(card).toContainText('착석')

    await page.reload()
    await expect(page.locator('.card', { hasText: '1호선' })).toContainText('서서 탑승')
  })

  test('저장한 경로 한 번 선택 + 좌석 한 번 선택 + 지금 탑승, 세 번의 조작으로 기록한다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })

    await gotoApp(page, 'quick')
    // 직전 하차역이 다음 승차역으로 '추천'된다 (점선 칩) — 눌러 확인하기 전에는 저장값이 아님
    await expect(page.getByRole('button', { name: /직전 하차 · 나역/ })).toBeVisible()

    let taps = 0
    await page.locator('button.chip.route').first().click() // 1: 자주 타는 경로
    taps++
    // 가져온 것은 경로·위치뿐이고, 좌석 상태·혼잡도는 아직 선택되지 않은 상태
    await expect(page.getByRole('button', { name: '서서', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('button', { name: '앉아서', exact: true })).toHaveAttribute('aria-pressed', 'false')
    for (const c of ['한산', '보통', '혼잡', '매우 혼잡']) {
      await expect(page.getByRole('button', { name: c, exact: true })).toHaveAttribute('aria-pressed', 'false')
    }
    await expect(page.getByText('경로·위치를 가져왔어요')).toBeVisible()

    await page.getByRole('button', { name: '앉아서', exact: true }).click() // 2: 지금 좌석 상태
    taps++
    await page.getByRole('button', { name: '지금 탑승' }).click() // 3
    taps++
    await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
    expect(taps).toBe(3)

    const trips = await readDb<TripRow>(page, 'trips')
    const second = trips.find((t) => t.ongoing)!
    expect(second).toMatchObject({ line: '1호선', boardPlace: '가역', initialSeat: 'seated' })
    expect(second.crowding).toBeNull() // 선택하지 않은 관측값은 저장되지 않는다
    expect(second.waitOrder).toBeNull()
  })

  test('아무것도 선택하지 않으면 좌석은 미기록으로 저장되고 서서 감으로 표시되지 않는다', async ({ page }) => {
    await gotoApp(page, 'quick')
    await page.getByRole('button', { name: '지금 탑승' }).click()
    await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
    await page.getByRole('button', { name: '하차', exact: true }).click()
    await page.getByRole('button', { name: '하차 완료' }).click()

    const [t] = await readDb<TripRow>(page, 'trips')
    expect(t.initialSeat).toBeNull()
    expect(t.line).toBeNull()
    expect(t.alightPlace).toBeNull()
    await gotoApp(page, '')
    const card = page.locator('.card').first()
    await expect(card).toContainText('좌석 미기록')
    await expect(card).toContainText('노선 미기록')
    await expect(card).not.toContainText('서서')
  })

  test('기록을 수정하고 삭제할 수 있다 (삭제는 확인 후)', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await gotoApp(page, '')
    await page.locator('.card', { hasText: '1호선' }).click()
    await expect(page.getByRole('heading', { name: '기록 수정' })).toBeVisible()

    await page.getByLabel('노선', { exact: true }).fill('2호선') // list 속성이 있어 combobox 역할
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.locator('.card', { hasText: '2호선' })).toBeVisible()

    await page.locator('.card', { hasText: '2호선' }).click()
    page.once('dialog', (d) => {
      expect(d.message()).toContain('삭제')
      void d.dismiss() // 취소하면 남아 있어야 한다
    })
    await page.getByRole('button', { name: '기록 삭제' }).click()
    await expect(page.getByRole('heading', { name: '기록 수정' })).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(1)

    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: '기록 삭제' }).click()
    await expect(page.locator('.card', { hasText: '2호선' })).toHaveCount(0)
    expect(await readDb(page, 'trips')).toHaveLength(0)
    expect(await readDb(page, 'seatEvents')).toHaveLength(0)
  })

  test('통계: 표본 수와 함께 표시하고 값이 없는 지표는 표본 없음으로 둔다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await gotoApp(page, 'stats')
    const metric = (name: string) => page.locator('.metrics > div', { hasText: name })
    await expect(metric('즉시 착석률')).toContainText('0%')
    await expect(metric('즉시 착석률')).toContainText('(0/2)')
    await expect(metric('한 번이라도 착석한 비율')).toContainText('(2/2)')
    // 좌석 변화 기록 완결을 확인하지 않았으므로 최종 착석률은 계산하지 않는다
    await expect(metric('최종 착석률')).toContainText('표본 없음')
    await expect(page.locator('.totals > div', { hasText: '탑승' }).first()).toContainText('2회')
  })
})

test.describe('오프라인과 설치', () => {
  test('오프라인에서도 열리고 기록이 저장되며 다시 열어도 남는다', async ({ page, context }) => {
    await gotoApp(page, '')
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    // 서비스 워커가 페이지를 제어하기 시작할 때까지(첫 방문 직후에는 제어 전일 수 있음) 새로고침
    await page.reload()
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)

    await context.setOffline(true)
    await page.reload()
    await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible()
    await recordRide(page, { line: '9호선', board: '가역', alight: '나역' })
    await gotoApp(page, '')
    await page.reload()
    await expect(page.locator('.card', { hasText: '9호선' })).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(1)
    await context.setOffline(false)
  })

  test('웹 앱 매니페스트가 설치 조건을 갖춘다', async ({ page, request }) => {
    await gotoApp(page, '')
    const href = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(href).toBeTruthy()
    const res = await request.get(new URL(href!, page.url()).toString())
    const m = await res.json()
    expect(m).toMatchObject({ name: expect.any(String), display: 'standalone', lang: 'ko' })
    const sizes = (m.icons as Array<{ sizes: string; purpose?: string }>).map((i) => `${i.sizes}${i.purpose ? ':' + i.purpose : ''}`)
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']))
  })
})

test.describe('백업과 복원', () => {
  test('백업 파일을 만들고, 모두 삭제한 뒤, 복원하면 기록이 돌아온다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await gotoApp(page, '')
    await expect(page.getByText('백업이 필요해요')).toBeVisible() // 데이터가 있는데 백업이 없으면 눈에 띄게 알림

    await gotoApp(page, 'settings')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON 백업 파일 저장' }).click()])
    const path = await download.path()
    const json = JSON.parse(await readFile(path, 'utf8'))
    expect(json).toMatchObject({ app: 'TransitLog', schemaVersion: 1 })
    expect(json.data.trips).toHaveLength(1)
    expect(json.data.seatEvents).toHaveLength(1)

    await gotoApp(page, '')
    await expect(page.getByText('백업이 필요해요')).toHaveCount(0)

    // 전체 삭제 (두 번 확인)
    await gotoApp(page, 'settings')
    let confirms = 0
    page.on('dialog', (d) => {
      confirms++
      void d.accept()
    })
    await page.getByRole('button', { name: '이 기기의 모든 데이터 삭제' }).click()
    await expect.poll(() => confirms).toBe(2)
    await expect.poll(async () => (await readDb(page, 'trips')).length).toBe(0)

    // 복원 (병합)
    await page.locator('input[type="file"]').setInputFiles(path)
    await expect(page.getByText('기록 1건 · 좌석 변화 1건')).toBeVisible()
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/병합 복원 완료: 기록 1건 추가/)).toBeVisible()
    const trips = await readDb<TripRow>(page, 'trips')
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({ line: '1호선', boardPlace: '가역', alightPlace: '나역' })

    // 같은 백업을 다시 복원해도 중복되지 않는다
    await page.locator('input[type="file"]').setInputFiles(path)
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/1건은 이미 있어 건너뜀/)).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(1)
  })

  test('백업이 아닌 파일은 복원을 거부하고 기존 데이터를 건드리지 않는다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await gotoApp(page, 'settings')
    await page.locator('input[type="file"]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') })
    await expect(page.getByText('TransitLog 백업 파일이 아닙니다')).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(1)
  })

  test('CSV 내보내기', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await gotoApp(page, 'settings')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /CSV로 내보내기/ }).click()])
    const csv = await readFile(await download.path(), 'utf8')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('1호선')
    expect(csv.split('\r\n')[0]).toContain('즉시 착석')
  })
})

test.describe('기존 노트 가져오기', () => {
  test('붙여 넣은 노트를 미리보기에서 원문과 비교·수정하고 승인한 뒤에만 저장한다', async ({ page }) => {
    await gotoApp(page, 'import')
    await expect(page.getByText('원본 PDF가 필요합니다')).toBeVisible()
    await page.getByLabel('노트 내용을 직접 붙여 넣을 수도 있습니다').fill(SAMPLE_NOTES)
    await page.getByRole('button', { name: '붙여 넣은 내용 분석' }).click()

    await expect(page.getByRole('heading', { name: '가져오기 미리보기' })).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(0) // 승인 전에는 저장되지 않는다
    const sum = page.locator('.totals').first()
    await expect(sum).toContainText('3건') // 전체 후보
    await expect(page.getByText('누락 정보')).toBeVisible()

    // 원문과 변환 결과를 나란히 확인하고 수정
    await page.getByRole('button', { name: /08:00/ }).click()
    await expect(page.locator('pre.raw')).toContainText('3-2, 왼쪽, 1번째, 서서감->다역에서 앉음(08:10)')
    const note = page.getByLabel('비고', { exact: true })
    await expect(note).toHaveValue('승차 당시 매우 혼잡했음')
    await note.fill('내가 고친 비고')

    // 탑승 근거가 없는 항목은 관찰만으로 분리되어 검토 대상
    await page.getByRole('button', { name: '검토 필요', exact: true }).click()
    await expect(page.locator('.cand')).toHaveCount(1)
    await expect(page.locator('.cand')).toContainText('관찰만')
    await page.getByRole('button', { name: '전체', exact: true }).click()

    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: /승인하고 3건 저장/ }).click()
    await expect(page.getByRole('heading', { name: '가져오기 완료' })).toBeVisible()

    const trips = await readDb<TripRow>(page, 'trips')
    expect(trips).toHaveLength(3)
    const t0800 = trips.find((t) => t.note === '내가 고친 비고')!
    expect(t0800).toMatchObject({ line: '1호선', kind: 'ride', initialSeat: 'standing' })
    const unknownOrder = trips.find((t) => t.kind === 'ride' && t.note !== '내가 고친 비고')!
    expect(unknownOrder.waitOrder).toBeNull() // ?? 는 값으로 채워지지 않는다
    expect(trips.filter((t) => t.kind === 'observed')).toHaveLength(1)
    const days = await readDb<{ date: string; homeDepart: string | null; schoolArrive: string | null }>(page, 'days')
    expect(days).toEqual([expect.objectContaining({ date: '2026-03-02', homeDepart: '07:50', schoolArrive: '09:55' })])

    // 같은 내용을 다시 가져오면 모두 중복으로 표시되고 저장할 수 없다
    await page.getByRole('button', { name: '다른 파일 가져오기' }).click()
    await page.getByLabel('노트 내용을 직접 붙여 넣을 수도 있습니다').fill(SAMPLE_NOTES)
    await page.getByRole('button', { name: '붙여 넣은 내용 분석' }).click()
    await expect(page.locator('.cand .badge', { hasText: '이미 있음' })).toHaveCount(3)
    await expect(page.getByRole('button', { name: /승인하고 0건 저장/ })).toBeDisabled()
    expect(await readDb(page, 'trips')).toHaveLength(3)
  })

  test('PDF 파일을 선택해 텍스트를 추출하고 가져온다', async ({ page, context }) => {
    // 브라우저로 텍스트가 들어 있는 PDF 를 만든다 (가상 샘플)
    const maker = await context.newPage()
    await maker.setContent(`<html><body style="font-family:sans-serif;font-size:14px"><pre>${SAMPLE_NOTES}</pre></body></html>`)
    const pdf = await maker.pdf({ format: 'A4' })
    await maker.close()

    await gotoApp(page, 'import')
    await page.locator('input[type="file"]').setInputFiles({ name: '노트.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('heading', { name: '가져오기 미리보기' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.totals').first()).toContainText('3건')
    await page.getByRole('button', { name: /08:00/ }).click()
    await expect(page.getByLabel('노선', { exact: true })).toHaveValue('1호선')
  })

  test('텍스트가 없는 PDF는 원본이 필요함을 알린다', async ({ page, context }) => {
    const maker = await context.newPage()
    await maker.setContent('<html><body><div style="width:100px;height:100px;background:#888"></div></body></html>')
    const pdf = await maker.pdf()
    await maker.close()
    await gotoApp(page, 'import')
    await page.locator('input[type="file"]').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByText(/읽을 수 있는 텍스트를 찾지 못했습니다/)).toBeVisible({ timeout: 30_000 })
  })
})

const ROUTES = ['', 'quick', 'calendar', 'stats', 'settings', 'import', 'trip/new']

test.describe('360px 모바일 화면과 접근성', () => {
  test('모든 화면에서 가로 스크롤이 없고 조작 요소가 충분히 크다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    for (const r of ROUTES) {
      await gotoApp(page, r)
      await page.waitForTimeout(150)
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      expect(sw, `${r || '오늘'}: 가로 스크롤 발생`).toBeLessThanOrEqual(cw)
      const small = await page.evaluate(() => {
        const out: string[] = []
        for (const el of document.querySelectorAll<HTMLElement>('main button, main a, main select, main input, nav a')) {
          const style = getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'hidden' || el.type === 'file')) continue
          if (el.closest('label.check')) continue
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          if (r.height < 36 || r.width < 36) out.push(`${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`)
        }
        return out
      })
      expect(small, `${r || '오늘'}: 작은 조작 요소`).toEqual([])
    }
  })

  test('기본 접근성: 이름 없는 입력·버튼이 없고 axe 심각 위반이 없다', async ({ page }) => {
    await recordRide(page, { line: '1호선', board: '가역', alight: '나역' })
    await page.locator('html').evaluate(() => void 0)
    expect(await page.locator('html').getAttribute('lang')).toBe('ko')
    for (const r of ROUTES) {
      await gotoApp(page, r)
      await expect(page.locator('h1').first()).toBeVisible()
      const unnamed = await page.evaluate(() => {
        const out: string[] = []
        for (const el of document.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea, button')) {
          if (el.hidden) continue // 파일 선택용 숨김 입력은 버튼으로 대신 열린다
          const id = el.getAttribute('id')
          const name =
            el.getAttribute('aria-label') ||
            (id && document.querySelector(`label[for="${id}"]`)?.textContent?.trim()) ||
            el.closest('label')?.textContent?.trim() ||
            (el.tagName === 'BUTTON' ? el.textContent?.trim() : '')
          if (!name) out.push(el.outerHTML.slice(0, 80))
        }
        return out
      })
      expect(unnamed, `${r || '오늘'}: 접근 가능한 이름이 없는 요소`).toEqual([])
      const res = await new AxeBuilder({ page }).analyze()
      const bad = res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
      expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`), `${r || '오늘'}: axe`).toEqual([])
    }
  })
})
