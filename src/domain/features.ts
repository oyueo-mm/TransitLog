import { hourBucket, parseHm, weekdayIndex } from './time'
import type { RideRow } from './stats'

/**
 * 착석 가능성 예측 기능을 위한 확장 지점.
 * 지금은 단순 통계만 제공하지만, 나중에 모델을 붙일 때 이 평면 레코드를 그대로
 * 학습/조회 입력으로 쓸 수 있도록 특징(feature)과 라벨(label)을 분리해 둔다.
 * 값이 없는 항목은 null 로 남기며, 라벨이 null 인 행은 학습에서 제외한다.
 */
export interface SeatFeatures {
  weekday: number
  hourBucket: string | null
  minuteOfDay: number | null
  mode: 'subway' | 'bus'
  line: string | null
  boardPlace: string | null
  trainDestination: string | null
  service: string | null
  car: number | null
  door: number | null
  side: string | null
  waitOrder: number | null
  crowding: string | null
}
export interface SeatLabeledRow {
  tripId: string
  features: SeatFeatures
  /** 탑승 시점에 앉았는가 */
  labelImmediate: boolean | null
  /** 한 번이라도 앉았는가 */
  labelEverSeated: boolean | null
}

export function toSeatDataset(rows: RideRow[]): SeatLabeledRow[] {
  return rows.map(({ trip, seat }) => ({
    tripId: trip.id,
    features: {
      weekday: weekdayIndex(trip.date),
      hourBucket: hourBucket(trip.boardTime),
      minuteOfDay: parseHm(trip.boardTime),
      mode: trip.mode,
      line: trip.line,
      boardPlace: trip.boardPlace,
      trainDestination: trip.trainDestination,
      service: trip.service,
      car: trip.car,
      door: trip.door,
      side: trip.side,
      waitOrder: trip.waitOrder,
      crowding: trip.crowding,
    },
    labelImmediate: seat.immediate,
    labelEverSeated: seat.everSeated,
  }))
}
