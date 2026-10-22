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
import { sampleNote, seatCoverage } from '../domain/coverage'
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

/**
 * 착석 지표 카드. 숫자보다 먼저 '몇 건을 판정했고 몇 건이 빠졌는지'를 보여 주고,
 * 표본이 적거나 일부만 판정된 비율은 경고를 숫자보다 눈에 띄게 한다.
 */
function SeatMetric(props: { title: string; num: number; den: number; total: number; def: string; reasons: Array<[string, number]>; bias?: string }) {
  const { title, num, den, total } = props
  const note = sampleNote(den, total)
  const pct = den === 0 ? null : Math.round((num / den) * 100)
  const excludedReasons = props.reasons.filter(([, n]) => n > 0)
  return (
    <div className={`metric ${note.insufficient ? 'is-weak' : ''}`}>
      <dt>{title}</dt>
      <dd className="coverage">
        판정 가능 <strong>{den}건</strong> / 전체 {total}건 · 제외 <strong>{note.excluded}건</strong>
      </dd>
      {note.insufficient && (
        <dd className="caution strong">
          ⚠ 표본 부족 ({den}건) — 해석 주의
        </dd>
      )}
      {!note.insufficient && note.partial && (
        <dd className="caution">
          ⚠ 전체의 {note.coveragePct}%만 판정 — 전체 착석률로 읽지 마세요{props.bias ? ` (${props.bias})` : ''}
        </dd>
      )}
      <dd className={`value ${note.insufficient ? 'dim' : ''}`}>
        {pct === null ? (
          <span className="muted">표본 없음</span>
        ) : (
          <>
            <strong>{pct}%</strong>{' '}
            <span className="muted">
              ({num}/{den})
            </span>
          </>
        )}
      </dd>
      <dd className="def">{props.def}</dd>
      {excludedReasons.length > 0 && (
        <dd>
          <details>
            <summary>제외된 {note.excluded}건의 이유</summary>
            <ul className="plain small">
              {excludedReasons.map(([label, n]) => (
                <li key={label}>
                  {label}: {n}건
                </li>
              ))}
            </ul>
            <p className="hint">제외된 기록은 ‘서서 감’도 ‘앉아서 감’도 아닌 미확인으로 두며 어느 쪽 통계에도 넣지 않습니다.</p>
          </details>
        </dd>
      )}
    </div>
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
  const cov = seatCoverage(rows)
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
            <div className="notice sample-overview" role="note">
              <strong>전체 탑승 {cov.total}건</strong> 중 판정 가능한 건수는 지표마다 다릅니다 — 즉시 {seat.immediate.den}건 · 한 번이라도 {seat.everSeated.den}건 · 최종 {seat.final.den}건.
              <details>
                <summary>분모가 서로 다른 이유</summary>
                <ul className="plain small">
                  <li>
                    <strong>즉시 착석률</strong>: 탑승할 때 좌석 상태를 기록한 탑승 중 앉아서 탄 비율입니다.
                  </li>
                  <li>
                    <strong>한 번이라도 착석</strong>: 앉은 것이 확인된 기록과 ‘끝까지 서 있었다’고 확인한 기록만 셉니다. 서서 탄 뒤 이후를 확인하지 않은 기록은 앉았는지 알 수 없어 뺍니다.
                  </li>
                  <li>
                    <strong>최종 착석률</strong>: 좌석 변화 기록을 ‘완결’로 확인한 탑승만 셉니다.
                  </li>
                  <li>미확인 기록은 ‘서서 감’이나 ‘앉아서 감’으로 처리하지 않습니다. 기록 수정에서 좌석 변화를 확인하면 표본이 늘어납니다.</li>
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
                bias="서서 탄 뒤 확인하지 않은 기록이 빠져 실제보다 높게 보일 수 있어요"
                def="탑승 중 한 번이라도 앉은 비율. 앉은 것이 확인된 기록과 ‘끝까지 서 있었음’을 확인한 기록만 센다"
                reasons={[
                  ['서서 탔지만 이후 앉았는지 확인하지 않음(‘변화 없음’ 미확인)', cov.ever.unconfirmedStanding],
                  ['좌석 정보가 없음', cov.ever.unknown],
                ]}
              />
              <SeatMetric
                title="최종 착석률"
                num={seat.final.num}
                den={seat.final.den}
                total={cov.total}
                def="하차 직전 앉아 있던 비율 (좌석 변화 기록이 완결로 확인된 탑승만)"
                reasons={[['좌석 변화 기록 완결을 확인하지 않음', cov.final.unconfirmed]]}
              />
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
