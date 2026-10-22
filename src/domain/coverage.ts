import type { RideRow } from './stats'

/**
 * 착석 지표의 '판정 가능 표본' 집계.
 * 각 지표의 분모는 서로 다르다. 이 모듈은 전체 탑승 중 몇 건이 판정되었고 몇 건이 왜 빠졌는지를 센다.
 * 제외된 기록을 '서서 감'이나 '앉아서 감' 어느 쪽으로도 추정하지 않는다.
 */

/** 비율을 해석할 만한 값으로 보기 위한 최소 표본 수 */
export const MIN_SAMPLE = 10
/** 전체 탑승 중 이 비율보다 적게 판정되면 '일부만 판정'이라고 알린다 */
export const MIN_COVERAGE = 0.5

export interface SeatCoverage {
  total: number
  immediate: { known: number; unknown: number }
  ever: {
    /** 앉은 것이 확인됨 */
    seated: number
    /** 끝까지 서 있었음이 확인됨(좌석 변화 기록 완결) */
    stoodAll: number
    /** 서서 탔지만 이후 앉았는지 확인하지 않음 → 제외 */
    unconfirmedStanding: number
    /** 좌석 정보 자체가 없음 → 제외 */
    unknown: number
  }
  final: { known: number; unconfirmed: number }
}

export function seatCoverage(rows: RideRow[]): SeatCoverage {
  const c: SeatCoverage = {
    total: rows.length,
    immediate: { known: 0, unknown: 0 },
    ever: { seated: 0, stoodAll: 0, unconfirmedStanding: 0, unknown: 0 },
    final: { known: 0, unconfirmed: 0 },
  }
  for (const { trip, seat } of rows) {
    if (seat.immediate === null) c.immediate.unknown++
    else c.immediate.known++
    if (seat.everSeated === true) c.ever.seated++
    else if (seat.everSeated === false) c.ever.stoodAll++
    else if (trip.initialSeat === 'standing') c.ever.unconfirmedStanding++
    else c.ever.unknown++
    if (seat.final === null) c.final.unconfirmed++
    else c.final.known++
  }
  return c
}

export interface SampleNote {
  /** 분모가 MIN_SAMPLE 미만 → 비율을 해석하기 어렵다 */
  insufficient: boolean
  /** 전체 탑승 중 판정된 비율이 낮아, 전체 착석률로 읽으면 안 된다 */
  partial: boolean
  excluded: number
  coveragePct: number | null
}

export function sampleNote(den: number, total: number): SampleNote {
  const cov = total === 0 ? null : den / total
  return {
    insufficient: den > 0 && den < MIN_SAMPLE,
    partial: cov !== null && den > 0 && cov < MIN_COVERAGE,
    excluded: Math.max(0, total - den),
    coveragePct: cov === null ? null : Math.round(cov * 100),
  }
}
