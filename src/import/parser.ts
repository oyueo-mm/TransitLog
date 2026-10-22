import { diffMinutes, normalizeHm, weekdayKo, isValidDate, pad2 } from '../domain/time'
import {
  emptyTripDraft,
  type DayLog,
  type Mode,
  type NaKey,
  type SeatEventDraft,
  type TripDraft,
} from '../domain/types'
import { tripFingerprint } from '../db/repo'
import { sanitizeNote, type DropReason } from './sanitize'
import { DATE_RE, DAY_LEVEL, HOME_ARRIVE, TIME_START, isTripHeader, looksLikeDetail } from './syntax'

/**
 * Samsung Notes 에서 내보낸 텍스트를 이동 기록 후보로 변환한다.
 *
 * 원칙
 *  - 원문에 없는 값은 만들지 않는다 (`??`·`?`·'기억 안 남' 은 null=미기록으로 둔다).
 *  - 불확실한 서술('~듯', 범위 '3~4번째' 등)은 값으로 확정하지 않고 비고/검토 사유로 남긴다.
 *  - 탑승 근거가 없는 항목은 '관찰만'으로 분류하고 검토 대상으로 표시한다.
 *  - 자동으로 분류하지 못한 줄도 버리지 않고 '해석하지 못한 줄'로 보여 준다.
 */

export interface ImportCandidate {
  id: string
  date: string
  /** 원문(이어 붙인 줄바꿈 기준). 미리보기에서 변환 결과와 비교하는 용도이며 저장하지 않는다 */
  raw: string
  trip: TripDraft
  seatEvents: SeatEventDraft[]
  /** 사용자 확인이 필요한 이유 */
  issues: string[]
  /** 알려진 정보 누락 항목 (미기록으로 유지됨) */
  missing: string[]
  /** 원문에 ?? 같은 불명 표기가 있었던 횟수 */
  unknownMarks: number
  dropped: Array<{ text: string; reason: DropReason }>
  status: 'confirmed' | 'review'
  duplicate: 'none' | 'existing' | 'in-file'
  selected: boolean
}

export interface ImportDay {
  date: string
  patch: Partial<Pick<DayLog, 'homeDepart' | 'schoolDepart' | 'schoolArrive' | 'homeArrive'>>
  raw: string[]
}

export interface Unattached {
  date: string | null
  text: string
}

export interface ParseResult {
  candidates: ImportCandidate[]
  days: ImportDay[]
  unattached: Unattached[]
  dateCount: number
}

const DASHES = /[‐‑‒–—−⁃]/g
const JUNK = /[⁰-₟²³¹⅐-↏ ]/g

export function normalizeText(s: string): string {
  return s.replace(DASHES, '-').replace(JUNK, ' ')
}


const SEAT_STAND_TOKEN = /^(?:서서\s*감|서서감|서서\s*갔음|못\s*앉음?|못\s*앉았음)(?:\s+(.+))?$/
const SEAT_SIT_TOKEN = /^(?:앉음|앉았음|앉아서\s*감|앉아서감|앉아서\s*탈\s*수\s*있었음)(?:\s+(.+))?$/
const UNCERTAIN = /(?:갔을\s*듯|갈\s*듯|인\s*듯|같음|추정)/

interface Block {
  date: string
  header: string
  body: string[]
}

/** 괄호 안의 쉼표를 보호하며 쉼표로 나눈다 */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

const ARROW = /\s*(?:->|→|=>)\s*/
const isUnknown = (s: string) => /^\?+$/.test(s.trim())

function cleanPlace(s: string | undefined): string | null {
  if (!s) return null
  const v = s.replace(/^-+/, '').trim()
  return !v || isUnknown(v) ? null : v
}

