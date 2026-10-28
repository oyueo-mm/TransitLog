import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { buildBackup, deleteAllData } from '../src/db/backup'
import type { TransitDB } from '../src/db/db'
import { deleteTrip, saveDay, saveTemplate, saveTrip, templateFromTrip } from '../src/db/repo'
import { emptyTripDraft, type Trip } from '../src/domain/types'
import { DriveError } from '../src/sync/drive'
import { RemoteTooNewError, clearSyncState, getMeta, readLocal, runSync, type RunOptions, type SyncOutcome } from '../src/sync/engine'
import { FakeCloud, newDevice } from './syncFakes'

const draft = (p: Partial<Trip> = {}) => ({ ...emptyTripDraft('2026-03-02'), mode: 'subway' as const, ...p })

async function sync(db: TransitDB, cloud: FakeCloud, o: RunOptions = {}): Promise<SyncOutcome> {
  return runSync({ db, drive: cloud.api() }, { confirmFirst: true, ...o })
}
async function ok(db: TransitDB, cloud: FakeCloud, o: RunOptions = {}) {
  const r = await sync(db, cloud, o)
  if (r.kind !== 'ok') throw new Error('확인 요청: ' + r.request.kind)
  return r
}
const ids = async (db: TransitDB) => (await db.trips.toArray()).map((t) => t.id).sort()
const state = async (db: TransitDB) => {
  const m = await readLocal(db)
  return [...m.entries()].map(([k, v]) => [k, JSON.stringify(Object.fromEntries(Object.entries(v).filter(([n]) => n !== 'updatedAt' && n !== 'createdAt').sort()))]).sort()
}

