import { useId, useState } from 'react'
import { nowHm } from '../domain/time'
import { format12, TimeInput } from './TimeInput'

/** Edit a local draft; only Done applies it to the containing record form. */
export function CollapsedTimeInput({ label, value, onChange, clearable = true }: {
  label: string
  value: string | null
  onChange: (value: string | null) => void
  clearable?: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <div className="collapsed-time field">
      <div className="collapsed-time-row">
        <button type="button" className="daytime-summary" aria-expanded={open} aria-controls={id} onClick={() => {
          setDraft(value)
          setOpen(!open)
        }}>
          <span>{label}</span>{' '}
          <output>{format12(value) || '시간 입력 +'}</output>
          <span className="sr-only"> 편집</span>
        </button>
        {/* 펼치지 않고 바로 현재 시각을 넣는다. 누를 때마다 그 순간의 기기 시각을 읽고, 이후 펼쳐서 수정할 수 있다 */}
        {!open && (
          <button type="button" className="btn-small now-btn" aria-label={`${label} 지금`} onClick={() => onChange(nowHm())}>
            지금
          </button>
        )}
      </div>
      <div id={id} hidden={!open}>
        {open && <>
          <TimeInput label={label} value={draft} onChange={setDraft} nowLabel="지금" clearable={clearable} />
          <div className="grid2">
            <button type="button" className="btn-primary" aria-label={`${label} 완료`} onClick={() => {
              onChange(draft)
              setOpen(false)
            }}>완료</button>
            <button type="button" className="btn-secondary" aria-label={`${label} 취소`} onClick={() => setOpen(false)}>취소</button>
          </div>
        </>}
      </div>
    </div>
  )
}
