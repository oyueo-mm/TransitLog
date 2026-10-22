import { expect, test } from '@playwright/test'
import { candidatesToBackup } from '../src/import/commit'
import { parseNotes } from '../src/import/parser'
import { gotoApp, readDb, recordRide } from './fixtures'

/**
 * 초기 이관 흐름(217건)을 가상 데이터로 재현한다.
 * 실제 이관과 같은 경로(노트 텍스트 → 파서 → 백업 JSON → 앱에서 복원 → 같은 노트 다시 가져오기)를 지난다.
 * 데이터는 전부 가상이며 실제 개인 기록이 아니다.
 */
function syntheticNotes(count: number): string {
  const out: string[] = []
  let made = 0
  let day = 0
  while (made < count) {
    const d = new Date(2026, 2, 2 + day)
    day++
    if (d.getDay() === 0) continue
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    out.push('(07:50 집에서 출발)')
    for (let k = 0; k < 4 && made < count; k++, made++) {
      const hh = String(8 + k).padStart(2, '0')
      const mm = String(5 + k * 7).padStart(2, '0')
      const stand = k % 2 === 0
      out.push(`${hh}:${mm} 1호선, 가역->나역, 다->라행`)
      out.push(`${3 + k}-${1 + (k % 3)}, ${k % 2 ? '왼쪽' : '오른쪽'}, ${k + 1}번째, ${stand ? '서서감->다역에서 앉음(' + hh + ':' + String(Number(mm) + 3).padStart(2, '0') + ')' : '앉아서감'}`)
    }
    out.push('(09:50 학교 도착)')
  }
  return out.join('\n')
}

