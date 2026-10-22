import { useMemo, useState } from 'react'
import { addDays, formatDuration, todayStr } from '../domain/time'
import {
  activityCounts,
  averageDuration,
  averageMinutesToFirstSeat,
  averageStandingMinutes,
  byCar,
  byCarDoor,
  byHourBucket,
  byLine,
  byMode,
  byRoute,
  byTrainDestination,
  byWeekday,
  crowdingDistribution,
  rideRows,
  ridesPerDay,
  ridesPerMonth,
  ridesPerWeek,
  seatRatios,
  type Group,
  type RideRow,
} from '../domain/stats'
import { CROWDING_LABEL, type Crowding } from '../domain/types'
import { Chip, Empty, Ratio, Section, destLabel } from '../ui/common'
import { useAllEvents, useAllTrips } from '../ui/hooks'

type Period = 'all' | '30' | '90'
type Bucket = 'day' | 'week' | 'month'

function Bars({ items, max }: { items: Array<{ key: string; count: number }>; max?: number }) {
  const m = max ?? Math.max(1, ...items.map((i) => i.count))
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.key}>
          <span className="bar-label">{i.key}</span>
          <span className="bar">
            <span style={{ width: `${(i.count / m) * 100}%` }} />
          </span>
          <span className="bar-n">{i.count}</span>
        </li>
      ))}
    </ul>
  )
}

/** 비율의 분모가 전체 탑승 중 얼마인지 보여 줘, 판정 가능한 기록만 센 값임을 드러낸다 */
function Coverage({ den, total }: { den: number; total: number }) {
  if (total === 0 || den === total) return null
  return (
    <span className="muted small">
      {' '}
      · 전체 {total}건 중 {den}건만 판정 가능
    </span>
  )
}

function GroupTable({ groups, limit = 10, labelOf }: { groups: Group[]; limit?: number; labelOf?: (k: string) => string }) {
  if (groups.length === 0) return <Empty>표시할 데이터가 없습니다. (값이 기록된 탑승만 집계합니다)</Empty>
  return (
    <div className="table" role="table">
      <div className="tr th" role="row">
        <span role="columnheader">구분</span>
        <span role="columnheader">탑승</span>
        <span role="columnheader">즉시 착석</span>
        <span role="columnheader">한 번이라도</span>
      </div>
      {groups.slice(0, limit).map((g) => (
        <div className="tr" role="row" key={g.key}>
          <span role="cell" className="k">
            {labelOf ? labelOf(g.key) : g.key}
            {g.count < 5 && <em className="small-n">표본 적음</em>}
          </span>
          <span role="cell">{g.count}</span>
          <span role="cell">
            <Ratio num={g.seat.immediate.num} den={g.seat.immediate.den} />
          </span>
          <span role="cell">
            <Ratio num={g.seat.everSeated.num} den={g.seat.everSeated.den} />
          </span>
        </div>
      ))}
      {groups.length > limit && <div className="muted small">상위 {limit}개만 표시 (전체 {groups.length}개)</div>}
    </div>
  )
}

