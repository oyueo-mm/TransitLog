import { useId, useState } from 'react'
import { format12, TimeInput } from './TimeInput'

/** Edit a local draft; only Done applies it to the containing record form. */
export function CollapsedTimeInput({ label, value, onChange }: {
  label: string
  value: string | null
  onChange: (value: string | null) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <div className="collapsed-time field">
      <button type="button" className="daytime-summary" aria-expanded={open} aria-controls={id} onClick={() => {
        setDraft(value)
        setOpen(!open)
      }}>
        <span>{label}</span>{' '}
        <output>{format12(value) || '시간 입력 +'}</output>
        <span className="sr-only"> 편집</span>
      </button>
      <div id={id} hidden={!open}>
        {open && <>
          <TimeInput label={label} value={draft} onChange={setDraft} />
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