test.describe('초기 이관 (가상 217건)', () => {
  const NOTES = syntheticNotes(217)

  test('백업 JSON 복원 → 같은 노트 다시 가져오기: 기록이 중복 생성되지 않는다', async ({ page }) => {
    const parsed = parseNotes(NOTES)
    expect(parsed.candidates.filter((c) => c.status === 'confirmed' && c.trip.kind === 'ride')).toHaveLength(217)
    const backup = candidatesToBackup(parsed, { onlyConfirmed: true })
    expect(backup.data.trips).toHaveLength(217)
    const buffer = Buffer.from(JSON.stringify(backup))

    await gotoApp(page, 'settings')
    await page.locator('input[type="file"]').setInputFiles({ name: 'import.json', mimeType: 'application/json', buffer })
    await expect(page.getByText(/기록 217건/)).toBeVisible()
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/기록 217건 추가/)).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(217)
    expect((await readDb(page, 'seatEvents')).length).toBeGreaterThan(0)
    expect((await readDb(page, 'days')).length).toBeGreaterThan(0)

    // 같은 JSON 을 한 번 더 복원해도 늘지 않는다
    await page.locator('input[type="file"]').setInputFiles({ name: 'import.json', mimeType: 'application/json', buffer })
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/217건은 이미 있어 건너뜀/)).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(217)

    // 같은 노트를 이번에는 가져오기 화면(PDF 가져오기와 같은 경로)으로 불러온다 → 전부 중복으로 표시
    await gotoApp(page, 'import')
    await page.getByLabel('노트 내용을 직접 붙여 넣을 수도 있습니다').fill(NOTES)
    await page.getByRole('button', { name: '붙여 넣은 내용 분석' }).click()
    await expect(page.getByRole('heading', { name: '가져오기 미리보기' })).toBeVisible()
    await expect(page.locator('.totals').first()).toContainText('217건')
    await expect(page.locator('.cand .badge', { hasText: '이미 있음' })).toHaveCount(217)
    await expect(page.getByRole('button', { name: /승인하고 0건 저장/ })).toBeDisabled()
    expect(await readDb(page, 'trips')).toHaveLength(217)
  })

  test('노트를 먼저 가져온 뒤 백업을 복원해도 중복되지 않고, 일부만 겹치면 새 기록만 추가된다', async ({ page }) => {
    const first = syntheticNotes(40)
    await gotoApp(page, 'import')
    await page.getByLabel('노트 내용을 직접 붙여 넣을 수도 있습니다').fill(first)
    await page.getByRole('button', { name: '붙여 넣은 내용 분석' }).click()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: /승인하고 40건 저장/ }).click()
    await expect(page.getByRole('heading', { name: '가져오기 완료' })).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(40)

    // 80건짜리 이관 파일에는 앞의 40건이 이미 들어 있다
    const buffer = Buffer.from(JSON.stringify(candidatesToBackup(parseNotes(syntheticNotes(80)), { onlyConfirmed: true })))
    await gotoApp(page, 'settings')
    await page.locator('input[type="file"]').setInputFiles({ name: 'import.json', mimeType: 'application/json', buffer })
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/기록 40건 추가, 40건은 이미 있어 건너뜀/)).toBeVisible()
    expect(await readDb(page, 'trips')).toHaveLength(80)
  })

  test('이관 뒤에 직접 기록한 데이터와 수정한 비고는 복원·재가져오기로 덮어쓰이지 않는다', async ({ page }) => {
    const buffer = Buffer.from(JSON.stringify(candidatesToBackup(parseNotes(syntheticNotes(20)), { onlyConfirmed: true })))
    await gotoApp(page, 'settings')
    await page.locator('input[type="file"]').setInputFiles({ name: 'import.json', mimeType: 'application/json', buffer })
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/기록 20건 추가/)).toBeVisible()

    // 가져온 기록 하나를 수정하고, 새 기록도 하나 남긴다
    await gotoApp(page, 'day/2026-03-02')
    await page.locator('.card').first().click()
    await page.getByLabel('비고', { exact: true }).fill('내가 직접 고친 메모')
    await page.getByRole('button', { name: '저장', exact: true }).click()
    await expect(page.getByRole('heading', { name: '3월 2일 (월)' })).toBeVisible() // 저장 후 화면 전환이 끝난 뒤 이어서 진행
    await recordRide(page, { line: '9호선', board: '가역', alight: '나역' })
    expect(await readDb(page, 'trips')).toHaveLength(21)

    // 같은 이관 파일을 다시 복원해도 수정한 비고와 새 기록이 그대로다
    await gotoApp(page, 'settings')
    await page.locator('input[type="file"]').setInputFiles({ name: 'import.json', mimeType: 'application/json', buffer })
    await page.getByRole('button', { name: /병합 복원/ }).click()
    await expect(page.getByText(/20건은 이미 있어 건너뜀/)).toBeVisible()
    const trips = await readDb<{ note: string | null }>(page, 'trips')
    expect(trips).toHaveLength(21)
    expect(trips.filter((t) => t.note === '내가 직접 고친 메모')).toHaveLength(1)
  })

  test('제외할 개인 단어는 이 기기에만 저장되고 해당 비고 문장은 가져오지 않는다', async ({ page }) => {
    const notes = ['2026-03-02 월요일', '08:00 1호선, 가역->나역, 다->라행', '3-2, 왼쪽, 1번째, 서서감', '라마바 행사 이야기를 열차 안에서 함', ''].join('\n')
    await gotoApp(page, 'import')
    await page.getByLabel(/이 단어가 들어 있는 비고 문장은 가져오지 않습니다/).fill('라마바')
    await page.getByLabel('노트 내용을 직접 붙여 넣을 수도 있습니다').fill(notes)
    await page.getByRole('button', { name: '붙여 넣은 내용 분석' }).click()
    await page.getByRole('button', { name: /08:00/ }).click()
    await expect(page.getByLabel('비고', { exact: true })).toHaveValue('')
    await expect(page.locator('.dropped')).toContainText('라마바 행사')

    // 새로고침해도 입력한 단어가 남아 있다 (IndexedDB 설정)
    await page.reload()
    await expect(page.getByLabel(/이 단어가 들어 있는 비고 문장은 가져오지 않습니다/)).toHaveValue('라마바')
    expect((await readDb<{ key: string }>(page, 'settings')).some((r) => r.key === 'import.excludeWords')).toBe(true)
  })
})
