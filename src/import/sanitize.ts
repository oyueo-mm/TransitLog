import type { Crowding } from '../domain/types'

/**
 * 비고 순화.
 *  - 욕설·감정 표현은 중립적인 문장으로 바꾸거나 제거
 *  - 교통과 무관한 개인 이야기는 제외
 *  - 다른 승객에 대한 신상·외모 묘사는 제거
 *  - 교통과 관련된 사실(지연·혼잡·좌석·대기)은 보존, 원문에 없는 정보는 만들지 않음
 * 규칙 기반이라 완벽하지 않으므로, 가져오기 미리보기에서 원문과 나란히 보여 주고 수정할 수 있게 한다.
 * 구조화(혼잡도 등)는 단순하고 한 가지로만 읽히는 문장에서만 수행해 오독을 피한다.
 */
export type DropReason = 'offtopic' | 'person' | 'abusive' | 'empty'

export interface SanitizeResult {
  /** 순화된 비고. 남길 내용이 없으면 null */
  text: string | null
  /** 제외된 조각과 사유 (미리보기에서 보여 줌) */
  dropped: Array<{ text: string; reason: DropReason }>
  crowding: Crowding | null
  incident: string | null
  delayMinutes: number | null
}

export const DROP_REASON_LABEL: Record<DropReason, string> = {
  offtopic: '교통과 무관한 내용',
  person: '다른 승객에 대한 묘사',
  abusive: '욕설·비하 표현',
  empty: '의미 없는 표현',
}

/** 단어 단위로 통째로 제거하는 욕설·감정 토큰 */
const DROP_TOKEN =
  /씨발|시발|시벌|시방|시잘|시ㅏ|시장|ㅅ발|ㅆ발|씨바|시바|ㅅㅂ|ㅆㅂ|ㅂㅅ|병신|좆|존나|조나|존내|졸라|ㅈㄴ|ㅈ됨|씹|새끼|지랄|미친|ㅁㅊ|개꿀|야르|샤갈|ㅂㄹ|ㅛ95ㅂ|ㅇㅌㅋ|ㅗ{2,}|ㅜ+|ㅠ+|ㅋ+|ㅎ{2,}|ㄷㄷ+|ㄲㅂ|^\^+$|^;+$|짜증|살려줘|토할|멀미|숨\s*차|한숨|승질|열받|빡치|^ㅇ+$/
const STANDALONE_INTENSIFIER = /^(?:개|존|졸|완전|진짜)$/
/** '개' 접두 강조어 (개많음 → 많음) */
const GAE_PREFIX = /^개(?=(?:많|빨|오래|느리|늦|붐|힘|짧|길|추|덥|혼잡|밀|막|불편|널널|없|적|빡))/

const ABUSIVE = /새끼|씹|죽어|죽었으면|뒤져|꺼져|꺼지|노인내|빌런|진상|꼰대|잼민|아재|할매|할줌마|할저씨|미친년|미친놈/
const PERSON =
  /아저씨|아줌마|아주머니|할아버지|할머니|할배|노인|어르신|여자|남자|여학생|남학생|학생|청각|시각장애|장애인|외국인|군인|커플|임산부(?!석)|아기|애기|중고딩|대딩|직장인|금발|흰머리|머리|바지|신발|티셔츠|면티|가디건|후드|바람막이|반지|안경|덩치|현장직|결혼|표정|패션/
const OFFTOPIC_STRONG = /시험|수업|휴강|과제|밥이|배고|졸려|피곤|서비스센터|쇼핑|개강/
const TRANSIT_STRONG = /열차|지하철|버스|환승|승강장|정차|지연|연착/
const TRANSIT =
  /열차|지하철|버스|역|정류|정거장|환승|승강장|지연|연착|정차|혼잡|좌석|자리|앉|서서|서있|서 있|문|칸|대기|급행|행|놓|막차|첫차|배차|출발|도착|탑승|하차|내림|내리|내려|타는|탔|탐|방송|고장|서행|점검|응급|줄|번째|노약자|임산부석|호선|엘리베이터|에스컬레이터|기둥|벽|앞쪽|뒤쪽|맨 앞|맨 뒤|시간대|사람|승객|뛰|빠지|빠짐|빠졌|몰|한산|널널|혼잡|초기화/
