import Dexie, { type EntityTable } from 'dexie'
import type { DayLog, RouteTemplate, SeatEvent, Setting, Trip } from '../domain/types'

/**
 * IndexedDB 저장소. 성격이 다른 데이터를 테이블로 분리한다.
 *  - trips       : 탑승·놓침·관찰 기록
 *  - seatEvents  : 한 번의 탑승 중 일어난 좌석 상태 변화
 *  - days        : 날짜별 일지 (집 출발·학교 도착·귀가 등 하루 단위 기록)
 *  - templates   : 자주 쓰는 경로 템플릿
 *  - settings    : 앱 설정·마지막 사용값·백업 시각
 *
 * 스키마를 바꿀 때는 version(n) 을 추가하고 upgrade() 에서 기존 데이터를 변환한다.
 * (기존 버전 정의는 지우지 않는다.)
 */
export class TransitDB extends Dexie {
  trips!: EntityTable<Trip, 'id'>
  seatEvents!: EntityTable<SeatEvent, 'id'>
  days!: EntityTable<DayLog, 'date'>
  templates!: EntityTable<RouteTemplate, 'id'>
  settings!: EntityTable<Setting, 'key'>

  constructor(name = 'TransitLog') {
    super(name)
    this.version(1).stores({
      trips: 'id, date, kind, mode, line, importKey, [date+boardTime]',
      seatEvents: 'id, tripId',
      days: 'date',
      templates: 'id, mode, lastUsedAt',
      settings: 'key',
    })
  }
}

export const db = new TransitDB()
