import { describe, expect, it } from 'vitest'
import { applyPurposeSuggestion, applySeatComplete, parseNotes } from '../src/import/parser'
import { joinWrapped } from '../src/import/syntax'
import { sanitizeNote } from '../src/import/sanitize'

// 아래 문장은 모두 형식을 흉내 낸 가상의 예시이며 실제 개인 기록이 아니다.
const SAMPLE = `2026-03-02 월요일
(07:50 집에서 출발)
08:00 1호선, 가역->나역, 다->라행
3-2, 왼쪽, 1번째, 서서감->다역에서 앉음(08:10)
사람 ㅈㄴ 많음
08:05 마행
5-4, 오른쪽, ??, 앉아서감
09:10 7777번 버스, 사정류장
앞문, 2번째, 서서감
09:20 3호선
??-??, ??, ??, 서서감
10:00 바행
전방향 사람 많음, 다 서서 가는듯
10:30 7777
ㅈㄴ 널널함. 근데 못 탐 늦게 옴
(09:55 학교 도착)
2026-03-03 화요일
23:50->00:10, 2호선, 가역->나역, 다->라행
4-1, 오른쪽, 4?5번째, 서서감
08:30 아행
7-1, 오른쪽, 서서 갔을듯
`

describe('노트 파서 (가상 샘플)', () => {
  const r = parseNotes(SAMPLE)
  const by = (date: string, time: string) => r.candidates.find((c) => c.date === date && c.trip.boardTime === time)!

  it('날짜·기록 단위로 나눈다', () => {
    expect(r.candidates).toHaveLength(8)
    expect(r.dateCount).toBe(2)
  })

  it('노선·구간·열차 구간·칸-문·좌우·대기 순서·좌석 변화를 구조화', () => {
    const c = by('2026-03-02', '08:00')
    expect(c.trip.mode).toBe('subway')
    expect(c.trip.line).toBe('1호선')
    expect(c.trip.boardPlace).toBe('가역')
    expect(c.trip.alightPlace).toBe('나역')
    expect(c.trip.trainOrigin).toBe('다')
    expect(c.trip.trainDestination).toBe('라')
    expect([c.trip.car, c.trip.door, c.trip.side, c.trip.waitOrder]).toEqual([3, 2, 'left', 1])
    expect(c.trip.initialSeat).toBe('standing')
    expect(c.seatEvents).toEqual([{ time: '08:10', state: 'seated', place: '다역' }])
    expect(c.trip.kind).toBe('ride')
  })

  it('승차 시각만 있으면 하차 시각은 비워 둔다', () => {
    expect(by('2026-03-02', '08:00').trip.alightTime).toBeNull()
  })

  it('?? 는 값으로 채우지 않고 null(미기록)로 둔다', () => {
    const c = by('2026-03-02', '08:05')
    expect(c.trip.waitOrder).toBeNull()
    expect(c.trip.trainDestination).toBe('마')
    expect(c.trip.line).toBeNull()
    expect(c.unknownMarks).toBeGreaterThan(0)
    const d = by('2026-03-02', '09:20')
    expect([d.trip.car, d.trip.door, d.trip.side, d.trip.waitOrder]).toEqual([null, null, null, null])
    expect(d.trip.initialSeat).toBe('standing')
  })

  it('범위(4?5번째)나 추정(~듯)은 값으로 확정하지 않는다', () => {
    const c = by('2026-03-03', '23:50')
    expect(c.trip.waitOrder).toBeNull()
    expect(c.trip.note).toContain('4~5번째')
    const g = by('2026-03-03', '08:30')
    expect(g.trip.initialSeat).toBeNull()
    expect(g.status).toBe('review')
  })

  it('자정을 넘기는 시각 범위를 읽는다', () => {
    const c = by('2026-03-03', '23:50')
    expect(c.trip.alightTime).toBe('00:10')
  })

  it('버스는 지하철 전용 필드 없이 읽는다', () => {
    const b = by('2026-03-02', '09:10')
    expect(b.trip.mode).toBe('bus')
    expect(b.trip.line).toBe('7777')
    expect(b.trip.boardPlace).toBe('사정류장')
    expect(b.trip.busDoor).toBe('front')
    expect([b.trip.car, b.trip.door, b.trip.side, b.trip.trainDestination]).toEqual([null, null, null, null])
  })

  it('탑승 근거가 없으면 관찰만, 못 탐은 놓침으로 분리', () => {
    expect(by('2026-03-02', '10:00').trip.kind).toBe('observed')
    expect(by('2026-03-02', '10:30').trip.kind).toBe('missed')
    expect(by('2026-03-02', '10:00').status).toBe('review')
  })

  it('하루 단위 기록(집 출발·학교 도착)을 일지로 분리', () => {
    const day = r.days.find((d) => d.date === '2026-03-02')!
    expect(day.patch).toEqual({ homeDepart: '07:50', schoolArrive: '09:55' })
  })

  it('비고에서 혼잡도를 구조화하되 욕설은 남기지 않는다', () => {
    const c = by('2026-03-02', '08:00')
    expect(c.trip.crowding).toBe('very_crowded')
    expect(c.trip.note).not.toMatch(/ㅈㄴ/)
  })

  it('서서감만 적힌 기록은 자동으로 변화 없음으로 확정하지 않고, 사용자가 일괄 적용할 때만 확정', () => {
    const r2 = parseNotes(SAMPLE)
    const c = r2.candidates.find((x) => x.date === '2026-03-02' && x.trip.boardTime === '09:20')!
    expect(c.trip.seatLogComplete).toBeNull()
    const n = applySeatComplete(r2.candidates)
    expect(n).toBeGreaterThan(0)
    expect(c.trip.seatLogComplete).toBe(true)
    // 좌석 변화 이벤트가 있는 기록은 건드리지 않는다
    expect(r2.candidates.find((x) => x.trip.boardTime === '08:00')!.trip.seatLogComplete).toBeNull()
  })

  it('등·하교 구분은 사용자가 적용할 때만, 하루 기록 시각 범위 안의 탑승에만', () => {
    const r2 = parseNotes(SAMPLE)
    expect(r2.candidates.every((c) => c.trip.purpose === null)).toBe(true)
    applyPurposeSuggestion(r2.candidates, r2.days)
    expect(r2.candidates.find((x) => x.trip.boardTime === '08:00')!.trip.purpose).toBe('to_school')
    expect(r2.candidates.find((x) => x.date === '2026-03-03')!.trip.purpose).toBeNull()
  })

  it('같은 내용을 두 번 넣으면 파일 안 중복으로 표시', () => {
    const dup = parseNotes(SAMPLE + SAMPLE)
    expect(dup.candidates.filter((c) => c.duplicate === 'in-file').length).toBe(8)
  })
})

