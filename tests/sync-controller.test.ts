import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { saveTrip } from '../src/db/repo'
import { emptyTripDraft } from '../src/domain/types'
import { SyncController } from '../src/sync/controller'
import { DriveError } from '../src/sync/drive'
import { getMeta } from '../src/sync/engine'
import { FakeAuth, FakeCloud, newDevice } from './syncFakes'

const draft = (p = {}) => ({ ...emptyTripDraft('2026-03-02'), ...p })

function setup(opts: { online?: boolean } = {}) {
  const db = newDevice()
  const cloud = new FakeCloud()
  const auth = new FakeAuth()
  let online = opts.online ?? true
  const c = new SyncController({ db, auth, drive: cloud.api(), isOnline: () => online, debounceMs: 40, retryBaseMs: 60 })
  return { db, cloud, auth, c, setOnline: (v: boolean) => (online = v) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('시간 초과')
    await sleep(10)
  }
}
/** 같은 기기(DB)·같은 로그인으로 새로고침(F5)한 것처럼 새 컨트롤러를 만든다 */
const reload = (s: ReturnType<typeof setup>) => new SyncController({ db: s.db, auth: s.auth, drive: s.cloud.api(), debounceMs: 40, retryBaseMs: 60 })

describe('동기화 컨트롤러 — 연결', () => {
  it('Client ID 가 없는 배포에서는 설정 필요 상태이며 아무 것도 하지 않는다', async () => {
    const db = newDevice()
    const auth = new FakeAuth()
    auth.configured = false
    const cloud = new FakeCloud()
    const c = new SyncController({ db, auth, drive: cloud.api() })
    await c.init()
    await c.syncNow()
    await c.connect()
    c.requestSync()
    expect(c.getStatus().phase).toBe('unconfigured')
    expect(auth.acquires).toHaveLength(0)
    expect(cloud.files).toHaveLength(0)
  })

  it('연결 → 처음 연결 확인 → 계속하면 동기화가 완료되고 마지막 성공 시각이 남는다', async () => {
    const { c, db, cloud } = setup()
    await saveTrip(draft({ line: '1호선' }), [], db)
    await c.init()
    expect(c.getStatus().phase).toBe('disconnected')
    await c.connect()
    expect(c.getStatus().phase).toBe('confirm')
    expect(c.getStatus().confirm?.kind).toBe('first')
    expect(cloud.files).toHaveLength(0) // 확인 전에는 올리지 않는다
    await c.confirmContinue()
    expect(c.getStatus().phase).toBe('ok')
    expect(c.getStatus().account).toBe('tester@example.test')
    expect(c.getStatus().lastOkAt).toBeGreaterThan(0)
    expect(Object.keys(cloud.doc.records)).toHaveLength(1)
  })

  it('init 은 로그인 구성 요소를 미리 불러온다 (클릭 때 팝업을 바로 열 수 있게)', async () => {
    const { c, auth } = setup()
    await c.init()
    expect(auth.preloads).toBe(1)
  })

  it('처음 연결을 취소하면 연결되지 않고 기록은 그대로다 (Google 권한도 철회하지 않는다)', async () => {
    const { c, db, auth, cloud } = setup()
    await saveTrip(draft({ line: '1호선' }), [], db)
    await c.connect()
    await c.confirmCancel()
    expect(c.getStatus().phase).toBe('disconnected')
    expect(auth.revoked).toBe(0)
    expect(auth.forgotten).toBeGreaterThan(0)
    expect(await db.trips.count()).toBe(1)
    expect(cloud.files).toHaveLength(0)
    expect(await getMeta(db, 'enabled', false)).toBe(false)
  })

  it('처음 연결에서 팝업을 닫거나 거부하거나 차단돼도 연결 안 됨으로 남고 이유를 알리며 기록은 그대로다', async () => {
    const { c, db, auth } = setup()
    await saveTrip(draft({ line: '1호선' }), [], db)
    auth.token = null
    for (const [reason, text] of [
      ['closed', /닫혀/],
      ['denied', /거부/],
      ['popup_blocked', /차단/],
      ['scope_missing', /권한/],
      ['unavailable', /불러오지/],
    ] as const) {
      auth.next = { ok: false, reason }
      await c.connect()
      expect(c.getStatus().phase).toBe('disconnected')
      expect(c.getStatus().message).toMatch(text)
    }
    expect(await getMeta(db, 'enabled', false)).toBe(false)
    expect(await db.trips.count()).toBe(1)
  })

  it('‘다시 연결’은 마지막 계정을 힌트로 사용자 클릭 직후 곧바로 로그인을 요청한다', async () => {
    const s = setup()
    await s.c.connect()
    await s.c.confirmContinue()
    const again = reload(s)
    await again.init()
    s.auth.token = null
    s.auth.acquires.length = 0
    const p = again.reconnect()
    // 첫 await 전에 이미 요청이 나갔어야 한다 (동기 호출)
    expect(s.auth.acquires).toEqual([{ interactive: true, loginHint: 'tester@example.test', selectAccount: undefined }])
    await p
    expect(again.getStatus().phase).toBe('ok')
  })

  it('다른 계정으로 연결은 계정 힌트 없이 계정 선택을 요청한다', async () => {
    const s = setup()
    await s.c.connect()
    await s.c.confirmContinue()
    s.auth.acquires.length = 0
    await s.c.reconnect({ otherAccount: true })
    expect(s.auth.acquires[0]).toMatchObject({ interactive: true, selectAccount: true })
  })

  it('연결 버튼을 연달아 눌러도 로그인 요청(팝업)은 하나만 만든다', async () => {
    const s = setup()
    s.auth.delay = 50
    s.auth.token = null
    const a = s.c.connect()
    const b = s.c.connect()
    const c = s.c.connect()
    await Promise.all([a, b, c])
    expect(s.auth.acquires).toHaveLength(1)
  })
})

