import { sampleNote } from '../domain/coverage'

export function Bars({ items, max }: { items: Array<{ key: string; count: number }>; max?: number }) {
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
export function SeatMetric(props: { title: string; num: number; den: number; total: number; def: string; reasons: Array<[string, number]>; bias?: string }) {
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
