import { expect, type Page } from '@playwright/test'

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

/** 지하철 탑승을 시작해 하차까지 기록한다 (빠른 기록 화면) */
export async function recordRide(page: Page, opts: { line: string; board: string; alight: string }) {
  await gotoApp(page, 'quick')
  await page.getByRole('textbox', { name: '노선', exact: true }).fill(opts.line)
  await page.getByRole('textbox', { name: '승차역', exact: true }).fill(opts.board)
  await page.getByRole('button', { name: '서서', exact: true }).click()
  await page.getByRole('button', { name: '지금 탑승' }).click()
  await expect(page.getByRole('heading', { name: '탑승 중' })).toBeVisible()
  await page.getByRole('button', { name: '앉았다' }).click()
  await page.getByRole('button', { name: '하차', exact: true }).click()
  await page.getByRole('textbox', { name: '하차 장소' }).fill(opts.alight)
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
