import { Archive, ArrowCounterClockwise, Buildings, Trash, WarningCircle, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { World, WorldStatus } from '@dsh-cyber/contracts'

import { api, ApiError } from '../api.js'
import { useI18n } from '../i18n/runtime.js'
import { useDialogFocusTrap } from './useDialogFocusTrap.js'
import './WorldLibraryDialog.css'

type Translate = (key: string, fallback: string, variables?: Record<string, string | number>) => string

interface WorldLibraryDialogProps {
  workspaceId: string
  activeWorldId?: string
  onClose(): void
  /** Called after any lifecycle change so the shell can refresh its own world list. */
  onChanged(): void | Promise<void>
}

/**
 * Owner-facing world library.
 *
 * The active list and the archive are two deliberate views over the same
 * endpoint, never one mixed list: `?status=active` is what opens by default and
 * `?status=archived` is the second view. Every mutation is a server call — this
 * component never predicts the outcome, it re-reads the list afterwards.
 */
export function WorldLibraryDialog({ workspaceId, activeWorldId, onClose, onChanged }: WorldLibraryDialogProps) {
  const { t, formatDateTime } = useI18n()
  const [tab, setTab] = useState<WorldStatus>('active')
  const [worlds, setWorlds] = useState<World[]>()
  const [pendingDelete, setPendingDelete] = useState<World>()
  const [busyWorldId, setBusyWorldId] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)

  useDialogFocusTrap(dialogRef, onClose)

  // Single read path: the visible tab is the status filter, so the list can
  // never drift from what the server was asked for.
  const readWorlds = useCallback(async (scope: WorldStatus): Promise<World[]> => {
    const result = await api<{ items: World[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/worlds?status=${scope}`,
    )
    return result.items
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    setWorlds(undefined)
    void (async () => {
      try {
        const items = await readWorlds(tab)
        if (!cancelled) setWorlds(items)
      } catch {
        if (!cancelled) { setWorlds([]); setError(t('worldLibrary.loadError', '无法读取世界列表，请稍后重试。')) }
      }
    })()
    return () => { cancelled = true }
  }, [readWorlds, t, tab])

  const changeLifecycle = async (world: World, action: 'archive' | 'restore'): Promise<void> => {
    setBusyWorldId(world.id)
    setError(undefined)
    setNotice(undefined)
    try {
      await api(`/api/worlds/${encodeURIComponent(world.id)}/${action}`, { method: 'POST' })
      setWorlds(await readWorlds(tab))
      await onChanged()
      setNotice(action === 'archive'
        ? t('worldLibrary.archived', '「{name}」已归档，不再出现在世界列表里。', { name: world.name })
        : t('worldLibrary.restored', '「{name}」已恢复。', { name: world.name }))
    } catch (cause) {
      setError(worldLifecycleErrorMessage(cause, t))
    } finally {
      setBusyWorldId(undefined)
    }
  }

  // The typed name travels to the server, which is the authority on whether it
  // matches. The dialog gate below only stops an obviously wrong submission.
  const deleteWorld = async (world: World, confirmName: string): Promise<void> => {
    await api(`/api/worlds/${encodeURIComponent(world.id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmName }),
    })
    setPendingDelete(undefined)
    setWorlds(await readWorlds(tab))
    await onChanged()
    setError(undefined)
    setNotice(t('worldLibrary.deleted', '「{name}」已永久删除。', { name: world.name }))
  }

  const switchTab = (next: WorldStatus) => {
    setTab(next)
    setPendingDelete(undefined)
    setNotice(undefined)
    setError(undefined)
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="world-library-dialog" role="dialog" aria-modal="true" aria-labelledby="world-library-title">
        <header className="dialog-header">
          <div>
            <h2 id="world-library-title">{t('worldLibrary.title', '世界库')}</h2>
            <p>{t('worldLibrary.subtitle', '归档不会删除任何内容，随时可以恢复；永久删除无法撤销。')}</p>
          </div>
          <button type="button" data-dialog-initial-focus className="icon-button" onClick={onClose} aria-label={t('worldLibrary.close', '关闭世界库')}>
            <X size={18} />
          </button>
        </header>

        <nav className="world-library-tabs" aria-label={t('worldLibrary.tabs', '世界库分栏')}>
          <button type="button" role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'is-active' : ''} onClick={() => switchTab('active')}>
            <Buildings size={15} />
            {t('worldLibrary.tabActive', '我的世界')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'archived'} className={tab === 'archived' ? 'is-active' : ''} onClick={() => switchTab('archived')}>
            <Archive size={15} />
            {t('worldLibrary.tabArchived', '归档世界')}
          </button>
        </nav>

        {notice === undefined ? null : <p className="world-library-feedback is-success" role="status">{notice}</p>}
        {error === undefined ? null : (
          <p className="world-library-feedback is-error" role="alert"><WarningCircle size={16} />{error}</p>
        )}

        <div className="world-library-list">
          {worlds === undefined ? <p className="world-library-empty">{t('worldLibrary.loading', '正在读取世界列表…')}</p> : null}
          {worlds !== undefined && worlds.length === 0 ? (
            <p className="world-library-empty">
              {tab === 'archived'
                ? t('worldLibrary.emptyArchived', '归档里还没有世界。')
                : t('worldLibrary.emptyActive', '还没有活跃的世界。')}
            </p>
          ) : null}
          {(worlds ?? []).map((world) => (
            <article key={world.id} className="world-library-item">
              <div className="world-library-item__identity">
                <strong>
                  {world.name}
                  {world.id === activeWorldId ? <em className="world-library-badge">{t('worldLibrary.current', '当前世界')}</em> : null}
                </strong>
                <small>{t('worldLibrary.createdAt', '创建于 {date}', { date: formatDateTime(world.createdAt, { dateStyle: 'medium' }) })}</small>
              </div>
              <div className="world-library-item__actions">
                {world.status === 'archived' ? (
                  <>
                    <button type="button" className="secondary-button" disabled={busyWorldId === world.id} onClick={() => void changeLifecycle(world, 'restore')}>
                      <ArrowCounterClockwise size={14} />
                      {t('worldLibrary.restore', '恢复')}
                    </button>
                    <button type="button" className="danger-button" disabled={busyWorldId === world.id} onClick={() => { setNotice(undefined); setError(undefined); setPendingDelete(world) }}>
                      <Trash size={14} />
                      {t('worldLibrary.delete', '永久删除')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="secondary-button" disabled={busyWorldId === world.id} onClick={() => void changeLifecycle(world, 'archive')}>
                    <Archive size={14} />
                    {t('worldLibrary.archive', '归档')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      {pendingDelete === undefined ? null : (
        <WorldDeleteConfirmDialog
          world={pendingDelete}
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={(confirmName) => deleteWorld(pendingDelete, confirmName)}
        />
      )}
    </div>
  )
}

export interface WorldDeleteConfirmDialogProps {
  world: World
  onCancel(): void
  /** Rejects with the server's refusal; this dialog renders it in place. */
  onConfirm(confirmName: string): Promise<void>
}

/**
 * Permanent-delete gate. The owner has to re-type the world name; the typed
 * value is sent to the server, which independently re-checks it. This dialog
 * only refuses to submit an obviously wrong name — it never decides that a
 * deletion is allowed.
 */
export function WorldDeleteConfirmDialog({ world, onCancel, onConfirm }: WorldDeleteConfirmDialogProps) {
  const { t } = useI18n()
  const [typedName, setTypedName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)

  useDialogFocusTrap(dialogRef, onCancel)

  const matches = typedName.trim() === world.name

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!matches || submitting) return
    setSubmitting(true)
    setError(undefined)
    try {
      await onConfirm(typedName.trim())
    } catch (cause) {
      setError(worldLifecycleErrorMessage(cause, t))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop world-library-confirm-backdrop" role="presentation">
      <section ref={dialogRef} className="world-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="world-delete-title">
        <form onSubmit={(event) => void submit(event)}>
          <h2 id="world-delete-title">{t('worldLibrary.deleteTitle', '永久删除「{name}」', { name: world.name })}</h2>
          <p className="world-delete-dialog__warning">
            <WarningCircle size={16} />
            {t('worldLibrary.deleteWarning', '这个世界的角色、会话、知识和文件都会被永久删除，无法恢复。')}
          </p>
          <label className="dialog-field">
            <span>{t('worldLibrary.deletePrompt', '请准确输入世界名称「{name}」以确认', { name: world.name })}</span>
            <input
              data-dialog-initial-focus
              value={typedName}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!matches}
              aria-describedby="world-delete-hint"
              onChange={(event) => { setTypedName(event.target.value); setError(undefined) }}
            />
          </label>
          <p id="world-delete-hint" className="world-delete-dialog__hint">
            {matches
              ? t('worldLibrary.deleteReady', '名称一致，可以永久删除。')
              : t('worldLibrary.deleteMismatch', '名称还不一致，完全一致后才能删除。')}
          </p>
          {error === undefined ? null : <p className="world-library-feedback is-error" role="alert"><WarningCircle size={16} />{error}</p>}
          <div className="world-delete-dialog__actions">
            <button type="button" className="secondary-button" onClick={onCancel}>{t('worldLibrary.cancel', '取消')}</button>
            <button type="submit" className="danger-button" disabled={!matches || submitting}>
              {submitting ? t('worldLibrary.deleting', '正在删除…') : t('worldLibrary.delete', '永久删除')}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

/**
 * Turns a lifecycle refusal into copy the owner can act on. The "still running"
 * conflict is the one an owner meets in normal use, so it names the way out
 * instead of reporting a generic failure.
 */
export function worldLifecycleErrorMessage(cause: unknown, t: Translate): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'world_has_active_work') {
      return t(
        'worldLibrary.deleteBlocked',
        '这个世界还有进行中的任务或角色运行，暂时不能删除。请先停止它们，或等它们结束后再试。',
      )
    }
    if (cause.code === 'world_name_confirmation_mismatch') {
      return t('worldLibrary.deleteNameMismatch', '世界名称输入不一致，请重新输入完全一致的名称。')
    }
    if (cause.code === 'world_already_archived') return t('worldLibrary.alreadyArchived', '这个世界已经归档了。')
    if (cause.code === 'world_not_archived') return t('worldLibrary.notArchived', '这个世界没有归档，无需恢复。')
    return cause.message
  }
  return t('worldLibrary.actionError', '操作失败，请稍后重试。')
}
