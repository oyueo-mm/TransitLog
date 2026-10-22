import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { extractPdfText, type PdfLike, type PdfTextResult } from './pdfText'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** 브라우저에서 선택한 PDF 파일의 텍스트를 추출한다. 파일은 기기 밖으로 나가지 않는다 */
export async function extractFromPdfFile(file: File, onProgress?: (page: number, total: number) => void): Promise<PdfTextResult> {
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjs.getDocument({ data }).promise
  return extractPdfText(pdf as unknown as PdfLike, onProgress)
}
