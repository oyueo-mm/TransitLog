import { useId, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'

/** 검색 조건을 접힌 체크 목록으로 표시한다. 같은 목록 안은 OR, 다른 조건과는 AND. */
export function SearchMultiSelect<T extends string | number>({ label, options, values, onChange, searchable = false }: {
  label: string
  options: Array<{ value: T; label: string }>
  values: T[]
  onChange: (values: T[]) => void
  searchable?: boolean
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const all = useMemo(() => {
    const known = new Set(options.map((option) => String(option.value)))
    return [...options, ...values.filter((value) => !known.has(String(value))).map((value) => ({ value, label: String(value) }))]
  }, [options, values])
  const visible = all.filter((option) => option.label.toLocaleLowerCase('ko').includes(query.trim().toLocaleLowerCase('ko')))
  const selected = all.filter((option) => values.includes(option.value)).map((option) => option.label)
  const summary = selected.length === 0 ? '전체' : selected.length <= 2 ? selected.join(', ') : `${selected[0]} 외 ${selected.length - 1}개`

  return (
    <div className="field search-multi" role="group" aria-label={label}>
      <div className="field-label">{label}</div>
      <details className="search-multi-details">
        <summary className="search-multi-summary"><span className="sr-only">{label}: </span>
          <span className="search-multi-value">{summary}</span>
          {selected.length > 0 && <span className="search-multi-count">{selected.length}</span>}
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <div className="search-multi-menu">
          {searchable && <input id={id} type="search" value={query} aria-label={`${label} 목록 검색`} placeholder="목록에서 검색" onChange={(event) => setQuery(event.target.value)} />}
          <button className="search-multi-clear" type="button" onClick={() => onChange([])} disabled={values.length === 0}>전체 · 선택 해제</button>
          <div className="search-multi-options">
            {visible.map((option) => (
              <label key={String(option.value)} className="search-multi-option">
                <input type="checkbox" checked={values.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...values, option.value] : values.filter((value) => value !== option.value))} />
                <span>{option.label}</span>
              </label>
            ))}
            {visible.length === 0 && <p className="muted small">해당하는 항목이 없습니다.</p>}
          </div>
        </div>
      </details>
    </div>
  )
}
