import { describe, expect, it } from 'vitest'
import { mkEvent, mkTrip } from './helpers'
import { seatCardInfo, seatChangePath } from '../src/domain/seatCard'

describe('카드의 착석 상태 강조', () => {
  it('처음부터 앉은 기록은 즉시 착석으로 표시한다', () => {
    const t = mkTrip({ initialSeat: 'seated', alightTime: '09:00', boardTime: '08:00' })
    expect(seatCardInfo(t, [])).toMatchObject({ label: '처음부터 착석', tone: 'seated' })
  })
  it('중간 착석은 실제 시각으로 계산된 소요 시간을 표시한다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '09:00' })
    expect(seatCardInfo(t, [mkEvent(t.id, { time: '08:12', state: 'seated' })])).toMatchObject({ label: '12분 후 착석', tone: 'mid' })
  })
  it('시간을 모르는 중간 착석의 경과 시간을 추측하지 않는다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '09:00' })
    expect(seatCardInfo(t, [mkEvent(t.id, { time: null, state: 'seated' })])).toMatchObject({ label: '중간 착석', detail: '착석 소요 시간 미확인' })
  })
  it('종료된 서서 탑승은 하차 시각이 없어도 끝까지 서서 이동으로 표시한다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '21:54', alightTime: null, ongoing: false, seatLogComplete: null })
    expect(seatCardInfo(t, [])).toMatchObject({ label: '끝까지 서서 이동', tone: 'standing' })
  })
  it('하차가 확인된 기록만 끝까지 서 있었다고 표시한다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '09:00', ongoing: false })
    expect(seatCardInfo(t, [])).toMatchObject({ label: '끝까지 서서 이동', tone: 'standing' })
  })
  it('처음부터 착석한 뒤 일어섰다면 중간 기립으로 표시한다', () => {
    const t = mkTrip({ initialSeat: 'seated', ongoing: false })
    expect(seatCardInfo(t, [mkEvent(t.id, { state: 'standing' })])).toMatchObject({ label: '중간 기립', tone: 'standing' })
  })

  it('탑승 중에는 최종 결과 대신 현재 좌석을 보여준다', () => {
    const t = mkTrip({ initialSeat: 'standing', ongoing: true, boardTime: '08:00' })
    const events = [mkEvent(t.id, { time: '08:10', state: 'seated' })]
    expect(seatCardInfo(t, events)).toMatchObject({ label: '현재 앉아 있음' })
    expect(seatCardInfo(t, [])).toMatchObject({ label: '현재 서 있음' })
  })
  it('탑승 시 좌석을 모르면 추정하지 않고 기록 여부만 표시한다', () => {
    const t = mkTrip({ initialSeat: null, boardTime: '08:00', alightTime: '09:00' })
    expect(seatCardInfo(t, [mkEvent(t.id, { state: 'seated' })])).toMatchObject({ label: '착석 기록 있음', detail: '탑승 시 좌석 미기록' })
    expect(seatCardInfo(t, [])).toMatchObject({ label: '좌석 미기록' })
  })
  it('여러 상태 변화는 같은 순서로 요약한다', () => {
    const t = mkTrip({ initialSeat: 'standing', boardTime: '08:00', alightTime: '09:00' })
    const e = [mkEvent(t.id, { time: '08:10', state: 'seated' }), mkEvent(t.id, { time: '08:15', state: 'standing' }), mkEvent(t.id, { time: '08:20', state: 'seated' })]
    expect(seatChangePath(t, e)).toBe('서서 → 착석 → 기립 → 착석')
  })
  it('관찰·놓침에는 착석 표시를 만들지 않는다', () => {
    expect(seatCardInfo(mkTrip({ kind: 'observed' }), [])).toBeNull()
    expect(seatCardInfo(mkTrip({ kind: 'missed' }), [])).toBeNull()
  })
})