describe('줄 이어 붙이기', () => {
  it('꽉 찬 줄은 다음 줄과 이어 붙이되, 날짜·머리줄·상세 줄은 붙이지 않는다', () => {
    const lines = [
      { text: '08:00 1호선, 가역->나역, 다->라', full: true },
      { text: '행', full: false }, // 머리줄이 줄바꿈된 경우
      { text: '3-2, 왼쪽, 1번째, 서서감', full: false },
      { text: '비고 문장이 길어서 줄이 꽉 찬 상태로 끝나', full: true },
      { text: '서 다음 줄로 이어짐', full: false },
      { text: '꽉 찬 마지막 비고 문장 끝', full: true },
      { text: '2026-03-04 수요일', full: false }, // 새 날짜는 붙지 않음
    ]
    expect(joinWrapped(lines)).toEqual([
      '08:00 1호선, 가역->나역, 다->라행',
      '3-2, 왼쪽, 1번째, 서서감',
      '비고 문장이 길어서 줄이 꽉 찬 상태로 끝나서 다음 줄로 이어짐',
      '꽉 찬 마지막 비고 문장 끝',
      '2026-03-04 수요일',
    ])
  })
  it('머리줄이 꽉 차 있어도 설명 문장은 붙이지 않는다', () => {
    const lines = [
      { text: '08:00 1호선, 가역->나역, 다->라행', full: true },
      { text: '원래 늦는 열차라 천천히 갔는데', full: false },
    ]
    expect(joinWrapped(lines)).toHaveLength(2)
  })
})

describe('비고 순화', () => {
  it('요구된 변환 예시', () => {
    expect(sanitizeNote('사람 개많음').text).toBe('승차 당시 매우 혼잡했음')
    expect(sanitizeNote('자리 뺏김').text).toBe('착석 경쟁이 치열했음')
    expect(sanitizeNote('가나행이라 개널널함').text).toBe('가나행 열차로 여유 좌석이 많았음')
  })
  it('욕설만 있는 문장은 제거', () => {
    expect(sanitizeNote('ㅅㅂ ㅈㄴ').text).toBeNull()
  })
  it('다른 승객의 외모·신상 묘사는 제거하고 교통 사실은 보존', () => {
    const r = sanitizeNote('금발에 흰 신발을 신은 남자를 봄\n열차 지연으로 5분 늦게 옴')
    expect(r.text).toBe('열차 지연으로 5분 늦게 옴')
    expect(r.dropped.some((d) => d.reason === 'person')).toBe(true)
    expect(r.delayMinutes).toBe(5)
    expect(r.incident).toBe('열차 지연')
  })
  it('교통과 무관한 일상 이야기는 제외', () => {
    const r = sanitizeNote('오늘 과제 때문에 피곤함. 승강장이 8번에서 9번으로 바뀜')
    expect(r.text).toBe('승강장이 8번에서 9번으로 바뀜')
  })
  it('서로 엇갈리는 혼잡도 표현은 구조화하지 않는다', () => {
    expect(sanitizeNote('사람 적을 줄 알았는데 사람 많음').crowding).toBeNull()
  })
  it('원문에 없는 정보를 만들어내지 않는다', () => {
    expect(sanitizeNote('몇 칸 앞이 더 좋을듯').text).toBe('몇 칸 앞이 더 좋을듯')
  })
})
