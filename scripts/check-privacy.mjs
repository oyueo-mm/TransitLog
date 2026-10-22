// 공개 전 개인정보 검사.  node scripts/check-privacy.mjs [--history] [--dist]
//
//  1) 추적 중인 파일에 개인 데이터 파일(PDF·백업·이관 JSON·private/)이 있으면 실패
//  2) dist/ 산출물에 PDF·백업·이관 파일이 있으면 실패
//  3) private/denylist.txt (로컬에만 있는 실제 장소·메모 목록)가 있으면, 작업 트리·(--history) 전체 Git 이력·(--dist) 산출물에서
//     그 문자열이 발견되는 경우 실패. 일치한 항목은 앞부분만 표시하고 주변 문맥은 출력하지 않는다.
//  CI 에는 denylist 가 없으므로 1)·2)만 수행한다 (개인 데이터가 저장소에 없어야 하기 때문).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 })
const failures = []

const FORBIDDEN_PATH = [
  /(^|\/)private\//i,
  /\.pdf$/i,
  /\.sdocx?$/i,
  /transitlog-backup[^/]*\.json$/i,
  /transitlog-before-restore[^/]*\.json$/i,
  /transitlog-import[^/]*\.json$/i,
  /transitlog-trips[^/]*\.csv$/i,
  /denylist/i,
  /\.bundle$/i,
]
const isForbidden = (p) => FORBIDDEN_PATH.some((re) => re.test(p))

// 1) 추적 파일
for (const f of git('ls-files').split('\n').filter(Boolean)) {
  if (isForbidden(f)) failures.push(`추적 중인 개인 데이터 파일: ${f}`)
}
// 이력 속 파일 경로
if (args.has('--history')) {
  for (const f of new Set(git('log', '--all', '--name-only', '--pretty=format:').split('\n').filter(Boolean))) {
    if (isForbidden(f)) failures.push(`Git 이력에 남아 있는 개인 데이터 파일: ${f}`)
  }
}

// 2) dist 경로
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}
const distFiles = args.has('--dist') && existsSync('dist') ? walk('dist') : []
for (const f of distFiles) if (isForbidden(f.replace(/\\/g, '/'))) failures.push(`배포 산출물에 개인 데이터 파일: ${f}`)

// 3) 로컬 denylist (실제 장소·메모)
const denyPath = 'private/denylist.txt'
let denyCount = 0
if (existsSync(denyPath)) {
  const deny = readFileSync(denyPath, 'utf8').split('\n').filter(Boolean)
  denyCount = deny.length
  // 한글이 없는 항목(버스 번호 등 숫자형)은 서드파티 번들(pdf.js 등)에 우연히 들어 있을 수 있어 그 번들에서는 대조하지 않는다.
  // 한글이 있는 항목(역 이름·메모)은 모든 파일에서 대조한다.
  const HANGUL = /[가-힣]/
  const VENDOR = /pdf\.worker|pdfClient-|workbox-/
  const label = (d) => (d.length > 16 ? `${d.slice(0, 6)}…(${d.length}자 메모)` : d)
  const scan = (where, text, vendor = false) => {
    for (const d of deny) {
      if (vendor && !HANGUL.test(d)) continue
      if (text.includes(d)) failures.push(`${where}: 금지 항목 '${label(d)}' 발견`)
    }
  }
  const BIN = /\.(png|ico|woff2?|jpg|webp)$/i
  for (const f of git('ls-files').split('\n').filter(Boolean)) {
    if (BIN.test(f) || f === 'package-lock.json' || !existsSync(f)) continue
    scan(`작업 트리 ${f}`, readFileSync(f, 'utf8'))
  }
  if (args.has('--history')) {
    for (const rev of git('rev-list', '--all').trim().split('\n')) {
      for (const f of git('ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean)) {
        if (BIN.test(f) || f === 'package-lock.json') continue
        scan(`이력 ${rev.slice(0, 7)}:${f}`, git('show', `${rev}:${f}`))
      }
    }
    // 커밋 메시지·작성자
    scan('커밋 메시지', git('log', '--all', '--pretty=%an %ae %s%n%b'))
  }
  for (const f of distFiles) {
    if (BIN.test(f)) continue
    scan(`dist ${f.replace(/\\/g, '/')}`, readFileSync(f, 'utf8'), VENDOR.test(f))
  }
}

if (failures.length) {
  console.error('✗ 개인정보 검사 실패')
  for (const f of [...new Set(failures)]) console.error('  - ' + f)
  process.exit(1)
}
console.log(
  `✓ 개인정보 검사 통과 (경로 검사${args.has('--history') ? ' + 이력' : ''}${args.has('--dist') ? ' + dist' : ''}${denyCount ? `, 로컬 금지 목록 ${denyCount}개 대조` : ', 로컬 금지 목록 없음(CI)'})`,
)