export function parseNotes(text: string): ParseResult {
  const lines = normalizeText(text)
    .split('\n')
    .map((l) => l.replace(/\s+$/g, '').trim())

  const blocks: Block[] = []
  const days = new Map<string, ImportDay>()
  const unattached: Unattached[] = []
  const dateSet = new Set<string>()
  let curDate: string | null = null
  let cur: Block | null = null
  let tripsToday = 0

  const flush = () => {
    if (cur) blocks.push(cur)
    cur = null
  }
  const dayOf = (date: string): ImportDay => {
    let d = days.get(date)
    if (!d) days.set(date, (d = { date, patch: {}, raw: [] }))
    return d
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    const dm = DATE_RE.exec(line)
    if (dm) {
      const [y, m, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])]
      if (isValidDate(y, m, d)) {
        flush()
        curDate = `${y}-${pad2(m)}-${pad2(d)}`
        dateSet.add(curDate)
        tripsToday = 0
        const rest = line.slice(dm[0].length).trim()
        // 머리줄에 요일이 있는데 날짜와 맞지 않으면 알려 준다
        if (dm[4] && weekdayKo(curDate) !== dm[4]) {
          unattached.push({ date: curDate, text: `요일 불일치: 원문 ${dm[4]}요일, 달력상 ${weekdayKo(curDate)}요일` })
        }
        if (rest) unattached.push({ date: curDate, text: rest })
        continue
      }
    }

    if (!curDate) {
      unattached.push({ date: null, text: line })
      continue
    }

    const dl = DAY_LEVEL.exec(line)
    const hl = HOME_ARRIVE.exec(line)
    if (dl || hl) {
      flush()
      const day = dayOf(curDate)
      day.raw.push(line)
      const time = normalizeHm(dl ? dl[1] : hl![1])
      if (hl) day.patch.homeArrive = time
      else {
        const place = dl![2]?.startsWith('집') ? 'home' : dl![2]?.startsWith('학교') ? 'school' : null
        if (dl![3] === '출발') {
          if (place === 'home') day.patch.homeDepart = time
          else if (place === 'school') day.patch.schoolDepart = time
          else if (tripsToday === 0) day.patch.homeDepart = time // 첫 기록 앞의 '출발'은 집 출발로 본다
          else unattached.push({ date: curDate, text: line })
        } else {
          if (place === 'home') day.patch.homeArrive = time
          else if (place === 'school') day.patch.schoolArrive = time
          else unattached.push({ date: curDate, text: line })
        }
      }
      continue
    }

    if (isTripHeader(line)) {
      flush()
      cur = { date: curDate, header: line, body: [] }
      tripsToday++
      continue
    }

    if (cur) (cur as Block).body.push(line)
    else unattached.push({ date: curDate, text: line })
  }
  flush()

  const candidates = blocks.map((b, i) => parseBlock(b, i))

  // 파일 안 중복 표시
  const seen = new Set<string>()
  for (const c of candidates) {
    const fp = tripFingerprint(c.trip)
    if (seen.has(fp)) {
      c.duplicate = 'in-file'
      c.selected = false
    }
    seen.add(fp)
    c.trip.importKey = fp
  }

  return { candidates, days: [...days.values()], unattached, dateCount: dateSet.size }
}

interface HeaderInfo {
  boardTime: string | null
  alightTime: string | null
  timeUnknownHour: string | null
  segments: string[]
}

function parseHeaderTimes(header: string): HeaderInfo {
  let rest = header
  const t1 = TIME_START.exec(rest)!
  const boardTime = t1[2] === '??' ? null : normalizeHm(`${t1[1]}:${t1[2]}`)
  const timeUnknownHour = t1[2] === '??' ? t1[1].padStart(2, '0') : null
  rest = rest.slice(t1[0].length).replace(/^분/, '')
  let alightTime: string | null = null
  const t2 = /^\s*(?:->|→|~|-)\s*(,\s*)?(?:(\d{1,2}):(\d{2}|\?\?))?/.exec(rest)
  if (t2) {
    if (t2[2] && t2[3] !== '??') alightTime = normalizeHm(`${t2[2]}:${t2[3]}`)
    rest = rest.slice(t2[0].length)
  } else {
    const t3 = /^\s*~\s*(\d{1,2}):(\d{2})/.exec(rest)
    if (t3) {
      alightTime = normalizeHm(`${t3[1]}:${t3[2]}`)
      rest = rest.slice(t3[0].length)
    }
  }
  rest = rest.replace(/^\s*도착/, '')
  return { boardTime, alightTime, timeUnknownHour, segments: splitTop(rest.replace(/^[\s,]+/, '')).map((x) => x.replace(/[.\s]+$/g, '')).filter(Boolean) }
}

