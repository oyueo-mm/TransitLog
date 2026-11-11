import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { addDays, formatDuration, todayStr } from '../domain/time'
import {
  activityCounts,
  averageDuration,
  averageMinutesToFirstSeat,
  averageStandingMinutes,
  byCar,
  byCarDoor,
  byBoardingInterval,
  fillEmptyPeriods,
  type TimeInterval,
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
import { seatCoverage, MIN_SAMPLE } from '../domain/coverage'
import { CROWDING_LABEL, type Crowding } from '../domain/types'
import { Chip, Empty, Ratio, Section, destLabel } from '../ui/common'
import { Bars, SeatMetric } from '../ui/statBits'
import { useAllEvents, useAllTrips } from '../ui/hooks'

type Period = 'all' | '30' | '90' | 'custom'
type Bucket = 'day' | 'week' | 'month'

function GroupTable({ groups, limit = 10, labelOf }: { groups: Group[]; limit?: number; labelOf?: (k: string) => string }) {
  const [showAll, setShowAll] = useState(false)
  if (groups.length === 0) return <Empty>표시할 데이터가 없습니다. (값이 기록된 탑승만 집계합니다)</Empty>
  return (
    <div className="table" role="table">
      <div className="tr th" role="row">
        <span role="columnheader">구분</span>
        <span role="columnheader">탑승</span>
        <span role="columnheader">즉시 착석</span>
        <span role="columnheader">한 번이라도</span>
      </div>
      {groups.slice(0, showAll ? undefined : limit).map((g) => (
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
      {groups.length > limit && <button type="button" className="btn-small" onClick={() => setShowAll(!showAll)}>{showAll ? '접기' : `전체 ${groups.length}개 보기`}</button>}
    </div>
  )
}

export function StatsPage() {
  const trips = useAllTrips()
  const events = useAllEvents()
  const [period, setPeriod] = useState<Period>('all')
  const [bucket, setBucket] = useState<Bucket>('week')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [timeStep, setTimeStep] = useState<TimeInterval>(15)

  const { rows, counts, from, to } = useMemo(() => {
    const today = todayStr()
    const from = period === 'all' ? '' : period === 'custom' ? (customFrom || '') : addDays(today, 1 - Number(period))
    const to = period === 'custom' ? (customTo || '9999-12-31') : period === 'all' ? '9999-12-31' : today
    const inPeriod = from > to ? [] : (trips ?? []).filter((t) => t.date >= from && t.date <= to)
    return { rows: rideRows(inPeriod, events ?? []), counts: activityCounts(inPeriod), from, to }
  }, [trips, events, period, customFrom, customTo])

  if (!trips || !events) return <div className="page"><p className="muted">불러오는 중…</p></div>

  const seat = seatRatios(rows)
  const cov = seatCoverage(rows)
  const dur = averageDuration(rows)
  const toSeat = averageMinutesToFirstSeat(rows)
  const standing = averageStandingMinutes(rows)
  const crowd = crowdingDistribution(rows)
  const per = bucket === 'day' ? ridesPerDay(rows) : bucket === 'week' ? ridesPerWeek(rows) : ridesPerMonth(rows)
  const chartTo = period === 'all' || to === '9999-12-31' ? [...rows.map((r) => r.trip.date)].sort().at(-1) ?? todayStr() : to
  const windowFrom = addDays(chartTo, bucket === 'day' ? -13 : bucket === 'week' ? -83 : -365)
  const chartFrom = from && from > windowFrom ? from : windowFrom
  const perShown = fillEmptyPeriods(per, bucket, chartFrom, chartTo).slice(bucket === 'day' ? -14 : -12)
  const timeGroups = byBoardingInterval(rows, timeStep)
  const subwayRows: RideRow[] = rows.filter((r) => r.trip.mode === 'subway')
  const modeGroups = byMode(rows)

  return (
    <div className="page">
      <header className="page-head">
        <h1>통계</h1>
        <div className="muted">값이 기록된 탑승만 집계하고, 모든 비율에 표본 수를 함께 표시합니다.</div>
      </header>

      <div className="chips filter" role="group" aria-label="기간">
        {([['all', '전체'], ['90', '최근 90일'], ['30', '최근 30일'], ['custom', '기간 지정']] as Array<[Period, string]>).map(([p, l]) => (
          <Chip key={p} value={p} selected={period === p} onSelect={setPeriod} small>
            {l}
          </Chip>
        ))}
      </div>

      {period === 'custom' && <div className="field-row stats-custom-period">
        <label className="field-label" htmlFor="stat-from">시작</label>
        <input id="stat-from" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
        <label className="field-label" htmlFor="stat-to">종료</label>
        <input id="stat-to" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
      </div>}
      <Section title="종합 통계">
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
      {rows.length === 0 ? (
        <Empty>이 기간에 탑승 기록이 없습니다. 놓침·관찰 기록은 위의 종합 통계에 포함됩니다.</Empty>
      ) : (
        <>
          <Section title="좌석 분석">
            <div className="notice sample-overview" role="note">
              <strong>전체 탑승 {cov.total}건</strong> 중 판정 가능한 건수는 지표마다 다릅니다 — 즉시 {seat.immediate.den}건 · 한 번이라도 {seat.everSeated.den}건 · 최종 {seat.final.den}건.
              <details>
                <summary>분모가 서로 다른 이유</summary>
                <ul className="plain small">
                  <li>
                    <strong>즉시 착석률</strong>: 탑승할 때 좌석 상태를 기록한 탑승 중 앉아서 탄 비율입니다.
                  </li>
                  <li>
                    <strong>한 번이라도 착석</strong>: 앉았던 기록과 종료된 뒤에도 한 번도 앉지 않은 기록을 셉니다. 아직 탑승 중인 서서 탑승 기록은 미확인으로 제외합니다.
                  </li>
                  <li>
                    <strong>최종 착석률</strong>: 종료된 탑승의 마지막 기록 좌석 상태를 기준으로 셉니다.
                  </li>
                  <li>하차 여부나 좌석 상태가 불명확한 기록은 임의로 서서/앉아서 이동한 것으로 분류하지 않습니다.</li>
                </ul>
              </details>
            </div>
            <dl className="metrics">
              <SeatMetric
                title="즉시 착석률"
                num={seat.immediate.num}
                den={seat.immediate.den}
                total={cov.total}
                def="탑승 시점에 이미 앉아 있었던 비율 (탑승 시 좌석 상태를 기록한 탑승만)"
                reasons={[['탑승 시 좌석 상태를 기록하지 않음', cov.immediate.unknown]]}
              />
              <SeatMetric
                title="한 번이라도 착석한 비율"
                num={seat.everSeated.num}
                den={seat.everSeated.den}
                total={cov.total}
                bias="하차하지 않은 서서 탑승 기록이 빠져 실제보다 높게 보일 수 있어요"
                def="탑승 중 한 번이라도 앉은 비율. 종료된 기록은 추가 변화가 없으면 마지막 좌석 상태가 유지된 것으로 본다"
                reasons={[
                  ['탑승 중이라 최종 변화가 미확인', cov.ever.unconfirmedStanding],
                  ['좌석 정보가 없음', cov.ever.unknown],
                ]}
              />
              <SeatMetric
                title="최종 착석률"
                num={seat.final.num}
                den={seat.final.den}
                total={cov.total}
                def="종료된 탑승의 마지막 기록 좌석 상태 기준. 하차 시각은 기록된 값만 표시"
                reasons={[['탑승 중이거나 좌석 기록이 부족함', cov.final.unconfirmed]]}
              />
              <div>
                <dt>서서 탄 뒤 착석까지 평균</dt>
                <dd>{toSeat.avg === null ? '—' : formatDuration(Math.round(toSeat.avg))} <span className="muted">(표본 {toSeat.n})</span></dd>
                <dd className="def">서서 탑승 → 첫 착석, 두 시각이 모두 있는 탑승만</dd>
              </div>
              <div>
                <dt>서서 이동한 시간 평균</dt>
                <dd>{standing.avg === null ? '—' : formatDuration(Math.round(standing.avg))} <span className="muted">(표본 {standing.n})</span></dd>
                <dd className="def">하차 완료 + 승·하차·변화 시각이 모두 있는 탑승만</dd>
              </div>
              <div>
                <dt>평균 탑승 시간</dt>
                <dd>{dur.avg === null ? '—' : formatDuration(Math.round(dur.avg))} <span className="muted">(표본 {dur.n})</span></dd>
                <dd className="def">환승·대기·도보 제외, 승·하차 시각으로 계산했거나 소요 시간이 직접 기록된 탑승만</dd>
              </div>
            </dl>
          </Section>

          <Section title="이용 패턴 · 탑승 횟수">
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

          <Section title="시간대별 착석 분석">
            <div className="row-between">
              <p className="hint">탑승 시각 기준. 각 시간대의 판정 가능한 기록만 착석률 분모에 포함합니다.</p>
              <div className="field-row">
                <label className="field-label" htmlFor="stats-step">간격</label>
                <select id="stats-step" value={timeStep} onChange={(e) => setTimeStep(Number(e.target.value) as TimeInterval)}>
                  {[5, 10, 15, 30, 60].map((n) => <option value={n} key={n}>{n === 60 ? '1시간' : `${n}분`}</option>)}
                </select>
              </div>
            </div>
            {timeGroups.length === 0 ? <Empty>탑승 시각이 기록된 건이 없습니다.</Empty> : (
              <div className="time-stat-list">
                <div className="time-stat-head"><span>시간대</span><span>즉시 착석률</span><span>평균 착석 대기</span><span>표본</span></div>
                {timeGroups.map((g) => {
                  const pct = g.seat.immediate.pct
                  const qs = new URLSearchParams({ view: 'list', boardFrom: g.from, boardTo: g.to })
                  if (period !== 'all') {
                    if (from) qs.set('dateFrom', from)
                    if (to && to !== '9999-12-31') qs.set('dateTo', to)
                  }
                  return (
                    <Link key={g.key} to={`/calendar?${qs.toString()}`} className="time-stat-row" title="이 시간대의 탑승 기록 검색">
                      <strong>{g.key}</strong>
                      <span className="time-rate">
                        <span className="time-rate-track"><span style={{ width: `${pct ?? 0}%` }} /></span>
                        <span>{pct === null ? '—' : `${Math.round(pct)}%`}</span>
                      </span>
                      <span>{g.toSeat.avg === null ? '—' : formatDuration(Math.round(g.toSeat.avg))}</span>
                      <span>{g.seat.immediate.num}/{g.seat.immediate.den}{g.seat.immediate.den > 0 && g.seat.immediate.den < MIN_SAMPLE ? ' · 표본 적음' : ''}</span>
                    </Link>
                  )
                })}
              </div>
            )}
            <p className="hint">시간대를 누르면 그 시간에 탑승한 실제 기록을 검색합니다. 과거 착석률은 미래 착석을 보장하지 않습니다.</p>
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
