import { useId, useState } from 'react'
import { Chip } from './common'

/**
 * 여러 값을 고르는 입력 (노선·역·행선지 검색 조건용).
 * 후보는 '저장된 기록에서 나온 값'만 보여 주고, 후보에 없는 값도 직접 입력해 추가할 수 있다.
 */
export function TagPicker({ label, values, onChange, suggestions, placeholder }: { label: string; values: string[]; onChange: (v: string[]) => void; suggestions: string[]; placeholder?: string }) {
  const id = useId()
  const listId = `${id}-list`
  const [text, setText] = useState('')
  const add = (v: string) => {
    const s = v.trim()
    if (s && !values.includes(s)) onChange([...values, s])
    setText('')
  }
  const unselected = suggestions.filter((s) => !values.includes(s)).slice(0, 8)
  return (
    <div className="field" role="group" aria-label={label}>
      <div className="field-label">{label}</div>
      {values.length > 0 && (
        <div className="chips" aria-label={`선택한 ${label}`}>
          {values.map((v) => (
            <Chip key={v} value={v} selected onSelect={() => onChange(values.filter((x) => x !== v))} small>
              {v} ✕<span className="sr-only"> 선택 해제</span>
            </Chip>
          ))}
        </div>
      )}
      {unselected.length > 0 && (
        <div className="chips">
          {unselected.map((v) => (
            <Chip key={v} value={v} selected={false} onSelect={add} small tone="suggest">
              {v}
            </Chip>
          ))}
        </div>
      )}
      <div className="field-row">
        <input
          type="search"
          list={listId}
          value={text}
          placeholder={placeholder ?? '직접 입력'}
          aria-label={`${label} 직접 입력`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(text)
            }
          }}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button type="button" className="btn-small" onClick={() => add(text)} disabled={!text.trim()}>
          추가
        </button>
      </div>
    </div>
  )
}
