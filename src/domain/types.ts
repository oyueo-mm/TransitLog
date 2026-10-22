/**
 * 도메인 타입.
 *
 * 누락값 규칙
 *  - `null` = 미기록 (알 수 없음). 어떤 값으로도 추정해 채우지 않는다.
 *  - `naFields` 에 키가 들어 있고 값이 null 이면 = 해당 없음 (애초에 적용되지 않는 항목).
 *  - 통계는 null 값을 표본에서 제외한다.
 */

export type Mode = 'subway' | 'bus'
/** ride=실제 탑승, missed=놓침·탑승 실패, observed=관찰만 */
export type RecordKind = 'ride' | 'missed' | 'observed'
export type Purpose = 'to_school' | 'from_school' | 'other'
export type SeatState = 'standing' | 'seated'
export type Crowding = 'free' | 'normal' | 'crowded' | 'very_crowded'
/** both = 양방향(좌우 구분 없음), unknown = 기록자가 '미상'으로 명시 */
export type Side = 'left' | 'right' | 'both' | 'unknown'
export type BusDoor = 'front' | 'middle' | 'rear'
export type Service = 'normal' | 'express' | 'other'

/** '해당 없음'으로 표시할 수 있는 필드 */
export type NaKey =
  | 'trainOrigin'
  | 'trainDestination'
  | 'service'
  | 'car'
  | 'door'
  | 'side'
  | 'waitOrder'
  | 'busDoor'

export interface Trip {
  id: string
  /** 이 기록이 속한 날짜 (YYYY-MM-DD, 로컬). 자정을 넘겨도 출발한 날짜 */
  date: string
  kind: RecordKind
  mode: Mode
  purpose: Purpose | null
  /** 탑승 중(하차 버튼 대기) */
  ongoing: boolean
  /** 지하철 노선명 또는 버스 번호 */
  line: string | null
  boardPlace: string | null
  alightPlace: string | null
  /** HH:mm */
  boardTime: string | null
  alightTime: string | null
  /** 원문에 소요 시간만 적혀 있는 경우 (분) */
  reportedDurationMin: number | null
  // 지하철 전용
  trainOrigin: string | null
  trainDestination: string | null
  service: Service | null
  car: number | null
  door: number | null
  side: Side | null
  // 버스 전용
  busDoor: BusDoor | null
  // 공통
  waitOrder: number | null
  /** 탑승 시점의 좌석 상태 */
  initialSeat: SeatState | null
  /** true = 탑승 중 좌석 변화를 모두 기록함(추가 변화 없음). null = 미확인 */
  seatLogComplete: boolean | null
  crowding: Crowding | null
  /** 지연 분. 0 = 지연 없음이 확인됨 */
  delayMinutes: number | null
  incident: string | null
  note: string | null
  naFields: NaKey[]
  source: 'manual' | 'import'
  importKey: string | null
  createdAt: number
  updatedAt: number
}

/** 탑승 이후에 일어난 좌석 상태 변화 */
export interface SeatEvent {
  id: string
  tripId: string
  time: string | null
  state: SeatState
  place: string | null
  /** 선택 입력 메모. 이전 버전에서 저장한 이벤트에는 없을 수 있다 */
  note?: string | null
  createdAt: number
}

export interface DayLog {
  date: string
  homeDepart: string | null
  schoolDepart: string | null
  schoolArrive: string | null
  homeArrive: string | null
  note: string | null
  updatedAt: number
}

export interface RouteTemplate {
  id: string
  name: string
  mode: Mode
  purpose: Purpose | null
  line: string | null
  boardPlace: string | null
  alightPlace: string | null
  trainOrigin: string | null
  trainDestination: string | null
  service: Service | null
  car: number | null
  door: number | null
  side: Side | null
  busDoor: BusDoor | null
  useCount: number
  lastUsedAt: number | null
  createdAt: number
}

export interface Setting {
  key: string
  value: unknown
}

export const SCHEMA_VERSION = 1

export type TripDraft = Omit<Trip, 'id' | 'createdAt' | 'updatedAt'>
/** id 가 있으면 저장할 때 같은 식별자를 유지한다(수정 화면에서 기존 이벤트를 다시 저장하는 경우) */
export type SeatEventDraft = Omit<SeatEvent, 'id' | 'tripId' | 'createdAt'> & { id?: string }

export const KIND_LABEL: Record<RecordKind, string> = {
  ride: '탑승',
  missed: '놓침·탑승 실패',
  observed: '관찰만',
}
export const MODE_LABEL: Record<Mode, string> = { subway: '지하철', bus: '버스' }
export const PURPOSE_LABEL: Record<Purpose, string> = {
  to_school: '등교',
  from_school: '하교',
  other: '기타',
}
export const SEAT_LABEL: Record<SeatState, string> = { standing: '서서', seated: '앉아서' }
export const CROWDING_LABEL: Record<Crowding, string> = {
  free: '한산',
  normal: '보통',
  crowded: '혼잡',
  very_crowded: '매우 혼잡',
}
export const SIDE_LABEL: Record<Side, string> = {
  left: '왼쪽',
  right: '오른쪽',
  both: '양쪽',
  unknown: '미상',
}
export const BUS_DOOR_LABEL: Record<BusDoor, string> = {
  front: '앞문',
  middle: '중문',
  rear: '뒷문',
}
export const SERVICE_LABEL: Record<Service, string> = {
  normal: '일반',
  express: '급행',
  other: '기타',
}
export const NA_LABEL: Record<NaKey, string> = {
  trainOrigin: '열차 출발지',
  trainDestination: '행선지',
  service: '운행 종류',
  car: '칸',
  door: '문',
  side: '좌우',
  waitOrder: '대기 순서',
  busDoor: '승차 문',
}

export function emptyTripDraft(date: string, mode: Mode = 'subway'): TripDraft {
  return {
    date,
    kind: 'ride',
    mode,
    purpose: null,
    ongoing: false,
    line: null,
    boardPlace: null,
    alightPlace: null,
    boardTime: null,
    alightTime: null,
    reportedDurationMin: null,
    trainOrigin: null,
    trainDestination: null,
    service: null,
    car: null,
    door: null,
    side: null,
    busDoor: null,
    waitOrder: null,
    initialSeat: null,
    seatLogComplete: null,
    crowding: null,
    delayMinutes: null,
    incident: null,
    note: null,
    naFields: [],
    source: 'manual',
    importKey: null,
  }
}