describe('동기화 엔진 — 연결과 기본 흐름', () => {
  it('처음 연결할 때는 사용자 확인 없이 아무것도 올리지 않는다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], a)
    const r = await runSync({ db: a, drive: cloud.api() })
    expect(r.kind).toBe('confirm')
    if (r.kind === 'confirm') {
      expect(r.request.kind).toBe('first')
      expect(r.request.localCounts?.trips).toBe(1)
      expect(r.request.stats?.pushedNew).toBe(1)
    }
    expect(cloud.files).toHaveLength(0)
    expect(cloud.writes).toBe(0)
  })

  it('A 에서 올린 기록이 B 에 나타나고, 반대도 된다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    const t = await saveTrip(draft({ line: '1호선', boardTime: '08:00', kind: 'observed' }), [], a)
    await ok(a, cloud)
    await ok(b, cloud)
    expect((await b.trips.get(t.id))?.kind).toBe('observed')
    const t2 = await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [{ time: '09:05', state: 'seated', place: null }], b)
    await ok(b, cloud)
    await ok(a, cloud)
    expect((await a.trips.get(t2.id))?.line).toBe('2호선')
    expect(await a.seatEvents.where('tripId').equals(t2.id).count()).toBe(1)
    expect(await state(a)).toEqual(await state(b))
  })

  it('하루 기록과 경로 템플릿도 함께 동기화된다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    const t = await saveTrip(draft({ line: '1호선', boardPlace: '가역', alightPlace: '나역' }), [], a)
    await saveTemplate(templateFromTrip(t, '내 경로'), a)
    await saveDay('2026-03-02', { homeDepart: '07:30' }, a)
    await ok(a, cloud)
    await ok(b, cloud)
    expect((await b.templates.toArray()).map((x) => x.name)).toEqual(['내 경로'])
    expect((await b.days.get('2026-03-02'))?.homeDepart).toBe('07:30')
  })

  it('두 번째 실행은 아무것도 쓰지 않는다 (중복 업로드 없음)', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await saveTrip(draft({ line: '1호선' }), [], a)
    await ok(a, cloud)
    const writes = cloud.writes
    const r = await ok(a, cloud)
    expect(cloud.writes).toBe(writes)
    expect(r.wrote).toBe(false)
    expect(r.stats.unchanged).toBe(1)
  })

  it('양쪽이 각자 기록을 추가해도 합쳐서 서로 같아진다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    await ok(a, cloud)
    await ok(b, cloud)
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], a)
    await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], b)
    await ok(a, cloud)
    await ok(b, cloud)
    await ok(a, cloud)
    expect(await ids(a)).toHaveLength(2)
    expect(await state(a)).toEqual(await state(b))
  })

  it('수정과 삭제가 다른 기기로 전달된다 (좌석 변화 포함)', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    const keep = await saveTrip(draft({ line: '1호선', boardTime: '08:00', note: '처음' }), [], a)
    const gone = await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [{ time: '09:05', state: 'seated', place: null }], a)
    await ok(a, cloud)
    await ok(b, cloud)
    await saveTrip({ ...(await b.trips.get(keep.id))!, note: '수정됨' }, undefined, b)
    await deleteTrip(gone.id, b)
    await ok(b, cloud)
    await ok(a, cloud)
    expect((await a.trips.get(keep.id))?.note).toBe('수정됨')
    expect(await a.trips.get(gone.id)).toBeUndefined()
    expect(await a.seatEvents.count()).toBe(0)
    // 삭제는 묘비로 남는다
    expect(cloud.doc.records[`trips:${gone.id}`].deleted).toBe(true)
  })

  it('다른 필드를 동시에 고치면 둘 다 남고, 같은 필드는 충돌로 보존된다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    const t = await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], a)
    await ok(a, cloud)
    await ok(b, cloud)
    await saveTrip({ ...(await a.trips.get(t.id))!, note: 'A 메모', crowding: 'crowded' }, undefined, a)
    await saveTrip({ ...(await b.trips.get(t.id))!, note: 'B 메모', delayMinutes: 5 }, undefined, b)
    await ok(a, cloud)
    await ok(b, cloud)
    await ok(a, cloud)
    const ta = (await a.trips.get(t.id))!
    const tb = (await b.trips.get(t.id))!
    expect(ta.crowding).toBe('crowded')
    expect(ta.delayMinutes).toBe(5)
    expect(['A 메모', 'B 메모']).toContain(ta.note)
    expect(tb.note).toBe(ta.note)
    // 밀려난 값은 어느 한쪽 기기의 충돌 목록에 남아 있다
    const all = [...(await a.syncConflicts.toArray()), ...(await b.syncConflicts.toArray())]
    const loserSeen = all.some((c) => c.fields.some((f) => f.name === 'note' && [f.local, f.remote].includes(ta.note === 'A 메모' ? 'B 메모' : 'A 메모')))
    expect(loserSeen).toBe(true)
  })

  it('같은 가져오기를 두 기기에서 따로 해서 식별자만 다른 완전히 같은 기록은 하나로 합친다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    const same = draft({ line: '1호선', boardTime: '08:00', boardPlace: '가역', alightPlace: '나역', source: 'import', importKey: 'k1' })
    await saveTrip(same, [], a)
    await saveTrip(same, [], b)
    await ok(a, cloud)
    await ok(b, cloud)
    await ok(a, cloud)
    expect(await ids(a)).toHaveLength(1)
    expect(await ids(a)).toEqual(await ids(b))
  })
})

