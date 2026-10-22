import { joinWrapped, type PhysicalLine } from './syntax'

/**
 * PDF 텍스트 추출 (텍스트 우선).
 * Samsung Notes 의 PDF 는 화면 너비에서 자동 줄바꿈된 상태로 내보내지므로,
 * 줄의 오른쪽 끝이 본문 폭 끝에 닿아 있으면 다음 줄과 이어 붙인다 (페이지 경계 포함).
 * pdf.js 에 직접 의존하지 않도록 필요한 최소 형태만 구조적으로 선언한다.
 */
export interface TextItemLike {
  str: string
  transform: number[]
  width: number
}
export interface PageLike {
  getTextContent(): Promise<{ items: Array<TextItemLike | { type?: string }> }>
  getViewport(opts: { scale: number }): { width: number }
}
export interface PdfLike {
  numPages: number
  getPage(n: number): Promise<PageLike>
}

export interface PdfTextResult {
  text: string
  pages: number
  /** 추출된 글자 수. 0에 가까우면 스캔·손글씨 PDF라 텍스트 추출이 불가능하다 */
  chars: number
}

interface RawLine {
  text: string
  right: number
}

function isText(i: unknown): i is TextItemLike {
  return !!i && typeof (i as TextItemLike).str === 'string' && Array.isArray((i as TextItemLike).transform)
}

async function pageLines(page: PageLike): Promise<{ lines: RawLine[]; width: number }> {
  const content = await page.getTextContent()
  const width = page.getViewport({ scale: 1 }).width
  const items = content.items.filter(isText).filter((i) => i.str.length > 0)
  const rows: Array<{ y: number; items: TextItemLike[] }> = []
  for (const it of items) {
    const y = it.transform[5]
    const size = Math.abs(it.transform[3]) || 10
    const row = rows.find((r) => Math.abs(r.y - y) <= size * 0.45)
    if (row) row.items.push(it)
    else rows.push({ y, items: [it] })
  }
  rows.sort((a, b) => b.y - a.y)
  const lines: RawLine[] = rows.map((r) => {
    const sorted = [...r.items].sort((a, b) => a.transform[4] - b.transform[4])
    let text = ''
    let prevEnd: number | null = null
    for (const it of sorted) {
      const size = Math.abs(it.transform[3]) || 10
      if (prevEnd !== null && it.transform[4] - prevEnd > size * 0.35 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' '
      text += it.str
      prevEnd = it.transform[4] + it.width
    }
    const right = Math.max(...sorted.map((i) => i.transform[4] + i.width))
    return { text: text.replace(/\s+$/g, ''), right }
  })
  return { lines, width }
}

export async function extractPdfText(pdf: PdfLike, onProgress?: (page: number, total: number) => void): Promise<PdfTextResult> {
  const physical: PhysicalLine[] = []
  let chars = 0
  for (let p = 1; p <= pdf.numPages; p++) {
    const { lines, width } = await pageLines(await pdf.getPage(p))
    const contentRight = lines.length ? Math.max(...lines.map((l) => l.right)) : 0
    // 긴 줄이 하나도 없는 페이지에서는 줄바꿈 판정을 하지 않는다
    const hasWrap = contentRight > width * 0.7
    for (const l of lines) {
      chars += l.text.replace(/\s/g, '').length
      physical.push({ text: l.text, full: hasWrap && l.right >= contentRight - width * 0.045 })
    }
    onProgress?.(p, pdf.numPages)
  }
  return { text: joinWrapped(physical).join('\n'), pages: pdf.numPages, chars }
}