const EXPRESS = /\(?\s*급행\s*\)?/
const BUS_NO = /^(\d{1,4}(?:-\d{1,2})?[A-Za-z]?)\s*번?(?:\s*버스)?$/

function parseBlock(b: Block, index: number): ImportCandidate {
  const raw = [b.header, ...b.body].join('\n')
  const trip = emptyTripDraft(b.date, 'subway')
  trip.source = 'import'
  const issues: string[] = []
  const events: SeatEventDraft[] = []
  let unknownMarks = 0
  const noteParts: string[] = []
  const naSet = new Set<NaKey>()

  // ── 머리줄 ──
  // 시각만 한 줄에 있고 노선·구간이 다음 줄에 이어지는 형식 ('07:49' / '1호선, 가역->나역, …')
  let headerLine = b.header
  if (/^\d{1,2}:(?:\d{2}|\?\?)\s*$/.test(headerLine) && b.body.length && /호선|->|→|행\s*$|선\s*,/.test(b.body[0]) && !looksLikeDetail(b.body[0])) {
    headerLine += ' ' + b.body.shift()!
  }
  const h = parseHeaderTimes(headerLine)
  trip.boardTime = h.boardTime
  trip.alightTime = h.alightTime
  if (h.timeUnknownHour) {
    unknownMarks++
    noteParts.push(`승차 시각: ${h.timeUnknownHour}시대 (분 미상)`)
  }

  let busLine: string | null = null
  let sawBusWord = false
  let sawSubwaySignal = false
  const arrows: Array<{ from: string | null; to: string | null; raw: string; train: boolean }> = []

  for (const seg of h.segments) {
    if (isUnknown(seg)) {
      unknownMarks++
      continue
    }
    if (/^\d{1,2}호선$/.test(seg) || (/^[가-힣]{2,8}선$/.test(seg) && !/행$/.test(seg))) {
      trip.line = seg
      sawSubwaySignal = true
      continue
    }
    if (/버스/.test(seg) && BUS_NO.test(seg)) {
      busLine = BUS_NO.exec(seg)![1]
      sawBusWord = true
      continue
    }
    if (BUS_NO.test(seg)) {
      busLine = BUS_NO.exec(seg)![1]
      sawBusWord = true
      continue
    }
    if (ARROW.test(seg)) {
      const [l, r] = seg.split(ARROW)
      const train = /행\s*(?:\([^)]*\))?\s*$/.test(r ?? '') || EXPRESS.test(seg)
      if (EXPRESS.test(seg)) trip.service = 'express'
      arrows.push({ from: cleanPlace(l), to: cleanPlace(r?.replace(EXPRESS, '').replace(/행\s*$/, '')), raw: seg, train })
      continue
    }
    const dirDest = /^(.+?)행\s*방향$/.exec(seg)
    if (dirDest) {
      trip.trainDestination = dirDest[1].trim()
      sawSubwaySignal = true
      continue
    }
    const dir = /^(.+?)\s*방향$/.exec(seg)
    if (dir) {
      if (trip.trainDestination) noteParts.push(`${dir[1].trim()} 방향`)
      else trip.trainDestination = `${dir[1].trim()} 방향`
      sawSubwaySignal = true
      continue
    }
    const dest = /^(.+?)행\s*(?:\(([^)]*)\))?$/.exec(seg)
    if (dest) {
      if (trip.trainDestination?.endsWith('방향')) noteParts.push(trip.trainDestination)
      trip.trainDestination = dest[1].trim()
      if (dest[2] && /급행/.test(dest[2])) trip.service = 'express'
      sawSubwaySignal = true
      continue
    }
    if (/버스/.test(seg)) {
      sawBusWord = true
      continue
    }
    // 그 밖의 한 덩어리는 승차 장소로 본다
    if (!trip.boardPlace) trip.boardPlace = cleanPlace(seg)
    else noteParts.push(seg)
  }

  // 화살표 구간: 열차(출발지→행선지)와 승하차 장소를 구분
  const trainArrows = arrows.filter((a) => a.train)
  let stationArrows = arrows.filter((a) => !a.train)
  if (trainArrows.length === 0 && stationArrows.length >= 2) {
    trainArrows.push(stationArrows[1])
    stationArrows = [stationArrows[0]]
  } else if (trainArrows.length === 0 && stationArrows.length === 1) {
    const a = stationArrows[0]
    const looksStation = /역|환승센터|정거장|정류|승강장|사거리|아파트|대$/.test(`${a.from ?? ''}${a.to ?? ''}`)
    if (!looksStation && !busLine && !sawBusWord) {
      trainArrows.push(a)
      stationArrows = []
      issues.push('화살표 구간이 열차 출발지→행선지인지 승하차 장소인지 불분명합니다')
    }
  }
  if (trainArrows[0]) {
    trip.trainOrigin = trainArrows[0].from
    if (trainArrows[0].to) trip.trainDestination = trainArrows[0].to
    sawSubwaySignal = true
  }
  if (stationArrows[0]) {
    trip.boardPlace = stationArrows[0].from ?? trip.boardPlace
    trip.alightPlace = stationArrows[0].to
  }
  if (arrows.some((a) => a.raw.includes('??'))) unknownMarks++

  // ── 본문: 상세 줄(칸-문, 좌우, 대기 순서, 좌석)과 비고 ──
  const body = [...b.body]
  let detail = ''
  if (body.length && looksLikeDetail(body[0])) {
    detail = body.shift()!
    // 칸-문만 있는 줄 뒤에 좌석 서술이 이어지는 경우 ('8-1 1열' / '앉음, …')
    if (body.length && /^(?:앉음|앉았|앉아서|못\s*앉|서서)/.test(body[0])) detail += ', ' + body.shift()!
  }
  let hasDetail = false
  let carDoorRoute: string | null = null
  let seatUncertain = false

  if (detail) {
    hasDetail = true
    let d = detail

    // 서서 감 -> (역에서) 앉음 (시각[, 역])
    const chg =
      /서서\s*감\s*(?:->|→)\s*(?:([가-힣A-Za-z0-9]+역)\s*에서\s*)?앉(?:음|아서\s*감|았음)?(?:\s*\(\s*(\d{1,2}:\d{2})\s*(?:,\s*([가-힣A-Za-z0-9]+))?\s*\))?/.exec(d)
    if (chg) {
      trip.initialSeat = 'standing'
      events.push({ time: normalizeHm(chg[2]), state: 'seated', place: chg[1] ?? chg[3] ?? null })
      d = d.replace(chg[0], ', ')
    }
    // ○○역에서 앉음 / 그러나 곧 앉아서 감
    const later = /([가-힣A-Za-z0-9]+역)\s*에서\s*앉(?:음|았음|아서\s*감)/.exec(d)
    if (later && !chg) {
      events.push({ time: null, state: 'seated', place: later[1] })
      d = d.replace(later[0], ', ')
    }
    const soon = /그러나\s*곧\s*앉(?:아서\s*감|음)/.exec(d)
    if (soon && !chg && !later) {
      events.push({ time: null, state: 'seated', place: null })
      d = d.replace(soon[0], ', ')
    }
    // 시각 하차
    const al = /(\d{1,2}:\d{2})\s*하차/.exec(d)
    if (al) {
      trip.alightTime = trip.alightTime ?? normalizeHm(al[1])
      d = d.replace(al[0], ', ')
    }

    // 괄호 안 보충 설명은 비고로
    d = d.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
      if (inner.trim()) noteParts.push(inner.trim())
      return ' '
    })

    const tokens = splitTop(d).flatMap((t) => t.split(/\.\s+/))
    for (const rawTok of tokens) {
      let tok = rawTok.replace(/[ㅗㅜㅠㅋ.\s^]+$/g, '').trim()
      if (!tok) continue

      // 8-1 1열 / 7-1번
      const cd = /^(\?{1,2}|\d{1,2})\s*-\s*(\?{1,2}|\d{1,2})\s*번?(.*)$/.exec(tok)
      if (cd) {
        const car = /^\d+$/.test(cd[1]) ? Number(cd[1]) : null
        const door = /^\d+$/.test(cd[2]) ? Number(cd[2]) : null
        if (!/^\d+$/.test(cd[1]) || !/^\d+$/.test(cd[2])) unknownMarks++
        if (car !== null && car > 12) carDoorRoute = `${cd[1]}-${cd[2]}`
        else {
          trip.car = car
          trip.door = door
        }
        tok = cd[3].trim().replace(/^,/, '')
        if (!tok) continue
      }
      if (isUnknown(tok)) {
        unknownMarks++
        continue
      }
      if (/^몰라/.test(tok)) {
        unknownMarks++
        tok = tok.replace(/^몰라\s*(?:아무튼)?\s*/, '').trim()
        if (tok) noteParts.push(tok)
        continue
      }
      const col = /^(\d{1,2})\s*열$/.exec(tok)
      if (col) {
        trip.waitOrder = Number(col[1])
        continue
      }
      let m: RegExpExecArray | null
      if (/양방향|좌우\s*구분|구분\s*없|왼쪽\s*오른쪽|오른쪽\s*왼쪽/.test(tok)) trip.side = 'both'
      else if (/^방향\s*X$/i.test(tok)) naSet.add('side')
      else if ((m = /^왼쪽에서\s*\d+\s*번째$/.exec(tok))) {
        trip.side = 'left'
        noteParts.push(`탑승 위치: ${m[0]}`)
      } else if ((m = /^(왼쪽|좌측|오른쪽|우측)\s*(.*)$/.exec(tok))) {
        trip.side = m[1] === '왼쪽' || m[1] === '좌측' ? 'left' : 'right'
        if (m[2]) noteParts.push(m[2])
      } else if (/^앞문$/.test(tok)) trip.busDoor = 'front'
      else if (/^뒷문$/.test(tok)) trip.busDoor = 'rear'
      else if (/^중문$/.test(tok)) trip.busDoor = 'middle'
      else if (/^(\d{1,2})\s*번째$/.test(tok)) trip.waitOrder = Number(/^(\d{1,2})/.exec(tok)![1])
      else if (/^[\d?N]{1,2}\s*[~?]\s*[\d?]{1,2}\s*번째/.test(tok) || /^\?+\s*번째/.test(tok) || /^N\s*번째/.test(tok)) {
        unknownMarks++
        const range = /^(\d{1,2})\s*[~?]\s*(\d{1,2})\s*번째/.exec(tok)
        if (range) noteParts.push(`대기 순서: ${range[1]}~${range[2]}번째로 기록됨(정확한 순서 미확인)`)
      } else if ((m = SEAT_STAND_TOKEN.exec(tok))) {
        if (trip.initialSeat === null) trip.initialSeat = 'standing'
        if (m[1]) noteParts.push(m[1])
      } else if ((m = SEAT_SIT_TOKEN.exec(tok))) {
        if (trip.initialSeat === null) trip.initialSeat = 'seated'
        if (m[1]) noteParts.push(m[1])
      } else if (UNCERTAIN.test(tok) && /서서|앉/.test(tok)) {
        seatUncertain = true
        noteParts.push(tok)
      } else {
        // 알 수 없는 조각은 비고 후보로 (순화 단계에서 정리됨)
        noteParts.push(tok)
      }
    }
  } else if (body.length) {
    // 상세 줄 형식이 아니어도, 첫 줄의 쉼표 구분 조각이 좌석 서술이면 좌석으로 읽는다 ('…, 앉아서 감')
    const toks = splitTop(body[0])
    const idx = toks.findIndex((t) => SEAT_SIT_TOKEN.test(t.replace(/[ㅗㅜㅠㅋ.\s^]+$/g, '')) || SEAT_STAND_TOKEN.test(t.replace(/[ㅗㅜㅠㅋ.\s^]+$/g, '')))
    if (idx >= 0) {
      const t = toks[idx].replace(/[ㅗㅜㅠㅋ.\s^]+$/g, '')
      trip.initialSeat = SEAT_SIT_TOKEN.test(t) ? 'seated' : 'standing'
      hasDetail = true
      toks.splice(idx, 1)
      body[0] = toks.join(', ')
    }
  }

  // 아직 좌석이 정해지지 않았고 '(~)' 형태의 단순 서술도 없으면 미기록
  if (seatUncertain && trip.initialSeat === null) issues.push("좌석 상태가 '~듯' 같은 추정으로만 적혀 있어 미기록으로 두었습니다")

  // ── 교통수단 ──
  const mode: Mode =
    busLine || sawBusWord || carDoorRoute ? 'bus' : 'subway'
  trip.mode = mode
  if (mode === 'bus') {
    trip.line = busLine ?? carDoorRoute
    trip.trainOrigin = null
    trip.trainDestination = null
    trip.service = null
    trip.car = null
    trip.door = null
    trip.side = null
    naSet.clear()
  } else {
    trip.busDoor = null
    if (!sawSubwaySignal && trip.car === null && !hasDetail) issues.push('교통수단(지하철/버스)을 원문에서 확인하기 어렵습니다')
  }

  // ── 비고 + 순화 ──
  const noteText = [...noteParts, ...body].join('\n')
  const bodyJoined = body.join(' ')
  const san = sanitizeNote(noteText, { trainDestination: trip.trainDestination })
  trip.note = san.text
  trip.crowding = san.crowding
  trip.incident = san.incident
  trip.delayMinutes = san.delayMinutes

  // 좌석 변화 시각·역 보강 (비고 속 근거로만, 추정하지 않음)
  for (const ev of events) enrichSeatEvent(ev, bodyJoined)

  if (/기억\s*안\s*남|기억이\s*안/.test(bodyJoined)) {
    unknownMarks++
  }

  // ── 종류 판정 ──
  const rideEvidence =
    trip.initialSeat !== null ||
    events.length > 0 ||
    trip.car !== null ||
    trip.door !== null ||
    trip.side !== null ||
    trip.waitOrder !== null ||
    trip.alightTime !== null ||
    /기억\s*안\s*남/.test(bodyJoined) ||
    (hasDetail && (seatUncertain || carDoorRoute !== null || trip.busDoor !== null))

  if (!rideEvidence) {
    const first = body.slice(0, 2).join(' ')
    if (/못\s*탐|못\s*탔|탑승\s*실패|놓쳤|놓침|놓쳐/.test(first)) {
      trip.kind = 'missed'
      issues.push(/놓쳤|놓침|놓쳐/.test(first) ? '놓친 열차로 분류했습니다 — 원문 표현을 확인해 주세요' : '')
    } else if (/탈\s*수\s*있었으면|못\s*타/.test(first)) {
      trip.kind = 'missed'
      issues.push('탑승하지 못한 기록으로 분류했습니다 — 원문 표현을 확인해 주세요')
    } else {
      trip.kind = 'observed'
      issues.push("원문에 탑승 근거(좌석·탑승 위치·하차)가 없어 '관찰만'으로 분류했습니다. 실제로 탑승했다면 구분을 바꿔 주세요")
    }
  }

  trip.naFields = [...naSet]
  const cleanIssues = issues.filter(Boolean)
  if (UNCERTAIN.test(bodyJoined) && /서서|앉/.test(bodyJoined) && trip.kind === 'ride' && trip.initialSeat === null) {
    cleanIssues.push('좌석 상태가 비고에만 추정 형태로 적혀 있습니다')
  }
  if (trip.kind === 'ride' && trip.initialSeat !== null && /못\s*탐|못\s*탔/.test(body.slice(0, 2).join(' '))) {
    cleanIssues.push("'탑승' 기록인데 비고에 '못 탐' 표현이 있습니다")
  }

  const missing = missingFields(trip, naSet)

  return {
    id: `c${index}`,
    date: b.date,
    raw,
    trip,
    seatEvents: events,
    issues: cleanIssues,
    missing,
    unknownMarks,
    dropped: san.dropped,
    status: cleanIssues.length ? 'review' : 'confirmed',
    duplicate: 'none',
    selected: true,
  }
}

