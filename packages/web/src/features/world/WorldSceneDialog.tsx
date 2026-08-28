import { Buildings, CheckCircle, MapTrifold, SpinnerGap, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { World, WorldThemeManifestV1, WorldThemeOption } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { useDialogFocusTrap } from '../../components/useDialogFocusTrap.js'
import './WorldSceneDialog.css'

interface WorldSceneDialogProps {
  world: World
  currentManifest: WorldThemeManifestV1
  onClose(): void
  onApplied(): Promise<void>
}

interface WorldSceneListResponse {
  activeThemeId: string
  items: WorldThemeOption[]
}

export function WorldSceneDialog({ world, currentManifest, onClose, onApplied }: WorldSceneDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const [items, setItems] = useState<WorldThemeOption[]>([])
  const [activeThemeId, setActiveThemeId] = useState(currentManifest.id)
  const [loading, setLoading] = useState(true)
  const [applyingId, setApplyingId] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useDialogFocusTrap(dialogRef, onClose)

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await api<WorldSceneListResponse>(`/api/worlds/${encodeURIComponent(world.id)}/themes`)
      setItems(result.items)
      setActiveThemeId(result.activeThemeId || currentManifest.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界场景加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // The selected World owns this dialog; reopening after a World switch remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.id])

  const active = useMemo(
    () => items.find((item) => item.active || item.themeId === activeThemeId),
    [activeThemeId, items],
  )

  const apply = async (item: WorldThemeOption) => {
    if (applyingId !== undefined || item.themeId === activeThemeId) return
    setApplyingId(item.themeId)
    setError(undefined)
    setNotice(undefined)
    try {
      const body = item.source === 'built-in'
        ? { action: 'fallback' }
        : { action: 'bind', packageId: item.packageId }
      await api(`/api/worlds/${encodeURIComponent(world.id)}/theme-binding`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      await onApplied()
      setActiveThemeId(item.themeId)
      setItems((current) => current.map((candidate) => ({
        ...candidate,
        active: candidate.themeId === item.themeId,
      })))
      setNotice(`已将「${item.displayName}」应用到 ${world.name}。切换系统皮肤不会改变这个场景。`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界场景应用失败')
    } finally {
      setApplyingId(undefined)
    }
  }

  return (
    <div className="modal-backdrop world-scene-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="world-scene-dialog" role="dialog" aria-modal="true" aria-labelledby="world-scene-dialog-title">
        <header className="world-scene-dialog__header">
          <div className="world-scene-dialog__identity">
            <span className="world-scene-dialog__icon"><MapTrifold size={20} weight="fill" /></span>
            <div>
              <h2 id="world-scene-dialog-title">世界场景 · {world.name}</h2>
              <p>场景属于当前世界，负责角色站位、工位、会议区和互动空间；系统皮肤只影响界面与聊天氛围。</p>
            </div>
          </div>
          <button data-dialog-initial-focus type="button" className="icon-button" aria-label="关闭世界场景" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="world-scene-dialog__current">
          <Buildings size={18} />
          <div>
            <span>当前场景</span>
            <strong>{active?.displayName ?? currentManifest.displayName}</strong>
          </div>
          <small>独立于 Skin</small>
        </div>

        {notice === undefined ? null : <div className="world-scene-dialog__feedback is-success" role="status"><CheckCircle size={16} />{notice}</div>}
        {error === undefined ? null : <div className="world-scene-dialog__feedback is-error" role="alert">{error}</div>}

        {loading ? (
          <div className="world-scene-dialog__loading"><SpinnerGap size={22} className="spin" />正在读取当前世界可用场景…</div>
        ) : (
          <div className="world-scene-dialog__grid">
            {items.map((item) => {
              const selected = item.active || item.themeId === activeThemeId
              const applying = applyingId === item.themeId
              return (
                <button
                  key={`${item.source}:${item.packageId ?? 'builtin'}:${item.themeId}:${item.version}`}
                  type="button"
                  className={`world-scene-card${selected ? ' is-active' : ''}`}
                  disabled={applyingId !== undefined}
                  onClick={() => void apply(item)}
                >
                  <span className="world-scene-card__preview"><Buildings size={30} /></span>
                  <span className="world-scene-card__body">
                    <strong>{item.displayName}</strong>
                    <small>{item.source === 'built-in' ? 'DSH 默认场景' : `已安装场景 · ${item.packageId ?? '扩展包'}`}</small>
                    <code>{item.themeId}</code>
                  </span>
                  <span className="world-scene-card__state">
                    {applying ? <SpinnerGap size={16} className="spin" /> : selected ? <CheckCircle size={17} weight="fill" /> : '应用'}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <footer className="world-scene-dialog__footer">
          <span>Skin = UI + 会话背景</span>
          <span>World Scene = 世界空间 + 角色活动区域</span>
        </footer>
      </section>
    </div>
  )
}