/** 문장이 한 가지 사실만 말하지 않는 표지 (이런 문장에서는 구조화하지 않는다) */
const CONTRAST =
  /줄\s*알았|알았는데|는데|인데|지만|으나|그러나|근데|그런데|하지만|\?|좋겠|였으면|았으면|었으면|텐데|갈\s*걸|걸\s*그랬|만약|대신/

interface Rule {
  re: RegExp
  whole: string | ((m: RegExpExecArray) => string)
  part: string | ((m: RegExpExecArray) => string)
  crowding?: Crowding
}

const RULES: Rule[] = [
  {
    re: /(\S+행)(?:이라(?:서)?|이어서)?\s*(?:개|ㅈㄴ|존나|졸라)?\s*널널\S*/,
    whole: (m) => `${m[1]} 열차로 여유 좌석이 많았음`,
    part: (m) => `${m[1]} 열차로 여유 좌석이 많았음`,
    crowding: 'free',
  },
  { re: /자리\s*(?:를\s*)?(?:뺏|빼앗)(?:김|겼|었|음)|처먹/, whole: '착석 경쟁이 치열했음', part: '착석 경쟁이 치열했음' },
  { re: /자리\s*경쟁\s*(?:이\s*)?(?:개|ㅈㄴ|존나|좀)?\s*치열\S*/, whole: '착석 경쟁이 치열했음', part: '착석 경쟁이 치열했음' },
  {
    re: /(?:추가\s*)?자리\S*\s*(?:개|ㅈㄴ|존나|졸라|좀|은근|완전|꽤)?\s*(?:널널|많)\S*/,
    whole: '여유 좌석이 많았음',
    part: '여유 좌석이 많았음',
  },
  {
    re: /(?:사람|승객|열차\s*안)\S*\s*(?:이|가|도)?\s*(?:개|ㅈㄴ|존나|졸라|엄청|너무)\s*많\S*|지옥철|미어터|발\s*디딜\s*틈/,
    whole: '승차 당시 매우 혼잡했음',
    part: '매우 혼잡했음',
    crowding: 'very_crowded',
  },
  {
    re: /(?:사람|승객)\S*\s*(?:이|가|도)?\s*(?:은근\s*)?많(?:음|았음|네|다|았다)/,
    whole: '승차 당시 혼잡했음',
    part: '혼잡했음',
    crowding: 'crowded',
  },
  {
    re: /(?:사람|승객)\S*\s*(?:이|가|도)?\s*(?:개|ㅈㄴ|존나|졸라)?\s*(?:적|없)(?:음|었음|네|다|었다)|한산|텅텅/,
    whole: '승차 당시 한산했음',
    part: '한산했음',
    crowding: 'free',
  },
]

