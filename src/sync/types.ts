/**
 * Google Drive 동기화 타입.
 *
 * 동기화는 기록 하나하나(탑승·좌석 변화·하루 기록·경로 템플릿)를 단위로 한다.
 * 모든 단위는 `테이블:식별자` 형태의 키(k)로 가리킨다.
 */
export type SyncTable = 'trips' | 'seatEvents' | 'days' | 'templates'
export const SYNC_TABLES: SyncTable[] = ['trips', 'seatEvents', 'days', 'templates']

/** 동기화 대상 기록 한 건의 내용 (테이블마다 모양이 다르다) */
export type SyncData = Record<string, unknown>

/** Drive 파일 안의 기록. 삭제는 data 대신 deleted 표시(묘비)로 남겨 다른 기기가 삭제를 알 수 있게 한다 */
export interface RemoteRecord {
  k: string
  table: SyncTable
  id: string
  /** 마지막 변경 시각(ms). 표시·동률 판정용이며 '최신이 무조건 이긴다'에 쓰지 않는다 */
  ts: number
  deleted?: true
  data?: SyncData
}

/** Drive appDataFolder 에 저장되는 파일 */
export interface RemoteDoc {
  app: 'TransitLog'
  kind: 'sync'
  /** 이 파일 형식의 버전. 모르는 더 새로운 버전이면 덮어쓰지 않고 멈춘다 */
  formatVersion: number
  /** 쓴 앱의 백업 스키마 버전 */
  schemaVersion: number
  /** 쓸 때마다 1 씩 증가 (진단용) */
  revision: number
  writtenAt: string
  writtenBy: string
  records: Record<string, RemoteRecord>
}

export const SYNC_FORMAT_VERSION = 1
export const SYNC_FILE_NAME = 'transitlog-sync.json'

// ── 이 기기 전용 저장 행 ────────────────────────────────

export interface SyncMetaRow {
  key: string
  value: unknown
}

/** 마지막 동기화에서 양쪽이 같았던 기록 사본 */
export interface SyncBaseRow {
  k: string
  data: SyncData
}

export interface ConflictField {
  name: string
  /** 이 기기의 값 */
  local: unknown
  /** Drive(다른 기기)의 값 */
  remote: unknown
  /** 현재 기록에 남아 있는 쪽 */
  kept: 'local' | 'remote'
}

export interface SyncConflict {
  id: string
  k: string
  table: SyncTable
  recordId: string
  at: number
  kind: 'fields' | 'deleted-remote' | 'deleted-local'
  /** 어떤 기록인지 알아볼 수 있는 한 줄 설명 */
  label: string
  fields: ConflictField[]
}

export interface SyncSnapshot {
  id: string
  at: number
  reason: string
  /** buildBackup() 과 같은 모양의 JSON 문자열 */
  json: string
  counts: { trips: number; seatEvents: number; days: number; templates: number }
}

// ── 병합 결과 ───────────────────────────────────────────

export interface MergeStats {
  /** 이 기기에 새로 들어올 기록 */
  pulledNew: number
  /** 이 기기에서 값이 바뀔 기록 */
  pulledChanged: number
  /** 이 기기에서 삭제될 기록(다른 기기에서 삭제) */
  pulledDeleted: number
  /** Drive 로 올라갈 새 기록 */
  pushedNew: number
  pushedChanged: number
  /** Drive 에 삭제로 전달될 기록(이 기기에서 삭제) */
  pushedDeleted: number
  /** 같은 내용이라 이미 일치하는 기록 */
  unchanged: number
  /** 내용이 완전히 같은 중복이라 하나로 합친 건수 */
  deduped: number
  /** 자동 병합 중 사용자 확인이 필요한 충돌 */
  conflicts: number
}

export interface MergeResult {
  /** 이 기기에 쓸 기록 (k → 새 내용) */
  localPut: Map<string, SyncData>
  /** 이 기기에서 지울 기록 */
  localDelete: Set<string>
  /** 업로드할 Drive 파일의 기록 전체 */
  remoteRecords: Record<string, RemoteRecord>
  remoteChanged: boolean
  /** 동기화 뒤의 기준 사본 (키 → 내용). 없는 키는 삭제된 것 */
  nextBase: Map<string, SyncData>
  conflicts: Omit<SyncConflict, 'id' | 'at'>[]
  stats: MergeStats
}

export type SyncPhase =
  | 'unconfigured' // 이 배포에는 Google 클라이언트 ID 가 없음
  | 'disconnected'
  | 'idle'
  | 'syncing'
  | 'ok'
  | 'offline'
  | 'reauth'
  | 'conflict'
  | 'confirm' // 사용자 확인을 기다리는 중 (처음 연결·계정 변경·대량 삭제)
  | 'error'

export type ConfirmKind = 'first' | 'account' | 'bulk-delete' | 'remote-corrupt'

export interface ConfirmRequest {
  kind: ConfirmKind
  /** 처음 연결·계정 변경 때 미리 계산한 병합 요약 */
  stats?: MergeStats
  account?: string | null
  previousAccount?: string | null
  localCounts?: { trips: number; seatEvents: number; days: number; templates: number }
  remoteCounts?: { trips: number; seatEvents: number; days: number; templates: number }
  deleteCount?: number
  /** push = 이 기기에서 지운 기록을 Drive 에 반영, pull = 다른 기기에서 지운 기록을 이 기기에 반영 */
  bulkDirection?: 'push' | 'pull'
  detail?: string
}

export interface SyncStatus {
  phase: SyncPhase
  auto: boolean
  account: string | null
  lastOkAt: number | null
  message: string | null
  conflictCount: number
  confirm: ConfirmRequest | null
  /** 동기화를 기다리는 변경이 있음 (오프라인 등) */
  dirty: boolean
}
