/**
 * 노트 문법 규칙. PDF 줄 이어 붙이기(pdfText)와 파서(parser)가 같은 정의를 쓴다.
 */
export const DATE_RE = /^(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})(?![\d:])\s*(?:([월화수목금토일])요일)?/
export const TIME_START = /^(\d{1,2}):(\d{2}|\?\?)/
// 시각 바로 뒤에 조사가 오면 본문 속 시각이지 기록의 머리줄이 아니다
export const PARTICLE_AFTER_TIME = /^[에이가은는도쯤경까부을를의엔]/
export const DAY_LEVEL = /^\(?\s*(\d{1,2}:\d{2})\s*(집에서|집|학교에서|학교)?\s*(출발|도착)\s*\)?\s*$/
export const HOME_ARRIVE = /^\(?\s*(\d{1,2}:\d{2})\s*귀가\s*\)?\s*$/

/** 기록 머리줄: 줄이 시각으로 시작하고(괄호로 시작하면 아님) 시각 뒤에 조사가 오지 않는 줄 */
export function isTripHeader(line: string): boolean {
  if (line.startsWith('(')) return false
  const m = TIME_START.exec(line)
  return !!m && !PARTICLE_AFTER_TIME.test(line.slice(m[0].length))
}

/** 칸-문·좌우·대기 순서·좌석 상태로 시작하는 상세 줄인가 */
export function looksLikeDetail(line: string): boolean {
  if (line.length > 120) return false
  if (/^(?:\?{1,2}|[\d?]{1,2}\s*-\s*[\d?]{1,2})/.test(line)) return true
  if (/^\(?\d{1,2}\s*[~?]\s*\d{1,2}\s*번째|^\?\?\s*번째|^\d{1,2}\s*번째|^(?:앞문|뒷문|중문|왼쪽|오른쪽)/.test(line)) return true
  if (/^(?:서서\s*감|서서감|앉아서\s*감|앉아서감|앉음|못\s*앉|몰라)/.test(line)) return true
  return false
}

/** 이 줄은 앞 줄의 연속이 될 수 없는, 새 항목의 시작인가 */
export function startsNewItem(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (DATE_RE.test(t) || DAY_LEVEL.test(t) || HOME_ARRIVE.test(t)) return true
  if (isTripHeader(t)) return true
  return looksLikeDetail(t)
}

export interface PhysicalLine {
  text: string
  /** 줄 끝이 본문 폭 끝에 닿아 있어 자동 줄바꿈된 것으로 보이는 줄 */
  full: boolean
}

/**
 * 자동 줄바꿈으로 갈라진 줄을 이어 붙인다. 날짜·머리줄·상세 줄처럼
 * 새 항목이 시작되는 줄은 앞 줄이 꽉 차 있어도 이어 붙이지 않는다.
 * (한글은 글자 중간에서도 줄이 바뀌므로 구분자 없이 붙인다.)
 */
export function joinWrapped(lines: PhysicalLine[]): string[] {
  const out: string[] = []
  let carry: string | null = null
  for (const l of lines) {
    let text = l.text
    if (carry !== null) {
      // 머리줄은 '->' 로 끝났거나 짧은 조각(행, 대행, >종착역행)일 때만 다음 줄이 이어진다
      const headerCannotContinue =
        isTripHeader(carry) && !(/(?:->|-|>|→)\s*$/.test(carry) || /^\S{1,10}$/.test(text))
      if (headerCannotContinue || startsNewItem(text)) {
        out.push(carry)
        carry = null
      } else {
        text = carry + text
        carry = null
      }
    }
    if (l.full && text.trim()) carry = text
    else out.push(text)
  }
  if (carry !== null) out.push(carry)
  return out
}
