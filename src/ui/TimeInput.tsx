import { useState } from 'react'
import { formatHm, nowHm, parseHm } from '../domain/time'

/**
 * 시각 입력 (저장 형식은 기존과 같은 24시간제 'HH:mm').
 *
 * Android 의 기본 time 입력은 좁은 폭에서 '오전/오후·시·분·시계 아이콘'이 한 칸에 들어가 잘리므로,
 * 오전/오후 버튼 + 시·분 선택을 분리해 한 줄 전체 너비로 배치한다. 글자 크기(rem)가 커져도 줄바꿈되어 잘리지 않는다.
 * 시와 분을 모두 고르기 전에는 값이 없는(미기록) 상태로 두고, 고른 값만 화면 아래에 '오전 09:24' 로 보여 준다.
 */
type Ap = '오전' | '오후'

function split(v: string | null): { ap: Ap; h: string; m: string } | null {
  const mins = parseHm(v)
  if (mins === null) return null
  const h24 = Math.floor(mins / 60)
  return { ap: h24 >= 12 ? '오후' : '오전', h: String(h24 % 12 === 0 ? 12 : h24 % 12), m: String(mins % 60).padStart(2, '0') }
}

function join(ap: Ap, h: string, m: string): string {
  const h12 = Number(h) % 12
  return formatHm((ap === '오후' ? h12 + 12 : h12) * 60 + Number(m))
}

/** 'HH:mm' → '오전 09:24' */
export function format12(v: string | null): string {
  const p = split(v)
  return p ? `${p.ap} ${p.h.padStart(2, '0')}:${p.m}` : ''
}

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1))
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))

export interface TimeInputProps {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  /** '지금' 버튼 문구 (없으면 버튼을 표시하지 않는다) */
  nowLabel?: string
  clearable?: boolean
  /** 하루 기록처럼 여러 개를 쌓아 보여 줄 때의 한 줄형 */
  compact?: boolean
  hideLabel?: boolean
}

export function TimeInput({ label, value, onChange, nowLabel, clearable = true, compact, hideLabel }: TimeInputProps) {
  const [part, setPart] = useState<{ ap: Ap; h: string; m: string }>({ ap: '오전', h: '', m: '' })
  const cur = split(value) ?? part
  const emit = (next: { ap: Ap; h: string; m: string }) => {
    setPart(next)
    onChange(next.h && next.m ? join(next.ap, next.h, next.m) : null)
  }
  const setNow = () => {
    const p = split(nowHm())!
    setPart(p)
    onChange(nowHm())
  }

  return (
    <div className={`timeinput ${compact ? 'is-compact' : ''}`} role="group" aria-label={label}>
      {!hideLabel && (
        <div className="field-label">
          {label}
          {!value && <span className="unrecorded">미기록</span>}
        </div>
      )}
      <div className="ti-main">
        <div className="ti-ap" role="group" aria-label={`${label} 오전/오후`}>
          {(['오전', '오후'] as Ap[]).map((a) => (
            <button key={a} type="button" className={`seg-btn ${cur.ap === a ? 'is-on' : ''}`} aria-pressed={cur.ap === a} onClick={() => emit({ ...cur, ap: a })}>
              {a}
            </button>
          ))}
        </div>
        <div className="ti-hm">
          <select aria-label={`${label} 시`} value={cur.h} onChange={(e) => emit({ ...cur, h: e.target.value })}>
            <option value="">시</option>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h}시
              </option>
            ))}
          </select>
          <span aria-hidden="true" className="ti-colon">
            :
          </span>
          <select aria-label={`${label} 분`} value={cur.m} onChange={(e) => emit({ ...cur, m: e.target.value })}>
            <option value="">분</option>
            {MINUTES.map((m) => (
              <option key={m} value={m}>
                {m}분
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="ti-foot">
        <output className="ti-out" aria-live="polite">
          {value ? format12(value) : '시·분을 모두 선택하세요'}
        </output>
        {nowLabel && (
          <button type="button" className="btn-small" onClick={setNow}>
            {nowLabel}
          </button>
        )}
        {clearable && (value || part.h || part.m) && (
          <button
            type="button"
            className="btn-text"
            onClick={() => {
              setPart({ ap: '오전', h: '', m: '' })
              onChange(null)
            }}
          >
            지우기
          </button>
        )}
      </div>
    </div>
  )
}
