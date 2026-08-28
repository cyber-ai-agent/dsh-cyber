import { Check, CaretDown, FolderSimple, ShieldCheck, ShieldWarning } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { AgentPermissionMode } from '@dsh-cyber/contracts'
import { useI18n } from '../i18n/runtime.js'

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
        <span>{permissionLabel(value, t)}</span>
        <CaretDown size={13} />
      </button>
      {open ? <div className="conversation-permission-menu" role="menu" aria-label={t('workbench.permissionCurrent', '当前消息权限')}>
        <button className={value === 'read-only' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'read-only'} onClick={() => select('read-only')}>
          <ShieldCheck size={18} />
          <span><strong>{t('workbench.permissionReadOnly', t('workbench.approval', '请求批准'))}</strong><small>{t('workbench.permissionReadOnlyDesc', '编辑外部文件和使用互联网时始终询问')}</small></span>
          {value === 'read-only' ? <Check size={17} /> : null}
        </button>
        <button className={value === 'workspace-write' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'workspace-write'} onClick={() => select('workspace-write')}>
          <FolderSimple size={18} />
          <span><strong>{t('workbench.permissionWorkspaceWrite', '帮我批准')}</strong><small>{t('workbench.permissionWorkspaceWriteDesc', '仅对检测到的风险操作请求批准')}</small></span>
          {value === 'workspace-write' ? <Check size={17} /> : null}
        </button>
        <button className={value === 'danger-full-access' ? 'is-selected' : ''} type="button" role="menuitemradio" aria-checked={value === 'danger-full-access'} onClick={() => select('danger-full-access')}>
          <ShieldWarning size={18} />
          <span><strong>{t('workbench.permissionFullAccess', '完全访问')}</strong><small>{t('workbench.permissionFullAccessDesc', '可不受限制地访问互联网和你电脑上的任何文件')}</small></span>
          {value === 'danger-full-access' ? <Check size={17} /> : null}
        </button>
      </div> : null}
    </div>
  )
}

function permissionLabel(value: ConversationPermissionMode, t: (key: string, fallback: string) => string): string {
  if (value === 'danger-full-access') return t('workbench.permissionFullAccess', '完全访问')
  if (value === 'workspace-write') return t('workbench.permissionWorkspaceWrite', '帮我批准')
  return t('workbench.permissionReadOnly', t('workbench.approval', '请求批准'))
}

function PermissionIcon({ value, size }: { value: ConversationPermissionMode; size: number }) {
  const Icon = value === 'danger-full-access'
    ? ShieldWarning
    : value === 'workspace-write'
      ? FolderSimple
      : ShieldCheck
  return <Icon aria-hidden="true" data-permission-icon={value} size={size} />
}