/** 비고에 적힌 같은 시각(±2분)의 '○○역' 언급으로 좌석 변화 장소를 채운다. 근거가 없으면 비워 둔다 */
function enrichSeatEvent(ev: SeatEventDraft, text: string): void {
  const near = (a: string | null, b: string | null) => {
    const d1 = diffMinutes(a, b)
    const d2 = diffMinutes(b, a)
    return d1 !== null && d2 !== null && Math.min(d1, d2) <= 2
  }
  if (ev.time) {
    if (ev.place) return
    const pats = [
      /([가-힣A-Za-z0-9]+역)\s*(?:에서|에선|에)?\s*\(\s*(\d{1,2}:\d{2})\s*\)/g,
      /([가-힣A-Za-z0-9]+역)\s*(?:에서|에선|에)\s*[^.\n]*?앉[^.\n]*?\(\s*(\d{1,2}:\d{2})\s*\)/g,
    ]
    for (const re of pats) {
      for (const m of text.matchAll(re)) {
        if (near(ev.time, normalizeHm(m[2]))) {
          ev.place = m[1]
          return
        }
      }
    }
  } else if (ev.state === 'seated') {
    const m = /([가-힣A-Za-z0-9]+역)\s*(?:에서|에선)\s*[^.\n]*?앉[^.\n]*?[.\s]*\(?\s*(\d{1,2}:\d{2})\s*\)?/.exec(text)
    if (m) {
      if (!ev.place) ev.place = m[1]
      ev.time = normalizeHm(m[2])
    }
  }
}