describe('동기화 컨트롤러 — 새로고침과 재인증', () => {
  it('F5: 로그인이 남아 있으면(저장된 유효 토큰) 재인증 없이 곧바로 동기화한다', async () => {
    const s = setup()
    await saveTrip(draft({ line: '1호선' }), [], s.db)
    await s.c.connect()
    await s.c.confirmContinue()
    await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], s.db)
    const again = reload(s)
    s.auth.acquires.length = 0
    await again.init()
    expect(again.getStatus().phase).toBe('ok')
    expect(s.auth.acquires).toHaveLength(0) // 로그인 창 없음
    expect(Object.keys(s.cloud.doc.records)).toHaveLength(2)
    expect(again.getStatus().account).toBe('tester@example.test')
  })

  it('F5 후 토큰이 없으면 연결 해제가 아니라 재인증 필요로 표시하고 팝업을 시도하지 않으며 계정·마지막 동기화 시각을 유지한다', async () => {
    const s = setup()
    await s.c.connect()
    await s.c.confirmContinue()
    const lastOk = s.c.getStatus().lastOkAt
    s.auth.token = null
    s.auth.acquires.length = 0
    const again = reload(s)
    await again.init()
    const st = again.getStatus()
    expect(st.phase).toBe('reauth')
    expect(st.account).toBe('tester@example.test')
    expect(st.lastOkAt).toBe(lastOk)
    expect(st.message).toMatch(/다시 연결/)
    expect(s.auth.acquires).toHaveLength(0)
    expect(await getMeta(s.db, 'enabled', false)).toBe(true)
  })

  it('재인증 필요 중에도 기록은 저장되고, 다시 연결하면 쌓인 기록이 한꺼번에 동기화된다', async () => {
    const s = setup()
    await s.c.connect()
    await s.c.confirmContinue()
    s.auth.token = null
    const again = reload(s)
    await again.init()
    expect(again.getStatus().phase).toBe('reauth')
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], s.db)
    await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], s.db)
    again.requestSync()
    await sleep(150)
    expect(again.getStatus().phase).toBe('reauth')
    expect(Object.keys(s.cloud.doc.records)).toHaveLength(0)
    await again.reconnect()
    expect(again.getStatus().phase).toBe('ok')
    expect(Object.keys(s.cloud.doc.records)).toHaveLength(2)
  })

  it('재인증 중 팝업을 닫거나 차단하면 재인증 필요가 유지되고 이유를 알린다', async () => {
    const s = setup()
    await s.c.connect()
    await s.c.confirmContinue()
    s.auth.token = null
    s.auth.next = { ok: false, reason: 'popup_blocked' }
    await s.c.reconnect()
    expect(s.c.getStatus().phase).toBe('reauth')
    expect(s.c.getStatus().message).toMatch(/차단/)
    s.auth.next = { ok: false, reason: 'closed' }
    await s.c.reconnect()
    expect(s.c.getStatus().phase).toBe('reauth')
    s.auth.next = { ok: true }
    await s.c.reconnect()
    expect(s.c.getStatus().phase).toBe('ok')
  })

  it('토큰이 만료(401)되면 저장된 토큰을 지우고 재인증 필요를 표시하며, 다시 연결하면 이어서 동기화한다', async () => {
    const { c, db, cloud, auth } = setup()
    await c.connect()
    await c.confirmContinue()
    cloud.failures.push(new DriveError('auth', 'expired', 401))
    await saveTrip(draft({ line: '2호선' }), [], db)
    await c.syncNow()
    expect(c.getStatus().phase).toBe('reauth')
    expect(auth.forgotten).toBeGreaterThan(0)
    expect(auth.token).toBeNull()
    await c.reconnect()
    expect(c.getStatus().phase).toBe('ok')
    expect(Object.keys(cloud.doc.records)).toHaveLength(1)
  })

  it('다른 계정으로 다시 연결하면 확인 전에는 새 계정에 아무것도 올리지 않는다', async () => {
    const s = setup()
    await saveTrip(draft({ line: '1호선' }), [], s.db)
    await s.c.connect()
    await s.c.confirmContinue()
    const other = new FakeCloud()
    other.permissionId = 'perm-2'
    other.email = 'other@example.test'
    const c2 = new SyncController({ db: s.db, auth: s.auth, drive: other.api(), debounceMs: 40 })
    await c2.init()
    expect(c2.getStatus().phase).toBe('confirm')
    expect(c2.getStatus().confirm?.kind).toBe('account')
    expect(other.files).toHaveLength(0)
    expect(await s.db.trips.count()).toBe(1)
  })
})

