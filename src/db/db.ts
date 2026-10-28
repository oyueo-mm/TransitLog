import Dexie, { type EntityTable } from 'dexie'
import type { DayLog, RouteTemplate, SeatEvent, Setting, Trip } from '../domain/types'
import type { SyncBaseRow, SyncConflict, SyncMetaRow, SyncSnapshot } from '../sync/types'

/**
 * IndexedDB 저장소. 성격이 다른 데이터를 테이블로 분리한다.
 *  - trips       : 탑승·놓침·관찰 기록
 *  - seatEvents  : 한 번의 탑승 중 일어난 좌석 상태 변화
 *  - days        : 날짜별 일지 (집 출발·학교 도착·귀가 등 하루 단위 기록)
 *  - templates   : 자주 쓰는 경로 템플릿
 *  - settings    : 앱 설정·마지막 사용값·백업 시각
 *
 * 아래 4개는 Google Drive 동기화용 '이 기기 전용' 상태이며 백업 파일에 들어가지 않고 다른 기기와 공유하지 않는다.
 *  - syncMeta       : 연결 여부·자동 동기화·마지막 성공 시각·기기 식별자·연결한 계정
 *  - syncBase       : 마지막 동기화 때 양쪽이 합의한 기록 사본 (3-way 병합의 기준)
 *  - syncConflicts  : 자동으로 결정할 수 없어 사용자 확인을 기다리는 충돌 (밀려난 값을 보존)
 *  - syncSnapshots  : 동기화가 이 기기의 기록을 바꾸기 직전에 찍어 둔 복구용 사본 (최근 3개)
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
  syncMeta!: EntityTable<SyncMetaRow, 'key'>
  syncBase!: EntityTable<SyncBaseRow, 'k'>
  syncConflicts!: EntityTable<SyncConflict, 'id'>
  syncSnapshots!: EntityTable<SyncSnapshot, 'id'>

  constructor(name = 'TransitLog') {
    super(name)
    this.version(1).stores({
      trips: 'id, date, kind, mode, line, importKey, [date+boardTime]',
      seatEvents: 'id, tripId',
      days: 'date',
      templates: 'id, mode, lastUsedAt',
      settings: 'key',
    })
    // v2: 동기화 상태 테이블만 추가한다. 기존 테이블·데이터는 변환하지 않는다.
    this.version(2).stores({
      trips: 'id, date, kind, mode, line, importKey, [date+boardTime]',
      seatEvents: 'id, tripId',
      days: 'date',
      templates: 'id, mode, lastUsedAt',
      settings: 'key',
      syncMeta: 'key',
      syncBase: 'k',
      syncConflicts: 'id',
      syncSnapshots: 'id',
    })
  }
}

export const db = new TransitDB()
