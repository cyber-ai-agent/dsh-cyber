import { Check, CaretDown, FolderSimple, ShieldCheck, ShieldWarning } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { AgentPermissionMode } from '@dsh-cyber/contracts'
import { useI18n } from '../i18n/runtime.js'
import { runtimePermissionCopy } from './runtime-permission-copy.js'

export type ConversationPermissionMode = AgentPermissionMode

interface ConversationPermissionControlProps {
  value: ConversationPermissionMode
  onChange(value: ConversationPermissionMode): void
  onRequestFullAccess?(): void
}

export function ConversationPermissionControl({ value, onChange, onRequestFullAccess }: ConversationPermissionControlProps) {
  const { t } = useI18n()
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
      <button className="conversation-permission-control__trigger" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={t('workbench.permissionCurrent', '当前消息权限')} title={t('workbench.permissionCurrent', '当前消息权限')} onClick={() => setOpen((current) => !current)}>
        <PermissionIcon value={value} size={17} />
        <span>{runtimePermissionCopy(t, value).label}</span>
        <CaretDown size={13} />
      </button>
      {open ? <div className="conversation-permission-menu" role="menu" aria-label={t('workbench.permissionCurrent', '当前消息权限')}>
        <button className={value === 'read-only' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'read-only'} onClick={() => select('read-only')}>
          <ShieldCheck size={18} />
          <span><strong>{runtimePermissionCopy(t, 'read-only').label}</strong><small>{runtimePermissionCopy(t, 'read-only').description}</small></span>
          {value === 'read-only' ? <Check size={17} /> : null}
        </button>
        <button className={value === 'workspace-write' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'workspace-write'} onClick={() => select('workspace-write')}>
          <FolderSimple size={18} />
          <span><strong>{runtimePermissionCopy(t, 'workspace-write').label}</strong><small>{runtimePermissionCopy(t, 'workspace-write').description}</small></span>
          {value === 'workspace-write' ? <Check size={17} /> : null}
        </button>
        <button className={value === 'danger-full-access' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'danger-full-access'} onClick={() => select('danger-full-access')}>
          <ShieldWarning size={18} />
          <span><strong>{runtimePermissionCopy(t, 'danger-full-access').label}</strong><small>{runtimePermissionCopy(t, 'danger-full-access').description}</small></span>
          {value === 'danger-full-access' ? <Check size={17} /> : null}
        </button>
      </div> : null}
    </div>
  )
}

function PermissionIcon({ value, size }: { value: ConversationPermissionMode; size: number }) {
  const Icon = value === 'danger-full-access'
    ? ShieldWarning
    : value === 'workspace-write'
      ? FolderSimple
      : ShieldCheck
  return <Icon aria-hidden="true" data-permission-icon={value} size={size} />
}
