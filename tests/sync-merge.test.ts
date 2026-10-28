import { describe, expect, it } from 'vitest'
import { keyOf, mergeStates, sig, stable } from '../src/sync/merge'
import type { RemoteRecord, SyncData } from '../src/sync/types'
import { mkEvent, mkTrip } from './helpers'

const kt = (id: string) => keyOf('trips', id)
const ke = (id: string) => keyOf('seatEvents', id)
const L = (...rows: Array<[string, SyncData]>) => new Map(rows)
const live = (k: string, data: SyncData): RemoteRecord => ({ k, table: k.startsWith('trips') ? 'trips' : k.startsWith('seatEvents') ? 'seatEvents' : 'days', id: k.slice(k.indexOf(':') + 1), ts: 1, data })
const tomb = (k: string): RemoteRecord => ({ k, table: 'trips', id: k.slice(k.indexOf(':') + 1), ts: 1, deleted: true })
const run = (local: Map<string, SyncData>, remote: Record<string, RemoteRecord>, base: Map<string, SyncData> = new Map()) => mergeStates({ local, remote, base, now: 99 })
const trip = (id: string, p: Record<string, unknown> = {}) => ({ ...mkTrip({ id }), ...p }) as unknown as SyncData

describe('동기화 병합 — 기본', () => {
  it('서명은 다시 저장해도 바뀌는 값(updatedAt)을 무시하고 키 순서와 무관하다', () => {
    const a = trip('a', { updatedAt: 1 })
    const b = { ...a, updatedAt: 999 }
    expect(sig('trips', a)).toBe(sig('trips', b))
    expect(stable({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(stable({ a: [2, { d: 1 }], b: 1 }))
  })

  it('이 기기에만 있는 기록은 Drive 로 올리고, Drive 에만 있는 기록은 이 기기로 받는다', () => {
    const a = trip('a', { line: '1호선' })
    const b = trip('b', { line: '2호선' })
    const r = run(L([kt('a'), a]), { [kt('b')]: live(kt('b'), b) })
    expect(r.stats.pushedNew).toBe(1)
    expect(r.stats.pulledNew).toBe(1)
    expect([...r.localPut.keys()]).toEqual([kt('b')])
    expect(Object.keys(r.remoteRecords).sort()).toEqual([kt('a'), kt('b')])
    expect(r.localDelete.size).toBe(0)
  })

  it('양쪽 내용이 같으면 아무것도 하지 않는다 (같은 내용 중복 업로드 없음)', () => {
    const a = trip('a')
    const r = run(L([kt('a'), a]), { [kt('a')]: live(kt('a'), { ...a, updatedAt: 5000 }) })
    expect(r.remoteChanged).toBe(false)
    expect(r.localPut.size + r.localDelete.size).toBe(0)
    expect(r.stats.unchanged).toBe(1)
  })

  it('한쪽만 수정하면 그 수정을 따른다', () => {
    const base = trip('a', { note: 'v1' })
    const edited = { ...base, note: 'v2' }
    const pushOnly = run(L([kt('a'), edited]), { [kt('a')]: live(kt('a'), base) }, L([kt('a'), base]))
    expect(pushOnly.stats.pushedChanged).toBe(1)
    expect(pushOnly.localPut.size).toBe(0)
    const pullOnly = run(L([kt('a'), base]), { [kt('a')]: live(kt('a'), edited) }, L([kt('a'), base]))
    expect(pullOnly.stats.pulledChanged).toBe(1)
    expect(pullOnly.localPut.get(kt('a'))?.note).toBe('v2')
  })
})

describe('동기화 병합 — 충돌', () => {
  const base = trip('a', { note: 'n0', crowding: null, line: '1호선' })

  it('서로 다른 항목을 고쳤다면 충돌 없이 둘 다 반영한다', () => {
    const local = { ...base, note: '내 메모' }
    const remote = { ...base, crowding: 'crowded' }
    const r = run(L([kt('a'), local]), { [kt('a')]: live(kt('a'), remote) }, L([kt('a'), base]))
    const merged = r.nextBase.get(kt('a'))!
    expect(merged.note).toBe('내 메모')
    expect(merged.crowding).toBe('crowded')
    expect(r.conflicts).toHaveLength(0)
    expect(r.localPut.has(kt('a'))).toBe(true)
    expect(r.remoteChanged).toBe(true)
  })

  it('같은 항목을 다르게 고치면 한쪽을 남기고 밀려난 값을 충돌로 보존한다', () => {
    const local = { ...base, note: '나', updatedAt: 5000 }
    const remote = { ...base, note: '상대', updatedAt: 4000 }
    const r = run(L([kt('a'), local]), { [kt('a')]: live(kt('a'), remote) }, L([kt('a'), base]))
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].fields).toEqual([{ name: 'note', local: '나', remote: '상대', kept: 'local' }])
    expect(r.nextBase.get(kt('a'))?.note).toBe('나')
  })

  it('어느 기기에서 병합해도 같은 결과가 나온다 (대칭)', () => {
    const x = { ...base, note: 'X', updatedAt: 7000 }
    const y = { ...base, note: 'Y', updatedAt: 7000, line: '2호선' }
    const onA = run(L([kt('a'), x]), { [kt('a')]: live(kt('a'), y) }, L([kt('a'), base]))
    const onB = run(L([kt('a'), y]), { [kt('a')]: live(kt('a'), x) }, L([kt('a'), base]))
    expect(stable(onA.nextBase.get(kt('a')))).toBe(stable(onB.nextBase.get(kt('a'))))
  })

  it('기준 없이 같은 식별자가 다른 내용으로 양쪽에 있으면 병합하고 충돌로 남긴다', () => {
    const r = run(L([kt('a'), { ...base, note: '나' }]), { [kt('a')]: live(kt('a'), { ...base, note: '상대' }) })
    expect(r.conflicts).toHaveLength(1)
    expect(r.localPut.size + (r.remoteChanged ? 1 : 0)).toBeGreaterThan(0)
  })

  it('좌석 변화가 충돌하면 부모 탑승이 더 나중에 바뀐 쪽을 남긴다', () => {
    const tripBase = trip('t', { updatedAt: 100 })
    const ev = mkEvent('t', { id: 'ev', state: 'seated', time: '08:10' }) as unknown as SyncData
    const remoteTrip = { ...tripBase, updatedAt: 900 }
    const r = mergeStates({
      local: L([kt('t'), tripBase], [ke('ev'), { ...ev, time: '08:11' }]),
      remote: { [kt('t')]: live(kt('t'), remoteTrip), [ke('ev')]: live(ke('ev'), { ...ev, time: '08:12' }) },
      base: L([kt('t'), tripBase], [ke('ev'), ev]),
      now: 1,
    })
    expect(r.nextBase.get(ke('ev'))?.time).toBe('08:12')
    expect(r.conflicts.some((c) => c.k === ke('ev'))).toBe(true)
  })
})

describe('동기화 병합 — 삭제', () => {
  const a = trip('a', { note: 'x' })

  it('이 기기에서 지우면(기준에는 있음) 묘비로 전달한다', () => {
    const r = run(L(), { [kt('a')]: live(kt('a'), a) }, L([kt('a'), a]))
    expect(r.stats.pushedDeleted).toBe(1)
    expect(r.remoteRecords[kt('a')].deleted).toBe(true)
    expect(r.nextBase.has(kt('a'))).toBe(false)
  })

  it('다른 기기의 삭제(묘비)는 이 기기에서 바뀌지 않은 기록에만 적용된다', () => {
    const r = run(L([kt('a'), a]), { [kt('a')]: tomb(kt('a')) }, L([kt('a'), a]))
    expect(r.localDelete.has(kt('a'))).toBe(true)
    expect(r.stats.pulledDeleted).toBe(1)
  })

  it('다른 기기가 삭제했지만 이 기기에서 수정했다면 삭제하지 않고 되살려 올리고 충돌로 알린다', () => {
    const edited = { ...a, note: '수정함' }
    const r = run(L([kt('a'), edited]), { [kt('a')]: tomb(kt('a')) }, L([kt('a'), a]))
    expect(r.localDelete.size).toBe(0)
    expect(r.remoteRecords[kt('a')].deleted).toBeUndefined()
    expect(r.remoteRecords[kt('a')].data?.note).toBe('수정함')
    expect(r.conflicts[0]?.kind).toBe('deleted-remote')
  })

  it('이 기기에서 지웠지만 다른 기기가 수정했다면 수정본을 남긴다', () => {
    const r = run(L(), { [kt('a')]: live(kt('a'), { ...a, note: '상대 수정' }) }, L([kt('a'), a]))
    expect(r.localPut.get(kt('a'))?.note).toBe('상대 수정')
    expect(r.conflicts[0]?.kind).toBe('deleted-local')
  })

  it('Drive 에서 기록이 묘비 없이 사라졌다면 삭제가 아니라 유실로 보고 다시 올린다', () => {
    const r = run(L([kt('a'), a]), {}, L([kt('a'), a]))
    expect(r.localDelete.size).toBe(0)
    expect(r.remoteRecords[kt('a')]?.data).toBeDefined()
  })

  it('백업을 복원해 같은 식별자로 돌아온 기록은 묘비보다 우선한다', () => {
    const r = run(L([kt('a'), a]), { [kt('a')]: tomb(kt('a')) })
    expect(r.localDelete.size).toBe(0)
    expect(r.remoteRecords[kt('a')].deleted).toBeUndefined()
    expect(r.conflicts).toHaveLength(0)
  })

  it('삭제된 탑승에 달린 좌석 변화는 정리된다', () => {
    const e = mkEvent('a', { id: 'e1' }) as unknown as SyncData
    const r = run(L([kt('a'), a], [ke('e1'), e]), { [kt('a')]: tomb(kt('a')), [ke('e1')]: live(ke('e1'), e) }, L([kt('a'), a], [ke('e1'), e]))
    expect(r.localDelete.has(kt('a'))).toBe(true)
    expect(r.localDelete.has(ke('e1'))).toBe(true)
  })
})

describe('동기화 병합 — 중복', () => {
  it('식별자만 다르고 내용이 완전히 같은 새 탑승(좌석 변화 포함)은 하나로 합친다', () => {
    const base = { line: '1호선', boardPlace: '가역', boardTime: '08:00' }
    const a = trip('aaa', base)
    const b = trip('bbb', base)
    const ea = mkEvent('aaa', { id: 'ea', time: '08:05' }) as unknown as SyncData
    const eb = mkEvent('bbb', { id: 'eb', time: '08:05' }) as unknown as SyncData
    const r = run(L([kt('aaa'), a], [ke('ea'), ea]), { [kt('bbb')]: live(kt('bbb'), b), [ke('eb')]: live(ke('eb'), eb) })
    expect(r.stats.deduped).toBe(1)
    expect(r.remoteRecords[kt('bbb')].deleted).toBe(true)
    expect(r.remoteRecords[ke('eb')].deleted).toBe(true)
    expect(r.nextBase.has(kt('aaa'))).toBe(true)
    expect(r.nextBase.has(kt('bbb'))).toBe(false)
  })

  it('내용이 조금이라도 다르면 중복으로 보지 않는다', () => {
    const r = run(L([kt('aaa'), trip('aaa', { line: '1호선' })]), { [kt('bbb')]: live(kt('bbb'), trip('bbb', { line: '1호선', note: '다름' })) })
    expect(r.stats.deduped).toBe(0)
    expect(r.nextBase.size).toBe(2)
  })

  it('이미 동기화된(기준에 있는) 기록은 중복 정리 대상이 아니다', () => {
    const a = trip('aaa', { line: '1호선' })
    const b = trip('bbb', { line: '1호선' })
    const r = run(L([kt('aaa'), a], [kt('bbb'), b]), { [kt('aaa')]: live(kt('aaa'), a), [kt('bbb')]: live(kt('bbb'), b) }, L([kt('aaa'), a], [kt('bbb'), b]))
    expect(r.stats.deduped).toBe(0)
  })
})
