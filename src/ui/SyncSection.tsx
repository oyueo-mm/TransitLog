import { useEffect, useState } from 'react'
import { CloudCheck, CloudOff, RefreshCw, TriangleAlert } from 'lucide-react'
import { downloadText, backupFileName } from '../db/backup'
import { googleAuth, syncController } from '../sync/instance'
import type { ConfirmRequest, SyncConflict, SyncPhase } from '../sync/types'
import { Section } from './common'
import { useSyncConflicts, useSyncSnapshots, useSyncStatus } from './syncHooks'

const PHASE_LABEL: Record<SyncPhase, string> = {
  unconfigured: '설정 필요',
  disconnected: '연결 안 됨',
  idle: '연결됨',
  syncing: '동기화 중…',
  ok: '동기화 완료',
  offline: '오프라인 (연결되면 동기화)',
  reauth: '재인증 필요',
  conflict: '충돌 확인 필요',
  confirm: '확인 필요',
  error: '동기화 실패',
}

function fmt(ms: number | null): string {
  if (!ms) return '아직 없음'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const COUNT_LABEL = { trips: '기록', seatEvents: '좌석 변화', days: '하루 기록', templates: '경로' } as const
function counts(c?: ConfirmRequest['localCounts']): string {
  if (!c) return ''
  return (Object.keys(COUNT_LABEL) as Array<keyof typeof COUNT_LABEL>).map((k) => `${COUNT_LABEL[k]} ${c[k]}`).join(' · ')
}

function ConfirmPanel({ req, busy, run }: { req: ConfirmRequest; busy: boolean; run: (fn: () => Promise<void>) => void }) {
  const s = req.stats
  const cont = (choice?: 'apply' | 'revert') => run(() => syncController.confirmContinue(choice))
  const cancel = () => run(() => syncController.confirmCancel())
  if (req.kind === 'bulk-delete') {
    const push = req.bulkDirection !== 'pull'
    return (
      <div className="notice warn" role="alertdialog" aria-label="대량 삭제 확인">
        <p>
          <strong>{push ? `이 기기에서 지워진 기록 ${req.deleteCount}건` : `다른 기기에서 지워진 기록 ${req.deleteCount}건`}</strong>을 {push ? 'Google Drive와 다른 기기에도 반영하려고 합니다.' : '이 기기에도 반영하려고 합니다.'} 한꺼번에 많이 지워지는 경우라 확인을 받습니다.
        </p>
        <p className="hint">반영하기 전에 이 기기의 복구용 사본을 자동으로 남깁니다.</p>
        <div className="actions-col">
          <button className="btn-secondary" disabled={busy} onClick={() => cont('revert')}>
            {push ? '삭제하지 않고 Drive의 기록을 다시 받기' : '삭제하지 않고 이 기기의 기록 유지'}
          </button>
          <button className="btn-danger" disabled={busy} onClick={() => cont('apply')}>
            삭제 반영
          </button>
          <button className="btn-text" disabled={busy} onClick={cancel}>
            지금은 보류
          </button>
        </div>
      </div>
    )
  }
  if (req.kind === 'remote-corrupt') {
    return (
      <div className="notice error" role="alertdialog" aria-label="Drive 데이터 손상">
        <p>
          <strong>Drive의 동기화 파일을 읽을 수 없습니다.</strong> {req.detail}
        </p>
        <p className="hint">이 기기의 기록은 그대로입니다. 원인을 모르면 보류하고, Drive 파일을 이 기기의 기록으로 다시 만들어도 된다면 아래 버튼을 누르세요 (Drive의 기존 파일 내용은 대체됩니다).</p>
        <div className="actions-col">
          <button className="btn-danger" disabled={busy} onClick={() => cont()}>
            이 기기의 기록으로 Drive 파일 다시 만들기
          </button>
          <button className="btn-text" disabled={busy} onClick={cancel}>
            보류
          </button>
        </div>
      </div>
    )
  }
  const account = req.kind === 'account'
  return (
    <div className="notice" role="alertdialog" aria-label={account ? '다른 계정 연결 확인' : '처음 연결 확인'}>
      {account ? (
        <p>
          <strong>이전과 다른 Google 계정</strong>({req.account ?? '알 수 없음'})에 연결하려고 합니다. 이전 계정({req.previousAccount ?? '알 수 없음'})과의 동기화 기록은 이어지지 않으며,
          이 기기의 기록이 <strong>이 계정의 Drive에 올라가 합쳐집니다.</strong>
        </p>
      ) : (
        <p>
          <strong>{req.account ?? 'Google 계정'}</strong>에 연결합니다. 이 기기의 기록과 Drive의 기록을 <strong>합칩니다</strong> (어느 쪽도 삭제하거나 덮어쓰지 않습니다).
        </p>
      )}
      <ul>
        <li>이 기기: {counts(req.localCounts) || '기록 없음'}</li>
        <li>Drive: {counts(req.remoteCounts) || '아직 없음'}</li>
        {s && (
          <li>
            합친 뒤: 이 기기로 {s.pulledNew + s.pulledChanged}건 받음 · Drive로 {s.pushedNew + s.pushedChanged}건 올림
            {s.deduped > 0 ? ` · 완전히 같은 중복 ${s.deduped}건 정리` : ''}
            {s.conflicts > 0 ? ` · 확인할 충돌 ${s.conflicts}건` : ''}
          </li>
        )}
      </ul>
      <p className="hint">시작 전에 이 기기의 복구용 사본을 자동으로 남깁니다. 원하면 먼저 위 ‘백업’에서 JSON 파일도 저장해 두세요.</p>
      <div className="actions-col">
        <button className="btn-primary" disabled={busy} onClick={() => cont()}>
          합치고 동기화 시작
        </button>
        <button className="btn-text" disabled={busy} onClick={cancel}>
          취소 (연결하지 않음)
        </button>
      </div>
    </div>
  )
}

function fieldText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '미기록'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

function ConflictItem({ c, run, busy }: { c: SyncConflict; run: (fn: () => Promise<void>) => void; busy: boolean }) {
  return (
    <li className="conflict-item">
      <strong>{c.label}</strong>
      {c.kind === 'fields' ? (
        <>
          <div className="small muted">두 기기에서 같은 항목을 다르게 고쳐서, 한쪽 값을 남기고 다른 쪽 값을 보관해 두었습니다.</div>
          <ul className="plain small">
            {c.fields.map((f) => (
              <li key={f.name}>
                {f.name}: 이 기기 <em>{fieldText(f.local)}</em> / 다른 기기 <em>{fieldText(f.remote)}</em> → 현재 {f.kept === 'local' ? '이 기기' : '다른 기기'} 값 사용 중
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="small muted">
          {c.kind === 'deleted-remote' ? '다른 기기에서 삭제했지만 이 기기에서 수정한 기록이라 삭제하지 않고 남겼습니다.' : '이 기기에서 삭제했지만 다른 기기에서 수정한 기록이라 삭제하지 않고 남겼습니다.'}
        </div>
      )}
      <div className="row-between">
        <button className="btn-small" disabled={busy} onClick={() => run(() => syncController.resolveConflict(c, 'keep'))}>
          현재 상태로 확정
        </button>
        <button className="btn-small" disabled={busy} onClick={() => run(() => syncController.resolveConflict(c, 'other'))}>
          {c.kind === 'fields' ? '다른 쪽 값으로 바꾸기' : '삭제하기'}
        </button>
      </div>
    </li>
  )
}

export function SyncSection() {
  const st = useSyncStatus()
  const conflicts = useSyncConflicts()
  const snaps = useSyncSnapshots()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // 클릭한 바로 그 동작에서 로그인 창을 열 수 있도록 Google 로그인 구성 요소를 미리 불러온다
  useEffect(() => googleAuth.preload(), [])
  const run = (fn: () => Promise<void>) => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  const revokeAccess = () => {
    if (
      !window.confirm(
        'Google 접근 권한을 철회합니다.\n\n같은 Google 계정으로 연결한 다른 기기(PC·휴대폰)의 로그인도 모두 무효가 되어, 그 기기들에서 다시 연결해야 합니다.\nDrive 에 올라간 기록과 각 기기의 기록은 지워지지 않습니다.\n\n계속할까요?',
      )
    )
      return
    run(async () => {
      const sent = await syncController.revokeAccess()
      setNote(
        sent
          ? 'Google 접근 권한을 철회했습니다. 다시 쓰려면 다시 연결해 권한을 허용해야 합니다.'
          : '이 탭에 로그인 정보가 없어 Google 에 철회를 요청하지 못했습니다. 완전히 철회하려면 Google 계정의 ‘타사 앱 및 서비스’에서 TransitLog 를 제거하세요. 이 기기의 연결은 해제했습니다.',
      )
    })
  }

  if (st.phase === 'unconfigured' || !googleAuth.configured) {
    return (
      <Section title="Google Drive 동기화">
        <p>
          <CloudOff size={16} className="inline-icon" /> 이 배포에는 Google 연동이 설정되어 있지 않아 동기화를 쓸 수 없습니다. 기록은 지금처럼 이 기기에만 저장되고, 위 ‘백업’으로 옮길 수 있습니다.
        </p>
        <p className="hint">설정 방법: 저장소 README의 ‘Google Drive 동기화 설정’을 따라 OAuth 클라이언트 ID를 만든 뒤 VITE_GOOGLE_CLIENT_ID 로 빌드합니다.</p>
      </Section>
    )
  }

  const connected = st.phase !== 'disconnected'
  const needsReconnect = st.phase === 'reauth'
  const tone = st.phase === 'error' || st.phase === 'reauth' ? 'error' : st.phase === 'conflict' || st.phase === 'confirm' ? 'warn' : ''

  return (
    <Section title="Google Drive 동기화">
      {!connected ? (
        <>
          <p>같은 Google 계정으로 연결한 기기끼리 기록을 맞춥니다. 기록은 계속 이 기기에 먼저 저장되고, 연결하지 않아도 모든 기능을 쓸 수 있습니다.</p>
          <ul className="plain small muted">
            <li>Drive의 일반 파일은 보지 못하고, 이 앱 전용 숨김 폴더(앱 데이터)만 사용합니다.</li>
            <li>연결을 해제해도 이 기기의 기록은 지워지지 않습니다.</li>
          </ul>
          {st.message && <p className="notice error">{st.message}</p>}
          {note && <p className="notice">{note}</p>}
          <button className="btn-primary" disabled={busy} onClick={() => run(() => syncController.connect())}>
            Google 계정 연결
          </button>
        </>
      ) : (
        <>
          <div className={`sync-status ${tone}`} role="status" aria-live="polite">
            {st.phase === 'syncing' ? <RefreshCw size={16} className="inline-icon spin" /> : st.phase === 'ok' || st.phase === 'idle' ? <CloudCheck size={16} className="inline-icon" /> : <TriangleAlert size={16} className="inline-icon" />}{' '}
            <strong>{PHASE_LABEL[st.phase]}</strong>
          </div>
          <dl className="totals">
            <div>
              <dt>연결된 계정</dt>
              <dd className="small">{st.account ?? '확인 중'}</dd>
            </div>
            <div>
              <dt>마지막 성공</dt>
              <dd className="small">{fmt(st.lastOkAt)}</dd>
            </div>
          </dl>
          {st.message && <p className={`notice ${tone}`}>{st.message}</p>}
          {st.confirm && <ConfirmPanel req={st.confirm} busy={busy} run={run} />}
          <div className="actions-col">
            {needsReconnect ? (
              <>
                <button className="btn-primary" disabled={busy} onClick={() => run(() => syncController.reconnect())}>
                  다시 연결
                </button>
                <button className="btn-text" disabled={busy} onClick={() => run(() => syncController.reconnect({ otherAccount: true }))}>
                  다른 계정으로 연결
                </button>
              </>
            ) : (
              <button className="btn-secondary" disabled={busy || st.phase === 'syncing' || st.phase === 'confirm'} onClick={() => run(() => syncController.syncNow())}>
                지금 동기화
              </button>
            )}
            <label className="check block">
              <input type="checkbox" checked={st.auto} onChange={(e) => run(() => syncController.setAuto(e.target.checked))} />
              자동 동기화 (앱을 열 때·기록을 바꿀 때·온라인으로 돌아올 때)
            </label>
            <button
              className="btn-text danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm('이 기기에서 Google 연결을 해제합니다. 이 기기의 기록과 Drive에 올라간 기록은 지워지지 않고, 다른 기기의 연결도 유지됩니다. 계속할까요?')) run(() => syncController.disconnect())
              }}
            >
              이 기기에서 연결 해제
            </button>
          </div>
          <p className="hint">
            서버 없는 브라우저 앱은 Google 로그인(약 1시간 유효)을 사용자 클릭 없이 새로 받을 수 없습니다. 새로고침(F5)은 로그인이 남아 있으면 이어지고, 만료되거나 탭을 닫았다면 ‘다시 연결’ 한 번이 필요합니다. 그동안의 기록은 이 기기에 계속 쌓입니다.
          </p>
          <details>
            <summary>고급: Google 접근 권한 철회</summary>
            <p className="hint">
              Google 쪽에서 이 앱의 권한을 취소합니다. <strong>같은 계정으로 연결한 다른 기기도 모두 다시 연결해야 합니다.</strong> 기록은 지워지지 않습니다. 단순히 이 기기만 끊으려면 위의 ‘이 기기에서 연결 해제’를 쓰세요.
            </p>
            <button className="btn-danger" disabled={busy} onClick={revokeAccess}>
              Google 접근 권한 철회…
            </button>
          </details>

          {(conflicts ?? []).length > 0 && (
            <div className="field" role="group" aria-label="동기화 충돌">
              <div className="field-label">확인할 충돌 {conflicts!.length}건</div>
              <ul className="plain">
                {conflicts!.map((c) => (
                  <ConflictItem key={c.id} c={c} run={run} busy={busy} />
                ))}
              </ul>
            </div>
          )}

          {(snaps ?? []).length > 0 && (
            <div className="field" role="group" aria-label="동기화 전 복구용 사본">
              <div className="field-label">동기화 전 복구용 사본 (최근 {snaps!.length}개)</div>
              <ul className="plain small">
                {snaps!.map((s) => (
                  <li key={s.id} className="row-between">
                    <span>
                      {fmt(s.at)} · {s.reason} · 기록 {s.counts.trips}건
                    </span>
                    <button className="btn-text" onClick={() => downloadText(backupFileName('transitlog-before-sync'), s.json, 'application/json')}>
                      내려받기
                    </button>
                  </li>
                ))}
              </ul>
              <p className="hint">내려받은 파일은 위 ‘복원’에서 쓸 수 있는 일반 백업 파일입니다.</p>
            </div>
          )}
        </>
      )}
    </Section>
  )
}