function missingFields(trip: TripDraft, na: Set<NaKey>): string[] {
  if (trip.kind !== 'ride') return []
  const out: string[] = []
  const chk = (label: string, v: unknown, key?: NaKey) => {
    if (v === null && !(key && na.has(key))) out.push(label)
  }
  chk('노선', trip.line)
  chk('승차 장소', trip.boardPlace)
  chk('하차 장소', trip.alightPlace)
  chk('승차 시각', trip.boardTime)
  chk('하차 시각', trip.alightTime)
  if (trip.mode === 'subway') {
    chk('행선지', trip.trainDestination, 'trainDestination')
    chk('칸', trip.car, 'car')
    chk('문', trip.door, 'door')
    chk('좌우', trip.side, 'side')
  }
  chk('대기 순서', trip.waitOrder, 'waitOrder')
  chk('탑승 시 좌석', trip.initialSeat)
  return out
}

// ── 미리보기에서 사용자가 명시적으로 적용하는 일괄 작업 ───────────────

/**
 * 좌석 서술이 한 가지뿐인 기록('서서감'/'앉아서감' 단독)을 '탑승 중 변화 없음'으로 확정한다.
 * 노트 작성 방식에 대한 가정이므로 자동으로 적용하지 않고, 사용자가 누를 때만 쓴다.
 */
export function applySeatComplete(candidates: ImportCandidate[]): number {
  let n = 0
  for (const c of candidates) {
    if (c.trip.kind === 'ride' && c.trip.initialSeat !== null && c.seatEvents.length === 0 && c.trip.seatLogComplete === null) {
      c.trip.seatLogComplete = true
      n++
    }
  }
  return n
}

/** 집 출발→학교 도착 / 학교 출발→귀가 사이에 승차한 기록의 등·하교 구분을 제안(적용) */
export function applyPurposeSuggestion(candidates: ImportCandidate[], days: ImportDay[]): number {
  const byDate = new Map(days.map((d) => [d.date, d.patch]))
  let n = 0
  for (const c of candidates) {
    const p = byDate.get(c.date)
    const t = c.trip.boardTime
    if (!p || !t || c.trip.purpose !== null || c.trip.kind !== 'ride') continue
    const within = (a: string | null | undefined, z: string | null | undefined) =>
      !!a && !!z && a <= z && t >= a && t <= z
    if (within(p.homeDepart, p.schoolArrive)) {
      c.trip.purpose = 'to_school'
      n++
    } else if (within(p.schoolDepart, p.homeArrive)) {
      c.trip.purpose = 'from_school'
      n++
    }
  }
  return n
}

