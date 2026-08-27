import { useState, useRef } from 'react'
import {
  Check,
  FloppyDisk,
  Image,
  Palette,
  Sparkle,
  Trash,
  X,
} from '@phosphor-icons/react'
import type { World } from '@dsh-cyber/contracts'
import {
  applyWorldTheme,
  saveWorldTheme,
  themeRegistry,
  type WorldThemeConfig,
  type WorldThemeTokens,
} from '../features/world/world-themes.js'
import { useDialogFocusTrap } from './useDialogFocusTrap.js'

interface ThemeCustomizerDialogProps {
  world: World
  initialThemeId?: string | undefined
  onClose(): void
  onSaved(themeId: string): void
}

const PRESET_ACCENTS = [
  '#38bdf8', // 蔚蓝
  '#00e5ff', // 赛博电青
  '#d7a52a', // 琥珀金
  '#a855f7', // 霓虹紫
  '#f43f5e', // 绯红
  '#10b981', // 翡翠绿
  '#f59e0b', // 暖橙
  '#ec4899', // 樱粉
]

export function ThemeCustomizerDialog({
  world,
  initialThemeId,
  onClose,
  onSaved,
}: ThemeCustomizerDialogProps) {
  const baseTheme = themeRegistry.get(initialThemeId ?? 'maid-atelier')
  const isCustom = baseTheme.source === 'custom'

  const [id] = useState(() =>
    isCustom ? baseTheme.id : `custom-${Date.now().toString(36)}`
  )
  const [displayName, setDisplayName] = useState(
    isCustom ? baseTheme.displayName : `${baseTheme.displayName} (自定义)`
  )
  const [description, setDescription] = useState(
    baseTheme.description ?? '用户自定义主题'
  )

  const [tokens, setTokens] = useState<WorldThemeTokens>(() => ({
    ...baseTheme.tokens,
  }))

  const [previewActive, setPreviewActive] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)

  const close = () => {
    // 恢复之前应用的主题
    if (previewActive) {
      applyWorldTheme(initialThemeId ?? 'maid-atelier')
    }
    onClose()
  }

  useDialogFocusTrap(dialogRef, close)

  const updateToken = <K extends keyof WorldThemeTokens>(key: K, value: WorldThemeTokens[K]) => {
    setTokens((prev) => {
      const next = { ...prev, [key]: value }
      if (previewActive) {
        // 动态实时预览当前编辑的变量
        const root = document.documentElement
        if (key === 'accentColor') root.style.setProperty('--theme-accent', String(value))
        if (key === 'pageBackground') root.style.setProperty('--theme-bg', String(value))
        if (key === 'panelBackground') root.style.setProperty('--theme-panel', String(value))
        if (key === 'ownerBubbleColor') root.style.setProperty('--theme-owner-bubble', String(value))
        if (key === 'characterBubbleColor') root.style.setProperty('--theme-character-bubble', String(value))
      }
      return next
    })
  }

  const togglePreview = () => {
    if (!previewActive) {
      // 开启实时预览
      const tempConfig: WorldThemeConfig = {
        id,
        displayName,
        description,
        author: '当前正在编辑',
        source: 'custom',
        tokens,
      }
      themeRegistry.saveCustomTheme(tempConfig)
      applyWorldTheme(id)
      setPreviewActive(true)
    } else {
      applyWorldTheme(initialThemeId ?? 'maid-atelier')
      setPreviewActive(false)
    }
  }

  const handleSave = () => {
    const newTheme: WorldThemeConfig = {
      id,
      displayName: displayName.trim() || '未命名自定义主题',
      description: description.trim(),
      author: '用户自定义',
      source: 'custom',
      tokens,
    }
    themeRegistry.saveCustomTheme(newTheme)
    saveWorldTheme(world.id, id)
    applyWorldTheme(id)
    onSaved(id)
    onClose()
  }

  const handleDelete = () => {
    if (!isCustom) return
    if (window.confirm(`确定删除自定义主题【${displayName}】吗？`)) {
      themeRegistry.deleteCustomTheme(id)
      saveWorldTheme(world.id, 'maid-atelier')
      applyWorldTheme('maid-atelier')
      onSaved('maid-atelier')
      onClose()
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section ref={dialogRef} className="theme-customizer-dialog" role="dialog" aria-modal="true" aria-labelledby="theme-customizer-title">
        <header className="theme-customizer-dialog__header">
          <div>
            <h2 id="theme-customizer-title">
              <Palette size={20} />
              <span>{isCustom ? '编辑自定义主题' : '新建自定义世界主题'}</span>
            </h2>
            <p>修改强调色、背景、气泡与素材，打造专属于【{world.name}】的独特空间风格。</p>
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="theme-customizer-dialog__body">
          {/* 基本信息 */}
          <fieldset className="theme-customizer-section">
            <legend>基础信息</legend>
            <div className="theme-customizer-row">
              <label>
                <span>主题名称</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="例如：赛博粉晶 / 极夜星环"
                />
              </label>
              <label>
                <span>主题说明</span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="简短描述该主题的风格氛围"
                />
              </label>
            </div>
          </fieldset>

          {/* 核心色彩令牌 */}
          <fieldset className="theme-customizer-section">
            <legend>核心色彩配置</legend>
            <div className="theme-customizer-colors">
              <div className="theme-color-field">
                <span>核心强调色 (Accent)</span>
                <div className="theme-color-input-wrap">
                  <input
                    type="color"
                    value={tokens.accentColor}
                    onChange={(e) => updateToken('accentColor', e.target.value)}
                  />
                  <code>{tokens.accentColor}</code>
                </div>
                <div className="theme-preset-accents">
                  {PRESET_ACCENTS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      style={{ background: color }}
                      className={tokens.accentColor.toLowerCase() === color.toLowerCase() ? 'is-selected' : ''}
                      onClick={() => updateToken('accentColor', color)}
                      title={`选择预设色 ${color}`}
                    />
                  ))}
                </div>
              </div>

              <div className="theme-color-field">
                <span>主背景色 (Page Background)</span>
                <div className="theme-color-input-wrap">
                  <input
                    type="color"
                    value={tokens.pageBackground.startsWith('#') ? tokens.pageBackground : '#070e17'}
                    onChange={(e) => updateToken('pageBackground', e.target.value)}
                  />
                  <code>{tokens.pageBackground}</code>
                </div>
              </div>

              <div className="theme-color-field">
                <span>你的气泡底色 (User Message)</span>
                <div className="theme-color-input-wrap">
                  <input
                    type="color"
                    value={tokens.ownerBubbleColor.startsWith('#') ? tokens.ownerBubbleColor : '#122648'}
                    onChange={(e) => updateToken('ownerBubbleColor', e.target.value)}
                  />
                  <code>{tokens.ownerBubbleColor}</code>
                </div>
              </div>

              <div className="theme-color-field">
                <span>角色气泡底色 (Character Message)</span>
                <div className="theme-color-input-wrap">
                  <input
                    type="color"
                    value={tokens.characterBubbleColor.startsWith('#') ? tokens.characterBubbleColor : '#0a1630'}
                    onChange={(e) => updateToken('characterBubbleColor', e.target.value)}
                  />
                  <code>{tokens.characterBubbleColor}</code>
                </div>
              </div>
            </div>
          </fieldset>

          {/* 全景壁纸与立绘素材 */}
          <fieldset className="theme-customizer-section">
            <legend>全景壁纸与立绘素材 (可选)</legend>
            <div className="theme-customizer-assets">
              <label>
                <span>全景背景大图 (URL 或 /assets/...)</span>
                <input
                  type="text"
                  value={tokens.backdropImage ?? ''}
                  onChange={(e) => updateToken('backdropImage', e.target.value)}
                  placeholder="如: /assets/whale-palace-night.jpg 或自定义图片 URL"
                />
              </label>

              <div className="theme-customizer-row">
                <label>
                  <span>左侧陪伴立绘 (URL)</span>
                  <input
                    type="text"
                    value={tokens.characterLeftImage ?? ''}
                    onChange={(e) => updateToken('characterLeftImage', e.target.value)}
                    placeholder="如: /assets/whale-maid-left.jpg"
                  />
                </label>
                <label>
                  <span>右侧陪伴立绘 (URL)</span>
                  <input
                    type="text"
                    value={tokens.characterRightImage ?? ''}
                    onChange={(e) => updateToken('characterRightImage', e.target.value)}
                    placeholder="如: /assets/whale-maid-right.jpg"
                  />
                </label>
              </div>

              <label>
                <span>2.5D 世界场景底图 (World Map URL)</span>
                <input
                  type="text"
                  value={tokens.worldMapImage ?? ''}
                  onChange={(e) => updateToken('worldMapImage', e.target.value)}
                  placeholder="如: /assets/skins/maid-palace-night.webp 或自定义场景图"
                />
              </label>
            </div>
          </fieldset>

          {/* 实时微预览 */}
          <div
            className="theme-live-preview-box"
            style={{
              background: tokens.pageBackground,
              borderColor: tokens.accentColor,
            }}
          >
            <span
              className="preview-bubble is-char"
              style={{
                background: tokens.characterBubbleColor,
                borderColor: `color-mix(in srgb, ${tokens.accentColor} 35%, transparent)`,
                color: tokens.textColor ?? '#fff',
              }}
            >
              管家：主人，这里是当前主题的实时效果预览。
            </span>
            <span
              className="preview-bubble is-user"
              style={{
                background: tokens.ownerBubbleColor,
                borderColor: tokens.accentColor,
                color: tokens.textColor ?? '#fff',
              }}
            >
              你：配色很和谐，保存后将在当前世界永久生效！
            </span>
          </div>
        </div>

        <footer className="theme-customizer-dialog__footer">
          {isCustom ? (
            <button type="button" className="danger-button" onClick={handleDelete}>
              <Trash size={15} />
              <span>删除此主题</span>
            </button>
          ) : <div />}

          <div className="theme-customizer-actions">
            <button
              type="button"
              className={`secondary-button${previewActive ? ' is-active' : ''}`}
              onClick={togglePreview}
            >
              <Sparkle size={15} />
              <span>{previewActive ? '退出实时预览' : '开启全局实时预览'}</span>
            </button>
            <button type="button" className="text-button" onClick={close}>
              取消
            </button>
            <button type="button" className="primary-button" onClick={handleSave}>
              <FloppyDisk size={16} />
              <span>保存并应用到当前世界</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
