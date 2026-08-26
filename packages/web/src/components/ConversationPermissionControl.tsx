import { Check, CaretDown, FolderSimple, ShieldCheck, ShieldWarning } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { AgentPermissionMode } from '@dsh-cyber/contracts'

export type ConversationPermissionMode = AgentPermissionMode

interface ConversationPermissionControlProps {
  value: ConversationPermissionMode
  onChange(value: ConversationPermissionMode): void
  onRequestFullAccess?(): void
}

export function ConversationPermissionControl({ value, onChange, onRequestFullAccess }: ConversationPermissionControlProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const select = (next: ConversationPermissionMode) => {
    if (next === 'danger-full-access' && onRequestFullAccess !== undefined) {
      onRequestFullAccess()
      setOpen(false)
      return
    }
    onChange(next)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="conversation-permission-control">
      <button className="conversation-permission-control__trigger" type="button" aria-haspopup="menu" aria-expanded={open} aria-label="当前消息权限" title="当前消息权限" onClick={() => setOpen((current) => !current)}>
        <ShieldCheck size={17} />
        <span>{permissionLabel(value)}</span>
        <CaretDown size={13} />
      </button>
      {open ? <div className="conversation-permission-menu" role="menu" aria-label="当前消息权限">
        <button className={value === 'read-only' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'read-only'} onClick={() => select('read-only')}>
          <ShieldCheck size={18} />
          <span><strong>请求批准</strong><small>以只读模式执行，写入、命令和外部能力按具体动作请求确认。</small></span>
          {value === 'read-only' ? <Check size={17} /> : null}
        </button>
        <button className={value === 'workspace-write' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'workspace-write'} onClick={() => select('workspace-write')}>
          <FolderSimple size={18} />
          <span><strong>帮我批准</strong><small>以工作区读写模式执行，风险动作继续请求明确确认。</small></span>
          {value === 'workspace-write' ? <Check size={17} /> : null}
        </button>
        <button className={value === 'danger-full-access' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'danger-full-access'} onClick={() => select('danger-full-access')}>
          <ShieldWarning size={18} />
          <span><strong>完全访问</strong><small>首次启用时确认，当前会话持续生效。</small></span>
          {value === 'danger-full-access' ? <Check size={17} /> : null}
        </button>
      </div> : null}
    </div>
  )
}

function permissionLabel(value: ConversationPermissionMode): string {
  if (value === 'danger-full-access') return '完全访问'
  return value === 'workspace-write' ? '帮我批准' : '请求批准'
}
