import { ArrowsClockwise, Buildings, CheckCircle, MapTrifold, SpinnerGap, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { World, WorldThemeManifestV1, WorldThemeOption } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { useDialogFocusTrap } from '../../components/useDialogFocusTrap.js'
import { useI18n } from '../../i18n/runtime.js'
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
  const { t } = useI18n()
  const dialogRef = useRef<HTMLElement>(null)
  const [items, setItems] = useState<WorldThemeOption[]>([])
  const [activeThemeId, setActiveThemeId] = useState(currentManifest.id)
  const [loading, setLoading] = useState(true)
  const [applyingId, setApplyingId] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const close = () => {
    if (applyingId === undefined) onClose()
  }

  useDialogFocusTrap(dialogRef, close)

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await api<WorldSceneListResponse>(`/api/worlds/${encodeURIComponent(world.id)}/themes`)
      setItems(result.items)
      setActiveThemeId(result.activeThemeId || currentManifest.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('worldScene.loadError', '世界场景加载失败'))
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

  const markApplied = (item: WorldThemeOption) => {
    setActiveThemeId(item.themeId)
    setItems((current) => current.map((candidate) => ({
      ...candidate,
      active: candidate.themeId === item.themeId,
    })))
  }

  const apply = async (item: WorldThemeOption) => {
    if (applyingId !== undefined || item.themeId === activeThemeId) return
    setApplyingId(item.themeId)
    setError(undefined)
    setNotice(undefined)

    const body = item.source === 'built-in'
      ? { action: 'fallback' }
      : { action: 'bind', packageId: item.packageId }

    try {
      await api(`/api/worlds/${encodeURIComponent(world.id)}/theme-binding`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('worldScene.applyError', '世界场景保存失败，请重试。'))
      setApplyingId(undefined)
      return
    }

    // The durable binding has already succeeded at this point. Keep local UI in
    // sync even if the subsequent live renderer refresh fails, so users never
    // see a false "save failed" message for a scene that is already persisted.
    markApplied(item)
    setNotice(t('worldScene.savedRefreshing', '场景已保存，正在刷新实时世界…'))

    try {
      await onApplied()
      setNotice(t('worldScene.applied', '已将「{scene}」应用到 {world}。切换系统皮肤不会改变这个场景。', {
        scene: item.displayName,
        world: world.name,
      }))
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : ''
      setError(t('worldScene.refreshError', '场景已经保存，但实时画面刷新失败。重新打开世界视图即可恢复。{detail}', {
        detail: detail ? ` ${detail}` : '',
      }))
      setNotice(undefined)
    } finally {
      setApplyingId(undefined)
    }
  }

  return (
    <div className="modal-backdrop world-scene-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={dialogRef} className="world-scene-dialog" role="dialog" aria-modal="true" aria-labelledby="world-scene-dialog-title" aria-busy={applyingId !== undefined}>
        <header className="world-scene-dialog__header">
          <div className="world-scene-dialog__identity">
            <span className="world-scene-dialog__icon"><MapTrifold size={20} weight="fill" /></span>
            <div>
              <h2 id="world-scene-dialog-title">{t('worldScene.title', '世界场景')} · {world.name}</h2>
              <p>{t('worldScene.description', '场景属于当前世界，负责角色站位、工位、会议区和互动空间；系统皮肤只影响界面与聊天氛围。')}</p>
            </div>
          </div>
          <button data-dialog-initial-focus type="button" className="icon-button" aria-label={t('worldScene.close', '关闭世界场景')} disabled={applyingId !== undefined} onClick={close}><X size={18} /></button>
        </header>

        <div className="world-scene-dialog__current">
          <Buildings size={18} />
          <div>
            <span>{t('worldScene.current', '当前场景')}</span>
            <strong>{active?.displayName ?? currentManifest.displayName}</strong>
          </div>
          <small>{t('worldScene.independent', '独立于 Skin')}</small>
        </div>

        {notice === undefined ? null : <div className="world-scene-dialog__feedback is-success" role="status"><CheckCircle size={16} />{notice}</div>}
        {error === undefined ? null : <div className="world-scene-dialog__feedback is-error" role="alert">{error}</div>}

        {loading ? (
          <div className="world-scene-dialog__loading"><SpinnerGap size={22} className="spin" />{t('worldScene.loading', '正在读取当前世界可用场景…')}</div>
        ) : error !== undefined && items.length === 0 ? (
          <div className="world-scene-dialog__loading">
            <span>{t('worldScene.retryHint', '暂时无法读取场景列表。')}</span>
            <button className="secondary-button" type="button" onClick={() => void load()}><ArrowsClockwise size={16} />{t('common.retry', '重试')}</button>
          </div>
        ) : items.length === 0 ? (
          <div className="world-scene-dialog__loading">{t('worldScene.empty', '当前没有可用的世界场景。默认空间仍会继续保留。')}</div>
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
                  aria-pressed={selected}
                  disabled={applyingId !== undefined || selected}
                  onClick={() => void apply(item)}
                >
                  <span className="world-scene-card__preview"><Buildings size={30} /></span>
                  <span className="world-scene-card__body">
                    <strong>{item.displayName}</strong>
                    <small>{item.source === 'built-in' ? t('worldScene.builtIn', 'DSH 默认场景') : t('worldScene.installed', '已安装场景 · {package}', { package: item.packageId ?? t('worldScene.extension', '扩展包') })}</small>
                    <code>{item.themeId}</code>
                  </span>
                  <span className="world-scene-card__state">
                    {applying ? <SpinnerGap size={16} className="spin" /> : selected ? <><CheckCircle size={17} weight="fill" /><span>{t('worldScene.active', '当前')}</span></> : t('worldScene.apply', '应用')}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <footer className="world-scene-dialog__footer">
          <span>{t('worldScene.skinDefinition', 'Skin = UI + 会话背景')}</span>
          <span>{t('worldScene.sceneDefinition', 'World Scene = 世界空间 + 角色活动区域')}</span>
        </footer>
      </section>
    </div>
  )
}