describe('동기화 컨트롤러 — 연결 해제', () => {
  it('이 기기에서 연결 해제는 Google 권한을 철회하지 않고, 이 기기의 기록과 Drive 기록을 지우지 않는다', async () => {
    const { c, db, auth, cloud } = setup()
    await saveTrip(draft({ line: '1호선' }), [], db)
    await c.connect()
    await c.confirmContinue()
    expect(await db.syncBase.count()).toBe(1)
    await c.disconnect()
    expect(c.getStatus().phase).toBe('disconnected')
    expect(await db.trips.count()).toBe(1)
    expect(await db.syncBase.count()).toBe(0)
    expect(auth.revoked).toBe(0)
    expect(auth.token).toBeNull() // 이 기기의 토큰은 지움
    expect(Object.keys(cloud.doc.records)).toHaveLength(1)
    c.requestSync() // 연결되지 않았으므로 무시
    expect(c.getStatus().dirty).toBe(false)
  })

  it('Google 접근 권한 철회는 명시적으로 호출했을 때만 revoke 하고 기록은 지우지 않는다', async () => {
    const { c, db, auth, cloud } = setup()
    await saveTrip(draft({ line: '1호선' }), [], db)
    await c.connect()
    await c.confirmContinue()
    const sent = await c.revokeAccess()
    expect(sent).toBe(true)
    expect(auth.revoked).toBe(1)
    expect(c.getStatus().phase).toBe('disconnected')
    expect(await db.trips.count()).toBe(1)
    expect(Object.keys(cloud.doc.records)).toHaveLength(1)
  })

  it('토큰이 없을 때의 권한 철회는 요청을 보내지 못했다고 알리고 이 기기의 연결만 해제한다', async () => {
    const { c, auth } = setup()
    await c.connect()
    await c.confirmContinue()
    auth.token = null
    expect(await c.revokeAccess()).toBe(false)
    expect(c.getStatus().phase).toBe('disconnected')
  })

  it('한 기기를 연결 해제해도 같은 계정의 다른 기기는 계속 동기화된다', async () => {
    const cloud = new FakeCloud()
    const mk = () => {
      const db = newDevice()
      const auth = new FakeAuth()
      return { db, auth, c: new SyncController({ db, auth, drive: cloud.api(), debounceMs: 40 }) }
    }
    const pc = mk()
    const phone = mk()
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], pc.db)
    await pc.c.connect()
    await pc.c.confirmContinue()
    await phone.c.connect()
    await phone.c.confirmContinue()
    expect(await phone.db.trips.count()).toBe(1)

    await pc.c.disconnect()
    expect(pc.auth.revoked).toBe(0)
    expect(phone.auth.token).not.toBeNull() // 다른 기기의 로그인은 영향받지 않음

    await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], phone.db)
    await phone.c.syncNow()
    expect(phone.c.getStatus().phase).toBe('ok')
    expect(Object.values(cloud.doc.records).filter((r) => !r.deleted)).toHaveLength(2)
    expect(await pc.db.trips.count()).toBe(1) // 해제한 기기의 기록은 그대로
  })

  it('PC 와 휴대폰을 번갈아 연결해도 서로의 기록이 합쳐진다', async () => {
    const cloud = new FakeCloud()
    const mk = () => {
      const db = newDevice()
      return { db, c: new SyncController({ db, auth: new FakeAuth(), drive: cloud.api(), debounceMs: 40 }) }
    }
    const pc = mk()
    const phone = mk()
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], pc.db)
    await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], phone.db)
    await pc.c.connect()
    await pc.c.confirmContinue()
    await phone.c.connect()
    await phone.c.confirmContinue()
    await pc.c.syncNow()
    expect(await pc.db.trips.count()).toBe(2)
    expect(await phone.db.trips.count()).toBe(2)
    // 반대 순서: 휴대폰에서 추가 → PC 동기화
    await saveTrip(draft({ line: '수인분당선', boardTime: '10:00' }), [], phone.db)
    await phone.c.syncNow()
    await pc.c.syncNow()
    expect(await pc.db.trips.count()).toBe(3)
  })
})

