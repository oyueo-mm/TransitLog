import { useEffect, useId, useRef, useState } from 'react'
import { formatHm, nowHm, parseHm } from '../domain/time'

/**
 * 시각 입력 (저장 형식은 기존과 같은 24시간제 'HH:mm').
 *
 * 오전/오후·시·분을 각각 세로 휠로 선택한다. 터치 관성 스크롤과 키보드 이동을 지원한다.
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

/** 스크롤 순서는 1…12→1, 00…59→00. 가운데 사본만 접근성 목록에 노출한다. */
function TimeWheel({ label, values, value, onChange, loop = false }: { label: string; values: string[]; value: string; onChange: (v: string) => void; loop?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const interacting = useRef(false)
  const id = useId()
  const list = loop ? values.filter((v) => v !== '') : values
  const n = list.length
  const items = loop ? [...list, ...list, ...list] : list
  const index = Math.max(0, list.indexOf(value))
  const latest = useRef({ list, value, onChange })
  useEffect(() => { latest.current = { list, value, onChange } }, [list, value, onChange])
  useEffect(() => {
    clearTimeout(timer.current)
    interacting.current = false
    ref.current?.scrollTo({ top: (loop ? n + index : index) * 44, behavior: 'instant' })
  }, [index, n, loop])
  useEffect(() => () => clearTimeout(timer.current), [])
  const choose = (i: number) => {
    if (n === 0) return
    const next = loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))
    clearTimeout(timer.current)
    interacting.current = false
    ref.current?.scrollTo({ top: (loop ? n + next : next) * 44, behavior: 'instant' })
    onChange(list[next])
  }
  return (
    <div className="ti-wheel-wrap">
      <div ref={ref} className="ti-wheel" role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={value ? `${id}-${index}` : undefined}
        onWheel={() => { interacting.current = true }}
        onTouchStart={() => { interacting.current = true }}
        onPointerDown={() => { interacting.current = true }}
        onKeyDown={(e) => {
          const next = e.key === 'ArrowDown' ? index + 1 : e.key === 'ArrowUp' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null
          if (next !== null) { e.preventDefault(); choose(next) }
        }}
        onScroll={() => {
          if (!interacting.current || n === 0) return
          clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            const current = latest.current
            const raw = Math.round((ref.current?.scrollTop ?? 0) / 44)
            const picked = loop ? ((raw % n) + n) % n : Math.max(0, Math.min(n - 1, raw))
            interacting.current = false
            if (loop) ref.current?.scrollTo({ top: (n + picked) * 44, behavior: 'instant' })
            if (current.list[picked] !== current.value) current.onChange(current.list[picked])
          }, 160)
        }}>
        {items.map((v, i) => {
          const optionIndex = loop ? i % n : i
          const accessible = !loop || (i >= n && i < n * 2)
          return <div id={accessible ? `${id}-${optionIndex}` : undefined} key={`${i}-${v}`} role={accessible ? 'option' : 'presentation'} aria-hidden={!accessible || undefined} aria-selected={accessible ? v === value : undefined} className={`ti-option ${v === value ? 'is-selected' : ''}`} onClick={() => choose(optionIndex)}>{v || '—'}</div>
        })}
      </div>
    </div>
  )
}
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
    // 누를 때마다 현재 시각을 새로 읽고, 한 번만 읽어 표시값과 저장값이 어긋나지 않게 한다
    const now = nowHm()
    setPart(split(now)!)
    onChange(now)
  }

  return (
    <div className={`timeinput ${compact ? 'is-compact' : ''}`} role="group" aria-label={label}>
      {!hideLabel && (
        <div className="field-label">
          {label}
          {!value && <span className="unrecorded">미기록</span>}
        </div>
      )}
      <div className="ti-wheels">
        <TimeWheel label={`${label} 오전/오후`} values={['오전', '오후']} value={cur.ap} onChange={(ap) => emit({ ...cur, ap: ap as Ap })} />
        <TimeWheel label={`${label} 시`} values={HOURS} value={cur.h} loop onChange={(h) => emit({ ...cur, h })} />
        <TimeWheel label={`${label} 분`} values={MINUTES} value={cur.m} loop onChange={(m) => emit({ ...cur, m })} />
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
