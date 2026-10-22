import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { TransitDB } from '../src/db/db'
import { SCHEMA_VERSION } from '../src/domain/types'
import { mkTrip } from './helpers'

/**
 * 앱 업데이트 때 기존 IndexedDB 데이터가 보존되는지 확인한다.
 * V1 스키마 정의는 '배포된 첫 버전' 그대로 고정한 스냅숏이다. 스키마를 바꿀 때는 이 스냅숏을 지우지 말고
 * TransitDB 에 version(n+1) 과 upgrade() 를 추가한 뒤, 이 테스트가 계속 통과하는지 확인한다.
 */
class V1Snapshot extends Dexie {
  constructor(name: string) {
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

describe('스키마 호환(앱 업데이트)', () => {
  it('v1 로 저장된 데이터를 현재 코드가 그대로 열어 읽는다', async () => {
    const name = `compat-${Math.random()}`
    const old = new V1Snapshot(name)
    const t = mkTrip({ line: '1호선', boardTime: '08:00', note: '보존 확인' })
    await old.table('trips').add(t)
    await old.table('seatEvents').add({ id: 'e1', tripId: t.id, time: '08:10', state: 'seated', place: null, createdAt: 1 })
    await old.table('days').add({ date: t.date, homeDepart: '07:50', schoolDepart: null, schoolArrive: null, homeArrive: null, note: null, updatedAt: 1 })
    await old.table('settings').add({ key: 'lastBackupAt', value: 123 })
    old.close()

    const now = new TransitDB(name)
    expect(await now.trips.get(t.id)).toEqual(t)
    expect(await now.seatEvents.count()).toBe(1)
    expect((await now.days.get(t.date))?.homeDepart).toBe('07:50')
    expect((await now.settings.get('lastBackupAt'))?.value).toBe(123)
    // 같은 DB 를 현재 코드로 열어도 버전이 낮아지거나 비워지지 않는다
    expect(now.verno).toBeGreaterThanOrEqual(1)
    now.close()
  })

  it('앱 시작 경로(db 모듈 로드)가 데이터를 지우지 않는다', async () => {
    const name = `compat2-${Math.random()}`
    const a = new TransitDB(name)
    await a.trips.add(mkTrip({ line: '2호선' }))
    a.close()
    const b = new TransitDB(name)
    await b.open()
    expect(await b.trips.count()).toBe(1)
    b.close()
  })

  it('백업 스키마 버전은 DB 스키마 버전과 함께 관리된다', () => {
    expect(SCHEMA_VERSION).toBe(1)
  })
})
