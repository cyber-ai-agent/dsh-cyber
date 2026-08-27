import { useEffect, useRef, useState } from 'react'
import { CaretDown, Check, Palette, PencilSimple, Plus } from '@phosphor-icons/react'
import type { World } from '@dsh-cyber/contracts'
import {
  applyWorldTheme,
  readWorldTheme,
  saveWorldTheme,
  themeRegistry,
  type WorldThemeConfig,
} from '../features/world/world-themes.js'
import { ThemeCustomizerDialog } from './ThemeCustomizerDialog.js'

interface WorldThemeSwitcherProps {
  activeWorld: World
  onThemeChange?(themeId: string): void
}

export function WorldThemeSwitcher({ activeWorld, onThemeChange }: WorldThemeSwitcherProps) {
  const [currentThemeId, setCurrentThemeId] = useState<string>(() => readWorldTheme(activeWorld))
  const [open, setOpen] = useState(false)
  const [customizerOpen, setCustomizerOpen] = useState(false)
  const [customizerThemeId, setCustomizerThemeId] = useState<string | undefined>()
  const menuRef = useRef<HTMLDivElement>(null)

  // 当切换世界时，自动同步为该世界的主题
  useEffect(() => {
    const theme = readWorldTheme(activeWorld)
    setCurrentThemeId(theme)
    applyWorldTheme(theme)
  }, [activeWorld])

  // 点击外部关闭下拉菜单
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

  const themes = themeRegistry.list()
  const currentTheme = themeRegistry.get(currentThemeId)

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
          title="切换当前世界的主题风格"
        >
          <span
            className="world-theme-dot"
            style={{
              background: currentTheme.tokens.accentColor,
              boxShadow: `0 0 6px ${currentTheme.tokens.accentColor}`,
            }}
          />
          <Palette size={13} aria-hidden="true" />
          <span>主题: {currentTheme.displayName}</span>
          <CaretDown size={11} className={open ? 'is-expanded' : ''} aria-hidden="true" />
        </button>

        {open && (
          <div className="topbar-world-theme-menu" role="menu" aria-label="世界主题列表">
            <header className="topbar-world-theme-menu__header">
              <div>
                <strong>世界专属主题</strong>
                <small>为【{activeWorld.name}】选择或定制空间风格</small>
              </div>
              {currentTheme.source === 'custom' ? (
                <button
                  type="button"
                  className="theme-menu-action-btn"
                  onClick={() => openCustomizer(currentTheme.id)}
                  title="编辑当前自定义主题"
                >
                  <PencilSimple size={13} />
                  <span>编辑</span>
                </button>
              ) : null}
            </header>

            <div className="topbar-world-theme-menu__items">
              {themes.map((theme) => {
                const selected = theme.id === currentThemeId
                const sourceBadge =
                  theme.source === 'custom'
                    ? '自定义'
                    : theme.source === 'package'
                    ? '插件包'
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
                        background: `linear-gradient(135deg, ${theme.tokens.accentColor} 0%, ${theme.tokens.pageBackground} 100%)`,
                        borderColor: theme.tokens.accentColor,
                      }}
                    >
                      <i style={{ background: theme.tokens.accentColor, color: theme.tokens.accentColor }} />
                    </span>
                    <div className="world-theme-info">
                      <div className="world-theme-name-row">
                        <strong>{theme.displayName}</strong>
                        {sourceBadge ? <span className="theme-source-badge">{sourceBadge}</span> : null}
                      </div>
                      <small>{theme.description}</small>
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
                <span>基于当前主题新建自定义...</span>
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
