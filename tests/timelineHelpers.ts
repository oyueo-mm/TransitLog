import { summarizeSeat } from '../src/domain/seat'
import type { SeatEvent, Trip } from '../src/domain/types'

/** 기존 통계 함수가 계산한 서서 이동 시간 (타임라인 구간과 비교용) */
export const standingMinutesOf = (t: Trip, ev: SeatEvent[]) => summarizeSeat(t, ev).standingMinutes
