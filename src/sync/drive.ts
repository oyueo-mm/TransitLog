import { SYNC_FILE_NAME } from './types'

/**
 * Google Drive REST (v3) 중 동기화에 필요한 부분만. appDataFolder(사용자에게 보이지 않는 앱 전용 폴더)만 쓴다.
 * 필요한 권한: https://www.googleapis.com/auth/drive.appdata (Drive 의 다른 파일은 읽거나 바꿀 수 없다)
 */

export type DriveErrorKind =
  | 'auth' // 토큰 없음·만료·취소 → 다시 연결 필요
  | 'network' // 오프라인·연결 끊김
  | 'rate' // 호출 제한
  | 'server' // Google 쪽 일시 오류
  | 'forbidden' // 권한·API 사용 설정 문제
  | 'notfound'
  | 'conflict' // 읽은 뒤 다른 기기가 파일을 갱신했다
  | 'badresponse'

export class DriveError extends Error {
  kind: DriveErrorKind
  status?: number
  constructor(kind: DriveErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'DriveError'
    this.kind = kind
    this.status = status
  }
}

export interface DriveFileMeta {
  id: string
  /** Drive 가 파일을 갱신할 때마다 올리는 값 */
  version: string
  createdTime?: string
}

export interface DriveApi {
  /** 동기화 파일 목록 (오래된 것부터) */
  list(): Promise<DriveFileMeta[]>
  read(id: string): Promise<{ text: string; version: string }>
  create(text: string): Promise<DriveFileMeta>
  /** expectVersion 이 지금 파일 버전과 다르면 DriveError('conflict') */
  update(id: string, text: string, expectVersion: string): Promise<DriveFileMeta>
  remove(id: string): Promise<void>
  about(): Promise<{ account: string | null; permissionId: string | null }>
}

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

export function createDriveApi(getToken: () => string | null, fetchFn: typeof fetch = (...a) => fetch(...a)): DriveApi {
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = getToken()
    if (!token) throw new DriveError('auth', 'Google 연결이 만료되었습니다.')
    let res: Response
    try {
      res = await fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } })
    } catch {
      throw new DriveError('network', '네트워크에 연결할 수 없습니다.')
    }
    if (res.ok) return res
    let reason = ''
    try {
      const body = (await res.json()) as { error?: { errors?: Array<{ reason?: string }>; status?: string } }
      reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? ''
    } catch {
      /* 본문이 JSON 이 아니면 상태 코드만 사용 */
    }
    if (res.status === 401) throw new DriveError('auth', 'Google 로그인이 만료되었습니다.', 401)
    if (res.status === 429 || /ratelimit/i.test(reason)) throw new DriveError('rate', '요청이 너무 많습니다. 잠시 후 다시 시도합니다.', res.status)
    if (res.status === 403) throw new DriveError('forbidden', `Drive 접근이 거부되었습니다${reason ? ` (${reason})` : ''}. Google Cloud 설정에서 Drive API 사용 설정과 drive.appdata 범위를 확인해 주세요.`, 403)
    if (res.status === 404) throw new DriveError('notfound', '파일을 찾을 수 없습니다.', 404)
    if (res.status >= 500) throw new DriveError('server', 'Google 서버가 일시적으로 응답하지 않습니다.', res.status)
    throw new DriveError('badresponse', `예상하지 못한 응답입니다 (${res.status}).`, res.status)
  }

  const parseMeta = (j: unknown): DriveFileMeta => {
    const o = j as Partial<DriveFileMeta> | null
    if (!o || typeof o.id !== 'string') throw new DriveError('badresponse', 'Drive 응답을 해석할 수 없습니다.')
    return { id: o.id, version: String(o.version ?? ''), createdTime: o.createdTime }
  }

  return {
    async list() {
      const q = encodeURIComponent(`name='${SYNC_FILE_NAME}' and trashed=false`)
      const res = await call(`${API}/files?spaces=appDataFolder&q=${q}&orderBy=createdTime&fields=files(id,version,createdTime)&pageSize=10`)
      const j = (await res.json()) as { files?: unknown[] }
      return (j.files ?? []).map(parseMeta)
    },
    async read(id) {
      const meta = parseMeta(await (await call(`${API}/files/${encodeURIComponent(id)}?fields=id,version`)).json())
      const res = await call(`${API}/files/${encodeURIComponent(id)}?alt=media`)
      return { text: await res.text(), version: meta.version }
    },
    async create(text) {
      const boundary = 'tl' + Math.random().toString(36).slice(2)
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: SYNC_FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' }) +
        `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`
      const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,version,createdTime`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      })
      return parseMeta(await res.json())
    },
    async update(id, text, expectVersion) {
      const cur = parseMeta(await (await call(`${API}/files/${encodeURIComponent(id)}?fields=id,version`)).json())
      if (cur.version !== expectVersion) throw new DriveError('conflict', '동기화 중 다른 기기가 Drive 파일을 갱신했습니다.')
      const res = await call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,version,createdTime`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: text,
      })
      return parseMeta(await res.json())
    },
    async remove(id) {
      await call(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    async about() {
      const res = await call(`${API}/about?fields=user(emailAddress,permissionId)`)
      const j = (await res.json()) as { user?: { emailAddress?: string; permissionId?: string } }
      return { account: j.user?.emailAddress ?? null, permissionId: j.user?.permissionId ?? null }
    },
  }
}
