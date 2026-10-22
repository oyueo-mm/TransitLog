/**
 * 로컬 전용: 노트 PDF를 파싱해 검토용 요약과 (선택) 백업 JSON 으로 저장한다.
 *   npx tsx scripts/import-local.ts <노트.pdf> [--out private/import.json] [--confirmed-only] [--dump private/report.txt]
 * --confirmed-only: 검토 필요 항목을 빼고 문제가 없는 후보만 백업 JSON 으로 만든다 (나머지는 앱의 가져오기 미리보기에서 검토)
 * 결과는 private/ (gitignore) 에만 쓴다. 저장소에 개인 기록을 남기지 않는다.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfText, type PdfLike } from '../src/import/pdfText'
import { parseNotes } from '../src/import/parser'
import { candidatesToBackup, summarize } from '../src/import/commit'

const args = process.argv.slice(2)
const file = args[0]
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
if (!file) {
  console.error('사용법: npx tsx scripts/import-local.ts <노트.pdf> [--out private/import.json] [--dump private/report.txt]')
  process.exit(1)
}

const data = new Uint8Array(await readFile(file))
const pdf = await getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise
const res = await extractPdfText(pdf as unknown as PdfLike)
console.log(`페이지 ${res.pages}, 추출 글자 수 ${res.chars}`)

const parsed = parseNotes(res.text)
const sum = summarize(parsed)
console.log(JSON.stringify(sum, null, 2))

const dump = opt('--dump')
if (dump) {
  await mkdir(dirname(dump), { recursive: true })
  const lines: string[] = []
  for (const c of parsed.candidates) {
    lines.push(
      `[${c.status}${c.duplicate !== 'none' ? '/' + c.duplicate : ''}] ${c.date} ${c.trip.kind} ${c.trip.mode} ` +
        `${c.trip.boardTime ?? '--'}→${c.trip.alightTime ?? '--'} ${c.trip.line ?? ''} ${c.trip.boardPlace ?? ''}→${c.trip.alightPlace ?? ''} ` +
        `${c.trip.trainOrigin ?? ''}→${c.trip.trainDestination ?? ''}행 ${c.trip.car ?? '?'}-${c.trip.door ?? '?'} ${c.trip.side ?? '?'} ` +
        `#${c.trip.waitOrder ?? '?'} ${c.trip.initialSeat ?? '?'} ev=${c.seatEvents.map((e) => `${e.time ?? '?'}@${e.place ?? '?'}`).join('|')} ` +
        `crowd=${c.trip.crowding ?? '?'} note=${JSON.stringify(c.trip.note)} issues=${JSON.stringify(c.issues)}`,
    )
  }
  lines.push('', '--- 해석하지 못한 줄 ---')
  for (const u of parsed.unattached) lines.push(`${u.date ?? '-'} ${u.text}`)
  await writeFile(dump, lines.join('\n'), 'utf8')
  console.log('상세 보고서:', dump)
}

const out = opt('--out')
if (out) {
  await mkdir(dirname(out), { recursive: true })
  const backup = candidatesToBackup(parsed, { onlyConfirmed: args.includes('--confirmed-only') })
  await writeFile(out, JSON.stringify(backup), 'utf8')
  console.log('백업 JSON:', out, `(기록 ${backup.data.trips.length}건)`)
}