export function StatsPage() {
  const trips = useAllTrips()
  const events = useAllEvents()
  const [period, setPeriod] = useState<Period>('all')
  const [bucket, setBucket] = useState<Bucket>('week')

  const { rows, counts } = useMemo(() => {
    const from = period === 'all' ? '0000-00-00' : addDays(todayStr(), -Number(period))
    const inPeriod = (trips ?? []).filter((t) => t.date >= from)
    return { rows: rideRows(inPeriod, events ?? []), counts: activityCounts(inPeriod) }
  }, [trips, events, period])

  if (!trips || !events) return <div className="page"><p className="muted">불러오는 중…</p></div>

  const seat = seatRatios(rows)
  const dur = averageDuration(rows)
  const toSeat = averageMinutesToFirstSeat(rows)
  const standing = averageStandingMinutes(rows)
  const crowd = crowdingDistribution(rows)
  const per = bucket === 'day' ? ridesPerDay(rows) : bucket === 'week' ? ridesPerWeek(rows) : ridesPerMonth(rows)
  const perShown = bucket === 'day' ? per.slice(-14) : per.slice(-12)
  const subwayRows: RideRow[] = rows.filter((r) => r.trip.mode === 'subway')
  const modeGroups = byMode(rows)

  return (
    <div className="page">
      <header className="page-head">
        <h1>통계</h1>
        <div className="muted">값이 기록된 탑승만 집계하고, 모든 비율에 표본 수를 함께 표시합니다.</div>
      </header>

      <div className="chips filter" role="group" aria-label="기간">
        {([['all', '전체'], ['90', '최근 90일'], ['30', '최근 30일']] as Array<[Period, string]>).map(([p, l]) => (
          <Chip key={p} value={p} selected={period === p} onSelect={setPeriod} small>
            {l}
          </Chip>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty>이 기간에 탑승 기록이 없습니다. 기록이 쌓이면 통계가 표시됩니다.</Empty>
      ) : (
        <>
          <Section title="요약">
            <dl className="totals">
              <div>
                <dt>탑승</dt>
                <dd>{counts.ride}회</dd>
              </div>
              <div>
                <dt>놓침·탑승 실패</dt>
                <dd>{counts.missed}건</dd>
              </div>
              <div>
                <dt>관찰만</dt>
                <dd>{counts.observed}건</dd>
              </div>
            </dl>
            <p className="hint">놓침·관찰 기록은 이동 횟수와 착석률 계산에 포함하지 않습니다.</p>
          </Section>

          <Section title="착석 지표">
            <dl className="metrics">
              <div>
                <dt>즉시 착석률</dt>
                <dd>
                  <Ratio num={seat.immediate.num} den={seat.immediate.den} />
                  <Coverage den={seat.immediate.den} total={rows.length} />
                </dd>
                <dd className="def">탑승 시점에 이미 앉았던 비율 (탑승 시 좌석이 기록된 탑승 기준)</dd>
              </div>
              <div>
                <dt>한 번이라도 착석한 비율</dt>
                <dd>
                  <Ratio num={seat.everSeated.num} den={seat.everSeated.den} />
                  <Coverage den={seat.everSeated.den} total={rows.length} />
                </dd>
                <dd className="def">탑승 중 한 번이라도 앉은 비율. 앉은 기록과 ‘끝까지 서 있었음(변화 없음)’이 확인된 기록만 집계하므로, 서서 탄 뒤 변화 여부를 확인하지 않은 기록은 빠집니다</dd>
              </div>
              <div>
                <dt>최종 착석률</dt>
                <dd>
                  <Ratio num={seat.final.num} den={seat.final.den} />
                  <Coverage den={seat.final.den} total={rows.length} />
                </dd>
                <dd className="def">하차 직전 앉아 있던 비율 (좌석 변화 기록이 완결된 탑승만)</dd>
              </div>
              <div>
                <dt>서서 탄 뒤 착석까지 평균</dt>
                <dd>{toSeat.avg === null ? '—' : formatDuration(Math.round(toSeat.avg))} <span className="muted">(표본 {toSeat.n})</span></dd>
                <dd className="def">서서 탑승 → 첫 착석, 두 시각이 모두 있는 탑승만</dd>
              </div>
              <div>
                <dt>서서 이동한 시간 평균</dt>
                <dd>{standing.avg === null ? '—' : formatDuration(Math.round(standing.avg))} <span className="muted">(표본 {standing.n})</span></dd>
                <dd className="def">좌석 변화 기록 완결 + 승·하차·변화 시각이 모두 있는 탑승만</dd>
              </div>
              <div>
                <dt>평균 탑승 시간</dt>
                <dd>{dur.avg === null ? '—' : formatDuration(Math.round(dur.avg))} <span className="muted">(표본 {dur.n})</span></dd>
                <dd className="def">환승·대기·도보 제외, 승·하차 시각이 있는 탑승만</dd>
              </div>
            </dl>
          </Section>

          <Section title="탑승 횟수">
            <div className="chips filter" role="group" aria-label="집계 단위">
              {([['day', '일별'], ['week', '주별'], ['month', '월별']] as Array<[Bucket, string]>).map(([b, l]) => (
                <Chip key={b} value={b} selected={bucket === b} onSelect={setBucket} small>
                  {l}
                </Chip>
              ))}
            </div>
            <Bars items={perShown} />
            <p className="hint">{bucket === 'week' ? '주 시작: 월요일 날짜' : ''}</p>
          </Section>

          <Section title="노선별 이용">
            <GroupTable groups={byLine(rows)} />
          </Section>
          <Section title="구간별 이용">
            <GroupTable groups={byRoute(rows)} />
          </Section>
          <Section title="요일별 착석률">
            <GroupTable groups={byWeekday(rows)} limit={7} />
          </Section>
          <Section title="시간대별 착석률">
            <GroupTable groups={byHourBucket(rows)} limit={7} />
          </Section>
          <Section title="열차 행선지별 착석률">
            <GroupTable groups={byTrainDestination(subwayRows)} labelOf={destLabel} />
          </Section>
          <Section title="칸별 착석률">
            <GroupTable groups={byCar(subwayRows)} limit={12} />
          </Section>
          <Section title="칸·문 위치별 착석률">
            <GroupTable groups={byCarDoor(subwayRows)} />
          </Section>

          <Section title="혼잡도 분포">
            {crowd.n === 0 ? (
              <Empty>혼잡도가 기록된 탑승이 없습니다.</Empty>
            ) : (
              <>
                <Bars items={(Object.keys(CROWDING_LABEL) as Crowding[]).map((c) => ({ key: CROWDING_LABEL[c], count: crowd.dist[c] }))} max={crowd.n} />
                <p className="hint">혼잡도가 기록된 {crowd.n}건 기준 (전체 {rows.length}건 중)</p>
              </>
            )}
          </Section>

          <Section title="버스와 지하철 비교">
            <GroupTable groups={modeGroups} limit={2} />
            <dl className="totals">
              {modeGroups.map((g) => {
                const sub = rows.filter((r) => (r.trip.mode === 'subway' ? '지하철' : '버스') === g.key)
                const d = averageDuration(sub)
                return (
                  <div key={g.key}>
                    <dt>{g.key} 평균 탑승 시간</dt>
                    <dd>
                      {d.avg === null ? '—' : formatDuration(Math.round(d.avg))} <span className="muted">(표본 {d.n})</span>
                    </dd>
                  </div>
                )
              })}
            </dl>
          </Section>
        </>
      )}
    </div>
  )
}