describe('동기화 엔진 — 실패와 복구', () => {
  it('네트워크가 끊기면 이 기기의 기록은 그대로이고, 복구 뒤 이어서 동기화된다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const t = await saveTrip(draft({ line: '1호선' }), [], a)
    await ok(a, cloud)
    await saveTrip({ ...t, note: '오프라인에서 수정' }, undefined, a)
    cloud.failures.push(new DriveError('network', 'offline'))
    await expect(sync(a, cloud)).rejects.toMatchObject({ kind: 'network' })
    expect((await a.trips.get(t.id))?.note).toBe('오프라인에서 수정')
    await ok(a, cloud)
    expect(cloud.doc.records[`trips:${t.id}`].data?.note).toBe('오프라인에서 수정')
  })

  it('인증이 만료(401)되면 오류만 던지고 데이터는 건드리지 않는다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await saveTrip(draft({ line: '1호선' }), [], a)
    cloud.failures.push(new DriveError('auth', 'expired', 401))
    await expect(sync(a, cloud)).rejects.toMatchObject({ kind: 'auth' })
    expect(await a.trips.count()).toBe(1)
    expect(cloud.files).toHaveLength(0)
  })

  it('읽은 뒤 다른 기기가 파일을 갱신하면 처음부터 다시 병합해 둘 다 보존한다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    await ok(a, cloud)
    await ok(b, cloud)
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], a)
    await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], b)
    let injected = false
    cloud.onBeforeUpdate = async () => {
      if (injected) return
      injected = true
      cloud.onBeforeUpdate = undefined
      await ok(b, cloud) // A 가 쓰기 직전에 B 가 먼저 동기화를 끝냄
    }
    await ok(a, cloud)
    await ok(b, cloud)
    expect(await ids(a)).toHaveLength(2)
    expect(await state(a)).toEqual(await state(b))
    expect(Object.values(cloud.doc.records).filter((r) => !r.deleted)).toHaveLength(2)
  })

  it('쓴 직후 다른 기기가 덮어써 내용이 사라지면 감지해 다시 올린다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await ok(a, cloud)
    const t = await saveTrip(draft({ line: '1호선' }), [], a)
    const stale = cloud.text
    let once = false
    cloud.onAfterUpdate = () => {
      if (once) return
      once = true
      cloud.overwrite(stale) // 오래된 내용이 덮어씀
    }
    const r = await ok(a, cloud)
    expect(r.wrote).toBe(true)
    expect(cloud.doc.records[`trips:${t.id}`]?.data).toBeDefined()
  })

  it('쓰기에 실패하면 이 기기의 기록은 바뀌지 않고, 다음 실행이 같은 결과를 낸다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], a)
    await ok(a, cloud)
    const t2 = await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], b)
    cloud.onBeforeUpdate = () => {
      cloud.onBeforeUpdate = undefined
      throw new DriveError('server', 'boom', 500)
    }
    await expect(sync(b, cloud)).rejects.toMatchObject({ kind: 'server' })
    expect(await b.trips.count()).toBe(1) // 받아오기 전
    await ok(b, cloud)
    await ok(a, cloud)
    expect((await a.trips.get(t2.id))?.line).toBe('2호선')
    expect(await b.trips.count()).toBe(2)
  })

  it('두 기기가 동시에 파일을 처음 만들면 가장 오래된 하나만 남기고 둘 다 보존한다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], a)
    await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], b)
    cloud.onAfterCreate = async () => {
      cloud.onAfterCreate = undefined
      // A 가 만드는 사이 B 가 먼저(더 오래된 파일로) 만든 것처럼 한다
      const mine = cloud.files.pop()!
      await ok(b, cloud)
      cloud.files.push(mine)
      cloud.files[0].createdTime = '2025-01-01T00:00:00.000Z'
    }
    await ok(a, cloud)
    await ok(b, cloud)
    await ok(a, cloud)
    expect(cloud.files).toHaveLength(1)
    expect(await ids(a)).toHaveLength(2)
    expect(await state(a)).toEqual(await state(b))
  })

  it('동기화 중 사용자가 같은 기록을 고치면 그 수정을 덮어쓰지 않는다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    const t = await saveTrip(draft({ line: '1호선', boardTime: '08:00' }), [], a)
    await ok(a, cloud)
    await ok(b, cloud)
    await saveTrip({ ...(await b.trips.get(t.id))!, crowding: 'crowded' }, undefined, b)
    await ok(b, cloud)
    // A 는 B 의 수정(혼잡도)을 받아야 하는데, 쓰기 직전에 사용자가 같은 기록을 고친다
    await saveTrip({ ...(await a.trips.get(t.id))!, note: '입력 중' }, undefined, a)
    // (A 의 수정이 push 이므로 pull 과 겹치게 하려면 pull 대상이 따로 있어야 한다)
    const t2 = await saveTrip(draft({ line: '2호선', boardTime: '09:00' }), [], b)
    await ok(b, cloud)
    cloud.onBeforeUpdate = async () => {
      cloud.onBeforeUpdate = undefined
      await saveTrip({ ...(await a.trips.get(t.id))!, note: '동기화 중에 또 수정' }, undefined, a)
    }
    await ok(a, cloud)
    expect((await a.trips.get(t.id))?.note).toBe('동기화 중에 또 수정')
    await ok(a, cloud)
    await ok(b, cloud)
    expect((await b.trips.get(t.id))?.note).toBe('동기화 중에 또 수정')
    expect((await b.trips.get(t.id))?.crowding).toBe('crowded')
    expect((await a.trips.get(t2.id))?.line).toBe('2호선')
  })
})