/** 욕설·감정 토큰을 제거한 문장 */
function stripNoise(s: string): string {
  const toks = s
    .split(/\s+/)
    .filter((t) => t && !DROP_TOKEN.test(t) && !STANDALONE_INTENSIFIER.test(t))
    .map((t) => t.replace(GAE_PREFIX, ''))
  return toks
    .join(' ')
    .replace(/\?\./g, '?')
    .replace(/[!?]{2,}/g, '?')
    .replace(/\.{2,}|…+/g, '.')
    .replace(/^[\s,.+\-~>)]+|[\s,+\-~>(]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

interface ClauseResult {
  text: string | null
  reason?: DropReason
  crowding: Crowding | null
}

function neutralizeClause(orig: string): ClauseResult {
  const c = orig.trim()
  const seatFight = /자리\s*(?:를\s*)?(?:뺏|빼앗)|처먹|밀쳐서.*자리|먼저\s*앉/.test(c)

  if (PERSON.test(c) || ABUSIVE.test(c)) {
    // 좌석 경쟁이라는 교통 사실만 남기고 사람 묘사는 버린다
    if (seatFight) return { text: '착석 경쟁이 치열했음', crowding: null }
    return { text: null, reason: ABUSIVE.test(c) ? 'abusive' : 'person', crowding: null }
  }
  if (OFFTOPIC_STRONG.test(c) && !TRANSIT_STRONG.test(c)) return { text: null, reason: 'offtopic', crowding: null }

  const stripped = stripNoise(c)
  if (stripped.length < 2 || !/[가-힣A-Za-z0-9]/.test(stripped)) return { text: null, reason: 'empty', crowding: null }

  const simple = !CONTRAST.test(c)
  if (simple) {
    for (const r of RULES) {
      const m = r.re.exec(c)
      if (!m) continue
      const covers = m[0].length / Math.max(1, c.replace(/\s+/g, ' ').length) >= 0.55
      const phrase = (covers ? r.whole : r.part) as string | ((x: RegExpExecArray) => string)
      const to = typeof phrase === 'function' ? phrase(m) : phrase
      const text = covers ? to : stripNoise(c.slice(0, m.index) + to + c.slice(m.index + m[0].length))
      return { text, crowding: r.crowding ?? null }
    }
  }
  if (!TRANSIT.test(stripped)) return { text: null, reason: 'offtopic', crowding: null }
  return { text: stripped, crowding: null }
}

/** 한 비고 덩어리를 문장 단위로 쪼갠다 (노트는 문장부호 없이 이어 쓰는 경우가 많다) */
export function splitClauses(raw: string): string[] {
  return raw
    .split(/\n+/)
    .flatMap((line) =>
      line.split(/(?<=[.?!])\s+|\s{2,}|(?<=[가-힣][음함임듯네다요])(?<!처음)(?<!다음)\s+(?=[가-힣(+])|\s+(?:근데|그런데|그리고|그러나|하지만)\s+/),
    )
    .map((x) => x.trim())
    .filter(Boolean)
}

export function sanitizeNote(raw: string | null | undefined, ctx: { trainDestination?: string | null } = {}): SanitizeResult {
  const out: SanitizeResult = { text: null, dropped: [], crowding: null, incident: null, delayMinutes: null }
  if (!raw || !raw.trim()) return out
  const clauses = splitClauses(raw)
  const kept: string[] = []
  const crowdSet = new Set<Crowding>()
  let personDrops = 0

  for (const clause of clauses) {
    const r = neutralizeClause(clause)
    if (r.crowding) crowdSet.add(r.crowding)
    if (r.text) kept.push(r.text)
    else {
      out.dropped.push({ text: clause, reason: r.reason ?? 'empty' })
      if (r.reason === 'person' || r.reason === 'abusive') personDrops++
    }

    // 지연 분 (다른 행선지의 열차 이야기는 이 탑승의 지연으로 보지 않는다)
    const delay = /(\d{1,3})\s*분\s*(?:정도\s*)?(?:지연|연착|늦)/.exec(clause)
    if (delay) {
      const other = /(\S+?)행/.exec(clause)
      const dest = ctx.trainDestination?.replace(/\s*방향$/, '') ?? null
      if (!other || (dest && (dest.includes(other[1]) || other[1].includes(dest)))) {
        out.delayMinutes = out.delayMinutes ?? Number(delay[1])
      }
    }
    if (/열차\s*지연|지연\s*(?:됨|돼서|되어|으로)|연착/.test(clause) && !/\S+행이\s*\d+분\s*지연/.test(clause)) {
      out.incident = out.incident ?? '열차 지연'
    }
    if (/응급\s*환자/.test(clause)) out.incident = out.incident ?? '차내 응급환자 발생으로 정차'
    if (/안전\s*점검/.test(clause)) out.incident = out.incident ?? '안전 점검으로 출발 지연'
  }

  // 다른 승객 묘사가 대부분인 덩어리는 통째로 제외한다 (일부만 남으면 오히려 왜곡)
  if (personDrops >= 3) {
    out.dropped.push(...kept.map((t) => ({ text: t, reason: 'person' as DropReason })))
    kept.length = 0
  }

  // 혼잡도는 한 가지로만 읽힐 때만 구조화 (서로 엇갈리면 비워 둔다)
  if (crowdSet.size === 1) out.crowding = [...crowdSet][0]

  const uniq = kept.filter((t, i) => kept.indexOf(t) === i)
  out.text = uniq.length ? uniq.join('. ') : null
  return out
}
