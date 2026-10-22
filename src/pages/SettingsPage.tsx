import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../db/db'
import {
  backupFileName,
  buildBackup,
  deleteAllData,
  downloadText,
  parseBackup,
  restoreMerge,
  restoreReplace,
  shareTextFile,
  tripsToCsv,
  type ParsedBackup,
} from '../db/backup'
import { deleteTemplate, setSetting } from '../db/repo'
import { Section } from '../ui/common'
import { toast, useAllTrips, useSetting, useTemplates } from '../ui/hooks'
import { SCHEMA_VERSION } from '../domain/types'

function fmtDate(ms: number | null): string {
  if (!ms) return '없음'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function SettingsPage() {
  const trips = useAllTrips()
  const templates = useTemplates()
  const [lastBackup] = useSetting<number | null>('lastBackupAt', null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<(ParsedBackup & { name: string }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted)
  }, [])

  const doBackup = async (share: boolean) => {
    const b = await buildBackup()
    const text = JSON.stringify(b, null, 1)
    const name = backupFileName()
    const shared = share ? await shareTextFile(name, text, 'application/json') : false
    if (!shared) downloadText(name, text, 'application/json')
    await setSetting('lastBackupAt', Date.now())
    toast(`백업했습니다 (기록 ${b.data.trips.length}건)`)
  }

  const doCsv = async () => {
    const [t, e] = await Promise.all([db.trips.toArray(), db.seatEvents.toArray()])
    downloadText(backupFileName('transitlog-trips', 'csv'), tripsToCsv(t, e), 'text/csv;charset=utf-8')
    toast('CSV로 내보냈습니다')
  }

  const pickRestore = async (f: File | undefined) => {
    if (!f) return
    const text = await f.text()
    setParsed({ ...parseBackup(text), name: f.name })
    setMsg(null)
  }

  const mergeRestore = async () => {
    if (!parsed?.ok) return
    setBusy(true)
    try {
      const r = await restoreMerge(parsed.backup)
      setMsg(`병합 복원 완료: 기록 ${r.addedTrips}건 추가, ${r.skippedTrips}건은 이미 있어 건너뜀 (기존 데이터는 그대로입니다)`)
      setParsed(null)
    } catch (e) {
      setMsg(`복원하지 못했습니다: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const replaceRestore = async () => {
    if (!parsed?.ok) return
    if (!window.confirm('현재 기기의 모든 기록이 이 백업 내용으로 교체됩니다. 먼저 현재 데이터를 자동으로 백업 파일로 저장한 뒤 진행합니다. 계속할까요?')) return
    setBusy(true)
    try {
      const cur = await buildBackup()
      downloadText(backupFileName('transitlog-before-restore'), JSON.stringify(cur, null, 1), 'application/json')
      await restoreReplace(parsed.backup)
      setMsg('전체 교체 복원을 완료했습니다. 복원 직전 데이터는 방금 내려받은 파일에 있습니다.')
      setParsed(null)
    } catch (e) {
      setMsg(`복원하지 못했습니다: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const wipe = async () => {
    if (!window.confirm('모든 기록·경로·설정을 이 기기에서 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return
    if (!window.confirm('정말 삭제할까요? 백업 파일이 없다면 복구할 수 없습니다.')) return
    await deleteAllData()
    toast('모든 데이터를 삭제했습니다')
  }

  const askPersist = async () => {
    const ok = await navigator.storage?.persist?.()
    setPersisted(!!ok)
    toast(ok ? '브라우저가 데이터를 지우지 않도록 보호합니다' : '브라우저가 보호 요청을 허용하지 않았습니다')
  }

  const count = trips?.length ?? 0
  return (
    <div className="page">
      <header className="page-head">
        <h1>설정·백업</h1>
      </header>

      <Section title="백업" className="emph">
        <p>
          기록은 <strong>이 기기의 브라우저(IndexedDB)에만</strong> 저장됩니다. 서버나 로그인이 없으므로, 기기를 바꾸거나 브라우저 데이터를 지우면 백업 없이는 복구할 수 없습니다.
        </p>
        <dl className="totals">
          <div>
            <dt>저장된 기록</dt>
            <dd>{count}건</dd>
          </div>
          <div>
            <dt>마지막 백업</dt>
            <dd>{fmtDate(lastBackup)}</dd>
          </div>
        </dl>
        <div className="actions-col">
          <button className="btn-primary big" onClick={() => doBackup(false)} disabled={count === 0 && templates?.length === 0}>
            JSON 백업 파일 저장
          </button>
          <button className="btn-secondary" onClick={() => doBackup(true)}>
            공유로 저장 (드라이브·카카오톡 등)
          </button>
          <button className="btn-secondary" onClick={doCsv}>
            CSV로 내보내기 (엑셀용)
          </button>
        </div>
        <p className="hint">백업 파일에는 개인적인 이동 기록이 들어 있습니다. 공개 저장소나 공유 폴더에 올리지 마세요.</p>
      </Section>

      <Section title="복원">
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void pickRestore(e.target.files?.[0])} />
        <button className="btn-secondary" onClick={() => fileRef.current?.click()}>
          백업 파일에서 복원…
        </button>
        {parsed && !parsed.ok && <p className="notice error">{parsed.error}</p>}
        {parsed?.ok && (
          <div className="notice">
            <strong>{parsed.name}</strong>
            <ul>
              <li>기록 {parsed.summary.trips}건 · 좌석 변화 {parsed.summary.seatEvents}건 · 일지 {parsed.summary.days}일 · 경로 {parsed.summary.templates}개</li>
              <li>백업 시각: {parsed.summary.exportedAt || '알 수 없음'} (스키마 v{parsed.summary.schemaVersion})</li>
            </ul>
            <div className="actions-col">
              <button className="btn-primary" onClick={mergeRestore} disabled={busy}>
                병합 복원 (권장 · 기존 데이터 유지)
              </button>
              <button className="btn-danger" onClick={replaceRestore} disabled={busy}>
                전체 교체 복원…
              </button>
              <button className="btn-text" onClick={() => setParsed(null)}>
                취소
              </button>
            </div>
          </div>
        )}
        {msg && <p className="notice">{msg}</p>}
      </Section>

      <Section title="기존 노트 가져오기">
        <p>Samsung Notes 에서 내보낸 PDF(또는 텍스트)를 분석해 기록으로 가져옵니다. 변환 결과를 원문과 비교·수정한 뒤 승인한 것만 저장합니다.</p>
        <Link className="btn-secondary" to="/import">
          PDF 가져오기
        </Link>
      </Section>

      <Section title={`저장한 경로 (${templates?.length ?? 0})`}>
        {(templates ?? []).length === 0 ? (
          <p className="muted">기록 화면에서 ‘빠른 기록 경로로 저장’을 누르면 여기에 표시됩니다. 자주 탄 경로는 기록에서 자동으로 추천됩니다.</p>
        ) : (
          <ul className="plain">
            {templates!.map((t) => (
              <li key={t.id} className="row-between">
                <span>
                  {t.name} <span className="muted small">({t.useCount}회 사용)</span>
                </span>
                <button className="btn-text danger" onClick={() => void deleteTemplate(t.id)}>
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="저장소 보호">
        <p>
          상태: {persisted === null ? '확인 중' : persisted ? '보호됨 (브라우저가 임의로 지우지 않음)' : '기본 (저장 공간이 부족하면 브라우저가 지울 수 있음)'}
        </p>
        {!persisted && (
          <button className="btn-secondary" onClick={askPersist}>
            데이터 보호 요청
          </button>
        )}
        <p className="hint">홈 화면에 설치(PWA)하면 보호가 승인되기 쉽습니다. 그래도 정기적인 백업이 가장 안전합니다.</p>
      </Section>

      <Section title="위험 구역">
        <button className="btn-danger" onClick={wipe}>
          이 기기의 모든 데이터 삭제
        </button>
      </Section>

      <p className="muted small center">
        TransitLog · 데이터 스키마 v{SCHEMA_VERSION}
      </p>
    </div>
  )
}
