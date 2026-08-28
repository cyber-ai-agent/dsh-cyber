import { useEffect, useRef, useState } from 'react'
import { CaretDown, Check, Palette, PencilSimple, Plus } from '@phosphor-icons/react'
import type { World } from '@dsh-cyber/contracts'
import { getLocalizedThemeText } from '../i18n/appearance-messages.js'
import { useI18n } from '../i18n/runtime.js'
import {
  applyWorldTheme,
  DEFAULT_SKIN_ID,
  readWorldTheme,
  saveWorldTheme,
  themeRegistry,
  type WorldThemeConfig,
} from '../features/world/world-themes.js'
import { ThemeCustomizerDialog } from './ThemeCustomizerDialog.js'

interface WorldThemeSwitcherProps {
  activeWorld: World
  installedSkinIds?: readonly string[]
  onThemeChange?(themeId: string): void
}

export function WorldThemeSwitcher({ activeWorld, installedSkinIds, onThemeChange }: WorldThemeSwitcherProps) {
  const { locale, t } = useI18n()
  const [currentThemeId, setCurrentThemeId] = useState<string>(() => readWorldTheme(activeWorld))
  const [open, setOpen] = useState(false)
  const [customizerOpen, setCustomizerOpen] = useState(false)
  const [customizerThemeId, setCustomizerThemeId] = useState<string | undefined>()
  const menuRef = useRef<HTMLDivElement>(null)

  // 每个 World 可以保留自己的会话氛围偏好，但这份 Skin 不再驱动 World Runtime Scene。
  useEffect(() => {
    const persisted = readWorldTheme(activeWorld)
    const available = themeRegistry.listAvailable(installedSkinIds ?? [])
    const theme = available.some((candidate) => candidate.id === persisted) ? persisted : DEFAULT_SKIN_ID
    if (theme !== persisted) saveWorldTheme(activeWorld.id, theme)
    setCurrentThemeId(theme)
    applyWorldTheme(theme)
  }, [activeWorld, installedSkinIds])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const themes = themeRegistry.listAvailable(installedSkinIds ?? [])
  const resolvedCurrentThemeId = themes.some((theme) => theme.id === currentThemeId) ? currentThemeId : DEFAULT_SKIN_ID
  const currentTheme = themeRegistry.get(resolvedCurrentThemeId)
  const currentThemeText = getLocalizedThemeText(currentTheme, locale)
  const currentThemeIsContent = currentTheme.source === 'custom' || currentTheme.source === 'package'

  const handleSelect = (theme: WorldThemeConfig) => {
    setCurrentThemeId(theme.id)
    saveWorldTheme(activeWorld.id, theme.id)
    setOpen(false)
    onThemeChange?.(theme.id)
  }

  const openCustomizer = (themeId?: string) => {
    setCustomizerThemeId(themeId)
    setCustomizerOpen(true)
    setOpen(false)
  }

  return (
    <>
      <div ref={menuRef} className="topbar-world-theme-container">
        <button
          type="button"
          className="topbar-world-theme-pill"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          title={t('appearance.theme.switchConversationTitle', '切换界面与会话皮肤，不改变当前世界场景')}
        >
          <span
            className="world-theme-dot"
            style={{
              background: currentTheme.tokens.accentColor,
              boxShadow: `0 0 6px ${currentTheme.tokens.accentColor}`,
            }}
          />
          <Palette size={13} aria-hidden="true" />
          <span>{t('appearance.theme.label', '皮肤')}: {currentThemeText.displayName}</span>
          {currentThemeIsContent ? <span className="theme-source-badge">{t('appearance.theme.content', '内容')}</span> : null}
          <CaretDown size={11} className={open ? 'is-expanded' : ''} aria-hidden="true" />
        </button>

        {open && (
          <div className="topbar-world-theme-menu" role="menu" aria-label={t('appearance.theme.conversationListLabel', '界面与会话皮肤列表')}>
            <header className="topbar-world-theme-menu__header">
              <div>
                <strong>{t('appearance.theme.conversationMenuTitle', '界面 / 会话皮肤')}</strong>
                <small>{t('appearance.theme.conversationMenuDescription', '改变【{world}】的聊天背景、气泡和界面氛围；右侧世界场景保持独立', { world: activeWorld.name })}</small>
              </div>
              {currentTheme.source === 'custom' ? (
                <button
                  type="button"
                  className="theme-menu-action-btn"
                  onClick={() => openCustomizer(currentTheme.id)}
                  title={t('appearance.theme.editCurrent', '编辑当前自定义皮肤')}
                >
                  <PencilSimple size={13} />
                  <span>{t('appearance.theme.edit', '编辑')}</span>
                </button>
              ) : null}
            </header>

            <div className="topbar-world-theme-menu__items">
              {themes.map((theme) => {
                const selected = theme.id === resolvedCurrentThemeId
                const previewImage = theme.tokens.backdropImage ?? theme.tokens.worldMapImage
                const themeText = getLocalizedThemeText(theme, locale)
                const sourceBadge =
                  theme.source === 'custom'
                    ? `${t('appearance.theme.content', '内容')} · ${t('appearance.theme.source.custom', '自定义')}`
                    : theme.source === 'package'
                    ? `${t('appearance.theme.content', '内容')} · ${t('appearance.theme.source.package', '扩展包')}`
                    : undefined

                return (
                  <button
                    key={theme.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`topbar-world-theme-menu__item${selected ? ' is-selected' : ''}`}
                    onClick={() => handleSelect(theme)}
                  >
                    <span
                      className="world-theme-swatch"
                      style={{
                        background: previewImage === undefined
                          ? `linear-gradient(135deg, ${theme.tokens.accentColor} 0%, ${theme.tokens.pageBackground} 100%)`
                          : `url("${previewImage}") center / cover`,
                        borderColor: theme.tokens.accentColor,
                      }}
                    >
                      {previewImage === undefined ? <i style={{ background: theme.tokens.accentColor, color: theme.tokens.accentColor }} /> : null}
                    </span>
                    <div className="world-theme-info">
                      <div className="world-theme-name-row">
                        <strong>{themeText.displayName}</strong>
                        {sourceBadge ? <span className="theme-source-badge">{sourceBadge}</span> : null}
                      </div>
                      <small>{themeText.description}</small>
                    </div>
                    {selected && <Check size={14} className="world-theme-check" />}
                  </button>
                )
              })}
            </div>

            <footer className="topbar-world-theme-menu__footer">
              <button
                type="button"
                className="theme-create-btn"
                onClick={() => openCustomizer(currentTheme.id)}
              >
                <Plus size={14} />
                <span>{t('appearance.theme.createConversationSkin', '基于当前会话皮肤新建自定义…')}</span>
              </button>
            </footer>
          </div>
        )}
      </div>

      {customizerOpen && (
        <ThemeCustomizerDialog
          world={activeWorld}
          initialThemeId={customizerThemeId}
          onClose={() => setCustomizerOpen(false)}
          onSaved={(newThemeId) => {
            setCurrentThemeId(newThemeId)
            onThemeChange?.(newThemeId)
          }}
        />
      )}
    </>
  )
}
