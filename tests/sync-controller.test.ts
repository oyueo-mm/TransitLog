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

describe('동기화 컨트롤러', () => {
  it('Client ID 가 없는 배포에서는 설정 필요 상태이며 아무 것도 하지 않는다', async () => {
    const db = newDevice()
    const auth = new FakeAuth()
    auth.configured = false
    const cloud = new FakeCloud()
    const c = new SyncController({ db, auth, drive: cloud.api() })
    await c.init()
    await c.syncNow()
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

  it('처음 연결을 취소하면 연결되지 않고 기록은 그대로다', async () => {
    const { c, db, auth, cloud } = setup()
    await saveTrip(draft({ line: '1호선' }), [], db)
    await c.connect()
    await c.confirmCancel()
    expect(c.getStatus().phase).toBe('disconnected')
    expect(auth.revoked).toBe(1)
    expect(await db.trips.count()).toBe(1)
    expect(cloud.files).toHaveLength(0)
    expect(await getMeta(db, 'enabled', false)).toBe(false)
  })

  it('인증 팝업을 취소하거나 거부하면 재인증 필요로 표시하고 기록을 건드리지 않는다', async () => {
    const { c, db, auth } = setup()
    await saveTrip(draft({ line: '1호선' }), [], db)
    auth.token = null
    auth.next = { ok: false, reason: 'closed' }
    await c.connect()
    expect(c.getStatus().phase).toBe('reauth')
    expect(c.getStatus().message).toMatch(/다시 연결/)
    expect(await db.trips.count()).toBe(1)
  })

  it('토큰이 만료(401)되면 조용히 멈추지 않고 재인증 필요를 표시하며, 다시 연결하면 이어서 동기화한다', async () => {
    const { c, db, cloud, auth } = setup()
    await c.connect()
    await c.confirmContinue()
    cloud.failures.push(new DriveError('auth', 'expired', 401))
    await saveTrip(draft({ line: '2호선' }), [], db)
    await c.syncNow({ interactive: false })
    expect(c.getStatus().phase).toBe('reauth')
    expect(auth.token).toBeNull()
    await c.syncNow({ interactive: true })
    expect(c.getStatus().phase).toBe('ok')
    expect(Object.keys(cloud.doc.records)).toHaveLength(1)
  })

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
    await c.syncNow({ interactive: false })
    expect(c.getStatus().phase).toBe('error')
    expect(c.getStatus().dirty).toBe(true)
    await until(() => c.getStatus().phase === 'ok')
  })

  it('연결을 해제해도 이 기기의 기록은 지워지지 않고 동기화 상태만 정리된다', async () => {
    const { c, db, auth } = setup()
    await saveTrip(draft({ line: '1호선' }), [], db)
    await c.connect()
    await c.confirmContinue()
    expect(await db.syncBase.count()).toBe(1)
    await c.disconnect()
    expect(c.getStatus().phase).toBe('disconnected')
    expect(await db.trips.count()).toBe(1)
    expect(await db.syncBase.count()).toBe(0)
    expect(auth.revoked).toBe(1)
    c.requestSync() // 연결되지 않았으므로 무시
    expect(c.getStatus().dirty).toBe(false)
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

  it('앱을 다시 열면 연결 상태를 복구하고 조용히 동기화를 시도한다', async () => {
    const { c, db, cloud, auth } = setup()
    await c.connect()
    await c.confirmContinue()
    const again = new SyncController({ db, auth, drive: cloud.api() })
    auth.acquires.length = 0
    auth.token = null // 새 탭: 메모리 토큰 없음
    await again.init()
    expect(auth.acquires).toEqual([{ interactive: false }])
    expect(again.getStatus().phase).toBe('ok')
    // 조용한 갱신이 안 되면 재인증 필요
    auth.token = null
    auth.next = { ok: false, reason: 'needs_interaction' }
    const third = new SyncController({ db, auth, drive: cloud.api() })
    await third.init()
    expect(third.getStatus().phase).toBe('reauth')
  })
})
