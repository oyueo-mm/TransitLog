import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { commitCandidates, markDuplicates, summarize, type CommitResult } from '../import/commit'
import {
  applyPurposeSuggestion,
  applySeatComplete,
  parseNotes,
  type ImportCandidate,
  type ParseResult,
} from '../import/parser'
import { DROP_REASON_LABEL } from '../import/sanitize'
import { KIND_LABEL, MODE_LABEL } from '../domain/types'
import { getSetting, setSetting } from '../db/repo'
import { Chip, Section } from '../ui/common'
import { TripForm } from '../ui/TripForm'
import { destLabel } from '../ui/common'

type Filter = 'all' | 'review' | 'confirmed' | 'nonride' | 'dup'

function label(c: ImportCandidate): string {
  const t = c.trip
  const parts = [t.line ?? '노선?', t.boardPlace && t.alightPlace ? `${t.boardPlace}→${t.alightPlace}` : t.boardPlace, t.trainDestination ? destLabel(t.trainDestination) : null]
  return parts.filter(Boolean).join(' ')
}

function Candidate(props: {
  c: ImportCandidate
  open: boolean
  onToggleOpen: () => void
  onChange: (c: ImportCandidate) => void
}) {
  const { c } = props
  const t = c.trip
  return (
    <li className={`cand ${c.status} ${c.duplicate !== 'none' ? 'dup' : ''}`}>
      <div className="cand-head">
        <label className="check">
          <input
            type="checkbox"
            checked={c.selected && c.duplicate === 'none'}
            disabled={c.duplicate !== 'none'}
            onChange={(e) => props.onChange({ ...c, selected: e.target.checked })}
            aria-label={`${c.date} ${t.boardTime ?? ''} 가져오기 선택`}
          />
        </label>
        <button type="button" className="cand-main" onClick={props.onToggleOpen} aria-expanded={props.open}>
          <span className="cand-date">
            {c.date.slice(5)} {t.boardTime ?? '--:--'}
          </span>
          <span className="cand-label">
            <span className="badge mode">{MODE_LABEL[t.mode]}</span>
            {t.kind !== 'ride' && <span className={`badge kind-${t.kind}`}>{KIND_LABEL[t.kind]}</span>}
            {label(c)}
          </span>
          <span className="cand-badges">
            {c.duplicate === 'existing' && <span className="badge warn">이미 있음</span>}
            {c.duplicate === 'in-file' && <span className="badge warn">파일 내 중복</span>}
            {c.status === 'review' && <span className="badge review">검토 필요</span>}
          </span>
        </button>
      </div>
      {props.open && (
        <div className="cand-body">
          {c.issues.length > 0 && (
            <ul className="issues">
              {c.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          <div className="cmp">
            <div>
              <h4>원문</h4>
              <pre className="raw">{c.raw}</pre>
              {c.dropped.length > 0 && (
                <>
                  <h4>순화에서 제외한 문장</h4>
                  <ul className="dropped">
                    {c.dropped.map((d, i) => (
                      <li key={i}>
                        <span className="badge">{DROP_REASON_LABEL[d.reason]}</span> {d.text}
                      </li>
                    ))}
                  </ul>
                  <p className="hint">제외한 내용은 저장되지 않습니다. 필요하면 오른쪽 비고에 직접 적어 주세요.</p>
                </>
              )}
            </div>
            <div>
              <h4>변환 결과 (수정 가능)</h4>
              <TripForm
                value={c.trip}
                events={c.seatEvents}
                lockDate
                onChange={(trip, seatEvents) => props.onChange({ ...c, trip, seatEvents })}
              />
            </div>
          </div>
          {c.missing.length > 0 && <p className="hint">원문에서 확인되지 않아 비워 둔 항목: {c.missing.join(', ')}</p>}
        </div>
      )}
    </li>
  )
}

export function ImportPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [stage, setStage] = useState<'pick' | 'working' | 'preview' | 'done'>('pick')
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [cands, setCands] = useState<ImportCandidate[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [saveDays, setSaveDays] = useState(true)
  const [result, setResult] = useState<CommitResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showUnattached, setShowUnattached] = useState(false)
  const [excludeText, setExcludeText] = useState('')

  useEffect(() => {
    void getSetting<string>('import.excludeWords', '').then(setExcludeText)
  }, [])
  const words = () => excludeText.split(/[,\n]/).map((w) => w.trim()).filter(Boolean)

  const begin = async (text: string) => {
    await setSetting('import.excludeWords', excludeText) // 이 기기에만 저장
    const p = parseNotes(text, { excludeWords: words() })
    await markDuplicates(p.candidates)
    setParsed(p)
    setCands(p.candidates)
    setStage('preview')
  }

  const onFile = async (f: File | undefined) => {
    if (!f) return
    setError(null)
    setStage('working')
    try {
      let text: string
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        setProgress('PDF 텍스트를 읽는 중…')
        const { extractFromPdfFile } = await import('../import/pdfClient')
        const r = await extractFromPdfFile(f, (p, n) => setProgress(`PDF 텍스트를 읽는 중… ${p}/${n}쪽`))
        if (r.chars < 50) {
          setError(
            '이 PDF에서 읽을 수 있는 텍스트를 찾지 못했습니다. 손글씨나 이미지로 저장된 PDF일 수 있고, 이 앱은 글자 인식(OCR)을 지원하지 않습니다. Samsung Notes에서 텍스트로 내보내거나 아래 입력칸에 내용을 붙여 넣어 주세요.',
          )
          setStage('pick')
          return
        }
        text = r.text
      } else {
        text = await f.text()
      }
      setProgress('기록을 분석하는 중…')
      await begin(text)
    } catch (e) {
      setError(`파일을 처리하지 못했습니다: ${(e as Error).message}`)
      setStage('pick')
    }
  }

  const onPaste = async () => {
    if (!paste.trim()) return
    setError(null)
    setStage('working')
    setProgress('기록을 분석하는 중…')
    await begin(paste)
  }

  const update = (c: ImportCandidate) => setCands((list) => list.map((x) => (x.id === c.id ? c : x)))
  const summary = useMemo(() => (parsed ? summarize({ ...parsed, candidates: cands }) : null), [parsed, cands])

  const shown = cands.filter((c) => {
    if (filter === 'review') return c.status === 'review' && c.duplicate === 'none'
    if (filter === 'confirmed') return c.status === 'confirmed' && c.duplicate === 'none'
    if (filter === 'nonride') return c.trip.kind !== 'ride'
    if (filter === 'dup') return c.duplicate !== 'none'
    return true
  })

  const bulkSeat = () => {
    const copy = cands.map((c) => ({ ...c, trip: { ...c.trip } }))
    const n = applySeatComplete(copy)
    setCands(copy)
    setNotice(`${n}건을 ‘탑승 중 좌석 변화 없음(기록 완결)’으로 확정했습니다.`)
  }
  const bulkPurpose = () => {
    if (!parsed) return
    const copy = cands.map((c) => ({ ...c, trip: { ...c.trip } }))
    const n = applyPurposeSuggestion(copy, parsed.days)
    setCands(copy)
    setNotice(`${n}건에 등·하교 구분을 적용했습니다.`)
  }

  const commit = async () => {
    if (!parsed) return
    const chosen = cands.filter((c) => c.selected && c.duplicate === 'none')
    if (!window.confirm(`선택한 ${chosen.length}건을 저장할까요? 기존 기록은 변경되지 않습니다.`)) return
    setStage('working')
    setProgress('저장하는 중…')
    try {
      const r = await commitCandidates(chosen, saveDays ? parsed.days : [])
      setResult(r)
      setStage('done')
    } catch (e) {
      setError(`저장하지 못했습니다: ${(e as Error).message}`)
      setStage('preview')
    }
  }

  if (stage === 'working') {
    return (
      <div className="page">
        <p role="status">{progress}</p>
      </div>
    )
  }

  if (stage === 'done' && result) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>가져오기 완료</h1>
        </header>
        <div className="notice">
          <p>
            기록 <strong>{result.added}건</strong>을 저장했습니다. 이미 있어 건너뜀 {result.skippedDuplicates}건 · 일지 {result.daysFilled}일 반영.
          </p>
          <p className="hint">원문 PDF와 제외된 문장은 앱에 저장하지 않았습니다. 원본 PDF는 직접 보관해 주세요. 지금 백업 파일도 만들어 두는 것을 권장합니다.</p>
        </div>
        <div className="actions-col">
          <Link className="btn-primary" to="/settings">
            백업하러 가기
          </Link>
          <Link className="btn-secondary" to="/calendar">
            캘린더에서 확인
          </Link>
          <button
            className="btn-text"
            onClick={() => {
              setResult(null)
              setParsed(null)
              setCands([])
              setNotice(null)
              setStage('pick')
            }}
          >
            다른 파일 가져오기
          </button>
        </div>
      </div>
    )
  }

  if (stage === 'preview' && parsed && summary) {
    const selected = summary.selected
    return (
      <div className="page wide">
        <header className="page-head">
          <h1>가져오기 미리보기</h1>
          <div className="muted">아직 아무것도 저장되지 않았습니다. 확인한 뒤 맨 아래에서 승인해 주세요.</div>
        </header>

        <Section title="결과 요약">
          <dl className="totals">
            <div>
              <dt>전체 후보</dt>
              <dd>{summary.total}건</dd>
            </div>
            <div>
              <dt>확정(문제 없음)</dt>
              <dd>{summary.confirmed}건</dd>
            </div>
            <div>
              <dt>검토 필요</dt>
              <dd>{summary.review}건</dd>
            </div>
            <div>
              <dt>탑승 / 놓침 / 관찰</dt>
              <dd>
                {summary.rides} / {summary.missed} / {summary.observed}
              </dd>
            </div>
            <div>
              <dt>중복(제외)</dt>
              <dd>{summary.duplicates}건</dd>
            </div>
            <div>
              <dt>하루 기록(집 출발 등)</dt>
              <dd>{summary.days}일</dd>
            </div>
          </dl>
          <details>
            <summary>누락 정보 (원문에 없어 ‘미기록’으로 유지)</summary>
            <ul className="plain">
              {Object.entries(summary.missingByField)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => (
                  <li key={k}>
                    {k}: {n}건 (탑승 {summary.rides}건 중)
                  </li>
                ))}
              <li>원문에 ‘??’ 등 불명 표기: {summary.unknownMarks}곳 → 값으로 채우지 않고 비워 둠</li>
            </ul>
          </details>
          {parsed.unattached.length > 0 && (
            <>
              <button className="btn-text" onClick={() => setShowUnattached((s) => !s)}>
                해석하지 못한 줄 {parsed.unattached.length}개 {showUnattached ? '접기' : '보기'}
              </button>
              {showUnattached && (
                <ul className="plain mono">
                  {parsed.unattached.map((u, i) => (
                    <li key={i}>
                      {u.date ?? '-'} · {u.text}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Section>

        <Section title="일괄 적용 (선택)">
          <p className="hint">원문의 서술 방식에 대한 가정이 들어가므로 자동 적용하지 않습니다. 필요할 때만 눌러 주세요.</p>
          <div className="actions-col">
            <button className="btn-secondary" onClick={bulkSeat}>
              ‘서서감/앉아서감’만 적힌 기록을 ‘탑승 중 변화 없음’으로 확정
            </button>
            <button className="btn-secondary" onClick={bulkPurpose}>
              집 출발·학교 도착 시각 기준으로 등·하교 구분 추천 적용
            </button>
          </div>
          {notice && <p className="notice">{notice}</p>}
          <label className="check block">
            <input type="checkbox" checked={saveDays} onChange={(e) => setSaveDays(e.target.checked)} />
            하루 단위 기록(집 출발·학교 도착·귀가)도 일지에 저장 ({summary.days}일)
          </label>
        </Section>

        <Section title="후보 검토">
          <div className="chips filter" role="group" aria-label="후보 필터">
            {(
              [
                ['all', '전체'],
                ['review', '검토 필요'],
                ['confirmed', '확정'],
                ['nonride', '놓침·관찰'],
                ['dup', '중복'],
              ] as Array<[Filter, string]>
            ).map(([f, l]) => (
              <Chip key={f} value={f} selected={filter === f} onSelect={setFilter} small>
                {l}
              </Chip>
            ))}
          </div>
          <ul className="cands">
            {shown.map((c) => (
              <Candidate key={c.id} c={c} open={openId === c.id} onToggleOpen={() => setOpenId(openId === c.id ? null : c.id)} onChange={update} />
            ))}
          </ul>
        </Section>

        {error && <p className="notice error">{error}</p>}
        <div className="formbar">
          <button className="btn-primary" onClick={commit} disabled={selected === 0}>
            승인하고 {selected}건 저장
          </button>
          <button className="btn-secondary" onClick={() => (setStage('pick'), setParsed(null), setCands([]))}>
            취소
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>기존 노트 가져오기</h1>
      </header>
      <div className="notice">
        <strong>원본 PDF가 필요합니다.</strong> Samsung Notes 에서 내보낸 PDF를 선택해 주세요. 파일은 이 기기 안에서만 처리되며 서버로 전송되지 않습니다. 원문은 저장하지 않고,
        <strong> 정리된 기록만</strong> 저장합니다. 원본은 직접 보관해 주세요.
      </div>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf,text/plain,.txt" hidden onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = '' // 같은 파일을 다시 골라도 change 가 발생하도록 초기화
          void onFile(f)
        }} />
      <button className="btn-primary big" onClick={() => fileRef.current?.click()}>
        PDF 또는 텍스트 파일 선택
      </button>
      {error && <p className="notice error">{error}</p>}
      <Section title="제외할 개인 단어 (선택)">
        <label className="field-label" htmlFor="exclude">
          이 단어가 들어 있는 비고 문장은 가져오지 않습니다 (쉼표 또는 줄바꿈으로 구분)
        </label>
        <textarea id="exclude" rows={2} value={excludeText} onChange={(e) => setExcludeText(e.target.value)} placeholder="예: 약속, 과외" />
        <p className="hint">입력한 단어는 이 기기의 브라우저에만 저장되며 서버나 저장소로 전송되지 않습니다.</p>
      </Section>
      <Section title="텍스트 붙여넣기">
        <label className="field-label" htmlFor="paste">
          노트 내용을 직접 붙여 넣을 수도 있습니다
        </label>
        <textarea id="paste" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'2026-05-18\n14:49 …'} />
        <button className="btn-secondary" onClick={onPaste} disabled={!paste.trim()}>
          붙여 넣은 내용 분석
        </button>
      </Section>
      <Section title="처리 방식">
        <ul className="plain">
          <li>날짜·기록 단위로 나누고 노선·구간·칸-문·좌우·대기 순서·좌석 변화를 읽습니다.</li>
          <li>??·기억 안 남 같은 표현은 값을 채우지 않고 ‘미기록’으로 둡니다.</li>
          <li>욕설·감정 표현은 중립적인 문장으로 정리하고, 교통과 무관한 이야기·다른 승객 묘사는 제외합니다.</li>
          <li>탑승하지 못한 기록과 관찰만 한 기록은 분리합니다.</li>
          <li>이미 저장된 기록과 겹치면 건너뜁니다.</li>
          <li>PDF 안의 사진은 읽지 않습니다.</li>
        </ul>
      </Section>
    </div>
  )
}