describe('동기화 엔진 — 손상·호환·계정', () => {
  it('Drive 파일이 손상되었으면 확인 없이는 덮어쓰지 않는다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await saveTrip(draft({ line: '1호선' }), [], a)
    await ok(a, cloud)
    cloud.overwrite('{ 깨진 json')
    const damaged = cloud.text
    const r = await sync(a, cloud)
    expect(r.kind).toBe('confirm')
    if (r.kind === 'confirm') expect(r.request.kind).toBe('remote-corrupt')
    expect(cloud.text).toBe(damaged)
    expect(await a.trips.count()).toBe(1)
    // 사용자가 승인하면 이 기기 기록으로 다시 만든다
    await ok(a, cloud, { rebuildRemote: true })
    expect(Object.keys(cloud.doc.records)).toHaveLength(1)
  })

  it('일부 기록이 손상된 파일도 같은 방식으로 멈춘다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await ok(a, cloud)
    cloud.overwrite(JSON.stringify({ app: 'TransitLog', kind: 'sync', formatVersion: 1, schemaVersion: 1, revision: 1, writtenAt: '', writtenBy: 'x', records: { 'trips:x': { k: 'trips:x', table: 'trips', id: 'x', ts: 1, data: { nope: 1 } } } }))
    const r = await sync(a, cloud)
    expect(r.kind).toBe('confirm')
  })

  it('더 새로운 형식의 Drive 파일은 건드리지 않고 업데이트를 안내한다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await ok(a, cloud)
    cloud.overwrite(JSON.stringify({ app: 'TransitLog', kind: 'sync', formatVersion: 99, schemaVersion: 1, revision: 1, writtenAt: '', writtenBy: 'x', records: {} }))
    const before = cloud.text
    await expect(sync(a, cloud)).rejects.toBeInstanceOf(RemoteTooNewError)
    expect(cloud.text).toBe(before)
  })

  it('다른 계정으로 바꾸면 확인 전에는 아무것도 올리지 않고, 확인하면 이전 계정과의 기준을 버린다', async () => {
    const cloud1 = new FakeCloud()
    const a = newDevice()
    await saveTrip(draft({ line: '1호선' }), [], a)
    await ok(a, cloud1)
    expect(await a.syncBase.count()).toBe(1)

    const cloud2 = new FakeCloud()
    cloud2.permissionId = 'perm-2'
    cloud2.email = 'other@example.test'
    const r = await sync(a, cloud2)
    expect(r.kind).toBe('confirm')
    if (r.kind === 'confirm') {
      expect(r.request.kind).toBe('account')
      expect(r.request.previousAccount).toBe('tester@example.test')
    }
    expect(cloud2.files).toHaveLength(0)
    await ok(a, cloud2, { confirmAccount: true })
    expect(Object.values(cloud2.doc.records)).toHaveLength(1)
    expect(await getMeta(a, 'accountId', null)).toBe('perm-2')
    expect(await a.trips.count()).toBe(1) // 이 기기의 기록은 그대로
  })

  it('연결 해제(동기화 상태 삭제)는 기록을 지우지 않는다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await saveTrip(draft({ line: '1호선' }), [], a)
    await ok(a, cloud)
    await clearSyncState(a)
    expect(await a.trips.count()).toBe(1)
    expect(await a.syncBase.count()).toBe(0)
    // 다시 연결하면 중복 없이 합쳐진다
    const r = await runSync({ db: a, drive: cloud.api() })
    expect(r.kind).toBe('confirm')
    const done = await ok(a, cloud)
    expect(done.stats.unchanged).toBe(1)
    expect(Object.values(cloud.doc.records)).toHaveLength(1)
  })

  it('동기화 상태는 백업 파일에 들어가지 않는다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    await saveTrip(draft({ line: '1호선' }), [], a)
    await ok(a, cloud)
    const b = await buildBackup(a)
    expect(Object.keys(b.data).sort()).toEqual(['days', 'seatEvents', 'settings', 'templates', 'trips'])
    expect(JSON.stringify(b)).not.toContain('tester@example.test')
    expect(JSON.stringify(b)).not.toContain('perm-1')
  })
})

