import { ShieldWarning, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'

export interface ConversationHostAccessRequest {
  worldId: string
  sessionId: string
  employeeIds: string[]
  employeeNames: string[]
}

interface ConversationHostAccessDialogProps {
  request: ConversationHostAccessRequest
  onConfirm(request: ConversationHostAccessRequest): Promise<void>
  onClose(): void
}

/** Explicit owner confirmation for the current conversation session. */
export function ConversationHostAccessDialog({ request, onConfirm, onClose }: ConversationHostAccessDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const confirmationRef = useRef<HTMLInputElement>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    confirmationRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab' || dialogRef.current === null) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const confirm = async () => {
    if (!confirmed || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm(request)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '完全访问申请失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="host-access-dialog" role="dialog" aria-modal="true" aria-labelledby="host-access-title">
        <header className="dialog-header">
          <div><h2 id="host-access-title"><ShieldWarning size={19} />完全访问</h2><p>只对当前会话生效，刷新页面或切换会话后需要重新确认。</p></div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <dl className="host-access-dialog__facts">
          <div><dt>角色</dt><dd>{request.employeeNames.join('、')}</dd></div>
          <div><dt>范围</dt><dd>当前世界 · 当前会话</dd></div>
        </dl>
        <label className="host-access-dialog__confirm"><input ref={confirmationRef} type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>我确认允许当前会话访问世界目录之外的电脑文件</strong><small>权限只对当前会话和指定角色生效，切换会话后重新确认。</small></span></label>
        {error === undefined ? null : <p className="host-access-dialog__error" role="alert">{error}</p>}
        <footer><button className="text-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={!confirmed || busy} onClick={() => void confirm()}>{busy ? '正在确认…' : '允许当前会话'}</button></footer>
      </section>
    </div>
  )
}