describe('동기화 컨트롤러 — 자동 동기화·오류', () => {
  it('오프라인에서는 요청하지 않고 대기 표시만 하다가, 온라인이 되면 한 번에 동기화한다', async () => {
    const { c, db, cloud, setOnline } = setup()
    await c.connect()
    await c.confirmContinue()
    setOnline(false)
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], db)
    const before = cloud.writes
    c.requestSync()
    await until(() => c.getStatus().phase === 'offline')
    expect(c.getStatus().dirty).toBe(true)
    expect(cloud.writes).toBe(before)
    setOnline(true)
    c.requestSync()
    await until(() => c.getStatus().phase === 'ok')
    expect(Object.keys(cloud.doc.records)).toHaveLength(1)
  })

  it('짧은 시간에 여러 번 변경해도 동기화는 한 번만 실행된다 (debounce·직렬화)', async () => {
    const { c, cloud, db } = setup()
    await c.connect()
    await c.confirmContinue()
    const reads = cloud.reads
    for (let i = 0; i < 5; i++) {
      await saveTrip(draft({ line: '1호선', boardTime: `08:0${i}` }), [], db)
      c.requestSync()
      await sleep(5)
    }
    expect(cloud.writes).toBe(1) // 아직 대기 중
    await until(() => cloud.writes === 2)
    await sleep(150)
    expect(cloud.writes).toBe(2)
    expect(cloud.reads - reads).toBe(2) // 읽기 + 쓰기 확인 한 번씩
    expect(Object.keys(cloud.doc.records)).toHaveLength(5)
  })

  it('자동 동기화를 끄면 변경해도 올리지 않고, 지금 동기화만 동작한다', async () => {
    const { c, cloud, db } = setup()
    await c.connect()
    await c.confirmContinue()
    await c.setAuto(false)
    await saveTrip(draft({ line: '1호선' }), [], db)
    c.requestSync()
    await sleep(150)
    expect(Object.keys(cloud.doc.records)).toHaveLength(0)
    await c.syncNow()
    expect(Object.keys(cloud.doc.records)).toHaveLength(1)
  })

  it('임시 네트워크 오류는 오류 표시 후 자동으로 다시 시도한다', async () => {
    const { c, cloud, db } = setup()
    await c.connect()
    await c.confirmContinue()
    await saveTrip(draft({ line: '1호선' }), [], db)
    cloud.failures.push(new DriveError('network', 'x'))
    await c.syncNow()
    expect(c.getStatus().phase).toBe('error')
    expect(c.getStatus().dirty).toBe(true)
    await until(() => c.getStatus().phase === 'ok')
  })

  it('동기화 중 새로고침(중단)이 일어나도 다음 실행에서 잃거나 중복되는 기록 없이 이어진다', async () => {
    const s = setup()
    const other = newDevice()
    const oc = new SyncController({ db: other, auth: new FakeAuth(), drive: s.cloud.api(), debounceMs: 40 })
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], s.db)
    await s.c.connect()
    await s.c.confirmContinue()
    await oc.connect()
    await oc.confirmContinue()
    await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], s.db)
    await saveTrip(draft({ line: '수인분당선', boardTime: '10:00' }), [], other)
    // 업로드는 끝났지만 확인 읽기에서 페이지가 사라진 것처럼 중단 (이 기기에는 아직 아무것도 반영되지 않음)
    const real = s.cloud.api()
    let reads = 0
    const crashing = { ...real, read: async (id: string) => (++reads === 2 ? Promise.reject(new Error('page-unload')) : real.read(id)) }
    const dying = new SyncController({ db: s.db, auth: s.auth, drive: crashing, debounceMs: 40 })
    await dying.init()
    expect(dying.getStatus().phase).toBe('error')
    expect(await s.db.trips.count()).toBe(2)
    // 새로고침 후 재실행
    const revived = reload(s)
    await revived.init()
    await oc.syncNow()
    await revived.syncNow()
    expect(revived.getStatus().phase).toBe('ok')
    expect(await s.db.trips.count()).toBe(3)
    expect(await other.trips.count()).toBe(3)
    expect(Object.values(s.cloud.doc.records).filter((r) => !r.deleted)).toHaveLength(3)
  })

  it('충돌을 확인하고 다른 쪽 값으로 바꾸면 기록에 반영되어 다시 동기화 대상이 된다', async () => {
    const a = setup()
    const t = await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], a.db)
    await a.c.connect()
    await a.c.confirmContinue()
    const bDb = newDevice()
    const bc = new SyncController({ db: bDb, auth: new FakeAuth(), drive: a.cloud.api() })
    await bc.connect()
    await bc.confirmContinue()
    await saveTrip({ ...(await a.db.trips.get(t.id))!, note: 'A' }, undefined, a.db)
    await saveTrip({ ...(await bDb.trips.get(t.id))!, note: 'B' }, undefined, bDb)
    await a.c.syncNow()
    await bc.syncNow()
    await a.c.syncNow()
    const conflicts = [...(await a.db.syncConflicts.toArray()), ...(await bDb.syncConflicts.toArray())]
    expect(conflicts).toHaveLength(1)
    const owner = (await a.db.syncConflicts.count()) ? { c: a.c, db: a.db } : { c: bc, db: bDb }
    const kept = (await owner.db.trips.get(t.id))!.note
    expect(owner.c.getStatus().phase).toBe('conflict')
    await owner.c.resolveConflict(conflicts[0], 'other')
    expect((await owner.db.trips.get(t.id))!.note).toBe(kept === 'A' ? 'B' : 'A')
    expect(await owner.db.syncConflicts.count()).toBe(0)
  })
})