describe('동기화 엔진 — 데이터 보호', () => {
  async function seeded(n: number) {
    const cloud = new FakeCloud()
    const a = newDevice()
    for (let i = 0; i < n; i++) await saveTrip(draft({ line: '1호선', boardTime: `08:${String(i).padStart(2, '0')}`, boardPlace: `역${i}` }), [], a)
    await ok(a, cloud)
    return { cloud, a }
  }

  it('이 기기의 기록을 한꺼번에 지우면 Drive 에 반영하기 전에 확인을 요구한다', async () => {
    const { cloud, a } = await seeded(20)
    const before = cloud.text
    await deleteAllData(a)
    const r = await sync(a, cloud)
    expect(r.kind).toBe('confirm')
    if (r.kind === 'confirm') {
      expect(r.request.kind).toBe('bulk-delete')
      expect(r.request.deleteCount).toBe(20)
      expect(r.request.bulkDirection).toBe('push')
    }
    expect(cloud.text).toBe(before) // Drive 는 그대로
  })

  it('‘삭제하지 않고 Drive 의 기록을 다시 받기’를 고르면 기록이 돌아온다', async () => {
    const { cloud, a } = await seeded(20)
    await deleteAllData(a)
    await ok(a, cloud, { bulkDelete: 'revert' })
    expect(await a.trips.count()).toBe(20)
    expect(Object.values(cloud.doc.records).filter((r) => !r.deleted)).toHaveLength(20)
  })

  it('삭제를 승인하면 묘비가 올라가고, 다른 기기는 다시 확인을 거쳐 반영한다', async () => {
    const { cloud, a } = await seeded(20)
    const b = newDevice()
    await ok(b, cloud)
    expect(await b.trips.count()).toBe(20)
    await deleteAllData(a)
    await ok(a, cloud, { bulkDelete: 'apply' })
    expect(Object.values(cloud.doc.records).every((r) => r.deleted)).toBe(true)
    const r = await sync(b, cloud)
    expect(r.kind).toBe('confirm')
    if (r.kind === 'confirm') expect(r.request.bulkDirection).toBe('pull')
    expect(await b.trips.count()).toBe(20) // 승인 전에는 그대로
    // 반영하지 않고 이 기기의 기록을 유지하면 Drive 에도 되살아난다
    await ok(b, cloud, { bulkDelete: 'revert' })
    expect(await b.trips.count()).toBe(20)
    expect(Object.values(cloud.doc.records).filter((x) => !x.deleted)).toHaveLength(20)
  })

  it('소수의 삭제는 확인 없이 전달된다', async () => {
    const { cloud, a } = await seeded(20)
    const first = (await a.trips.toArray())[0]
    await deleteTrip(first.id, a)
    const r = await ok(a, cloud)
    expect(r.stats.pushedDeleted).toBe(1)
  })

  it('이 기기의 기록을 바꾸는 동기화 전에는 복구용 사본을 남기고 최근 3개만 유지한다', async () => {
    const { cloud, a } = await seeded(2)
    const b = newDevice()
    await ok(b, cloud) // 처음 연결(사본 1)
    expect((await b.syncSnapshots.toArray())[0].counts.trips).toBe(0)
    for (let i = 0; i < 4; i++) {
      await saveTrip(draft({ line: '2호선', boardTime: `10:0${i}`, boardPlace: `새역${i}` }), [], a)
      await ok(a, cloud)
      await ok(b, cloud) // 받아오기 전 사본
    }
    const snaps = await b.syncSnapshots.toArray()
    expect(snaps).toHaveLength(3)
    // 가장 최근 사본은 마지막 동기화 직전(=3건)의 상태를 담고 있고, 그대로 복원 가능한 백업 형식이다
    const latest = snaps.sort((x, y) => y.at - x.at)[0]
    const parsed = JSON.parse(latest.json)
    expect(parsed.app).toBe('TransitLog')
    expect(parsed.data.trips.length).toBeGreaterThanOrEqual(5)
  })

  it('좌석 변화만 한쪽에서 추가해도 부모 탑승 없이 고아가 되지 않는다', async () => {
    const cloud = new FakeCloud()
    const a = newDevice()
    const b = newDevice()
    const t = await saveTrip(draft({ line: '1호선', boardTime: '08:00', initialSeat: 'standing' }), [], a)
    await ok(a, cloud)
    await ok(b, cloud)
    await saveTrip(await b.trips.get(t.id).then((x) => x!), [{ time: '08:10', state: 'seated', place: '가역' }], b)
    await ok(b, cloud)
    await ok(a, cloud)
    const evs = await a.seatEvents.toArray()
    expect(evs).toHaveLength(1)
    expect(evs[0].tripId).toBe(t.id)
  })
})
