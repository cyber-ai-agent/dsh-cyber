import { useState, useRef } from 'react'
import {
  Check,
  FloppyDisk,
  Image,
  Palette,
  Sparkle,
  Trash,
  UploadSimple,
  X,
} from '@phosphor-icons/react'
import type { World } from '@dsh-cyber/contracts'
import { api } from '../api.js'
import { getLocalizedThemeText } from '../i18n/appearance-messages.js'
import { useI18n } from '../i18n/runtime.js'
import {
  applyWorldTheme,
  DEFAULT_SKIN_ID,
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
  const { locale, t } = useI18n()
  const baseTheme = themeRegistry.get(initialThemeId ?? DEFAULT_SKIN_ID)
  const baseThemeText = getLocalizedThemeText(baseTheme, locale)
  const isCustom = baseTheme.source === 'custom'

  const [id] = useState(() =>
    isCustom ? baseTheme.id : `custom-${Date.now().toString(36)}`
  )
  const [displayName, setDisplayName] = useState(
    isCustom ? baseTheme.displayName : `${baseThemeText.displayName} ${t('appearance.editor.customSuffix', '（自定义）')}`
  )
  const [description, setDescription] = useState(
    (isCustom ? baseTheme.description : baseThemeText.description) || t('appearance.editor.defaultDescription', '用户自定义主题')
  )

  const [tokens, setTokens] = useState<WorldThemeTokens>(() => ({
    ...baseTheme.tokens,
  }))

  const [previewActive, setPreviewActive] = useState(false)
  const [uploadingAsset, setUploadingAsset] = useState<string>()
  const [assetError, setAssetError] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)

  const close = () => {
    // 恢复之前应用的主题
    if (previewActive) {
      applyWorldTheme(initialThemeId ?? DEFAULT_SKIN_ID)
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
        author: t('appearance.editor.author.editing', '当前正在编辑'),
        source: 'custom',
        tokens,
      }
      themeRegistry.saveCustomTheme(tempConfig)
      applyWorldTheme(id)
      setPreviewActive(true)
    } else {
      applyWorldTheme(initialThemeId ?? DEFAULT_SKIN_ID)
      setPreviewActive(false)
    }
  }

  const handleSave = () => {
    const newTheme: WorldThemeConfig = {
      id,
      displayName: displayName.trim() || t('appearance.editor.unnamed', '未命名自定义主题'),
      description: description.trim(),
      author: t('appearance.editor.author.custom', '用户自定义'),
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
    if (window.confirm(t('appearance.editor.deleteConfirm', '确定删除自定义主题【{name}】吗？', { name: displayName }))) {
      themeRegistry.deleteCustomTheme(id)
      saveWorldTheme(world.id, DEFAULT_SKIN_ID)
      applyWorldTheme(DEFAULT_SKIN_ID)
      onSaved(DEFAULT_SKIN_ID)
      onClose()
    }
  }

  const uploadAsset = async (key: 'scene' | 'characterLeftImage' | 'characterRightImage', file: File) => {
    setAssetError(undefined)
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setAssetError(t('appearance.editor.error.fileType', '仅支持 PNG、JPEG 或 WebP 图片。'))
      return
    }
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      setAssetError(t('appearance.editor.error.fileSize', '图片大小必须在 1 字节到 5 MiB 之间。'))
      return
    }
    setUploadingAsset(key)
    try {
      const result = await api<{ asset: { id: string } }>(`/api/workspaces/${encodeURIComponent(world.workspaceId)}/assets/background`, {
        method: 'POST',
        body: JSON.stringify({ mimeType: file.type, dataBase64: await fileToBase64(file) }),
      })
      const url = `/api/assets/${encodeURIComponent(result.asset.id)}`
      if (key === 'scene') {
        updateToken('backdropImage', url)
        updateToken('worldMapImage', url)
      } else {
        updateToken(key, url)
      }
    } catch (cause) {
      setAssetError(cause instanceof Error && cause.message !== 'theme_asset_read_failed'
        ? cause.message
        : t('appearance.editor.error.upload', '图片上传失败，请重试。'))
    } finally {
      setUploadingAsset(undefined)
    }
  }

  const removeAsset = (key: 'scene' | 'characterLeftImage' | 'characterRightImage') => {
    if (key === 'scene') {
      updateToken('backdropImage', undefined)
      updateToken('worldMapImage', undefined)
    } else {
      updateToken(key, undefined)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section ref={dialogRef} className="theme-customizer-dialog" role="dialog" aria-modal="true" aria-labelledby="theme-customizer-title">
        <header className="theme-customizer-dialog__header">
          <div>
            <h2 id="theme-customizer-title">
              <Palette size={20} />
              <span>{isCustom ? t('appearance.editor.title.edit', '编辑自定义皮肤') : t('appearance.editor.title.create', '新建自定义世界皮肤')}</span>
            </h2>
            <p>{t('appearance.editor.description', '修改强调色、背景、气泡与素材，打造专属于【{world}】的独特空间风格。', { world: world.name })}</p>
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label={t('appearance.editor.close', '关闭')}>
            <X size={18} />
          </button>
        </header>

        <div className="theme-customizer-dialog__body">
          {/* 基本信息 */}
          <fieldset className="theme-customizer-section">
            <legend>{t('appearance.editor.basic.title', '基础信息')}</legend>
            <div className="theme-customizer-row">
              <label>
                <span>{t('appearance.editor.basic.name', '皮肤名称')}</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t('appearance.editor.basic.namePlaceholder', '例如：赛博粉晶 / 极夜星环')}
                />
              </label>
              <label>
                <span>{t('appearance.editor.basic.description', '皮肤说明')}</span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('appearance.editor.basic.descriptionPlaceholder', '简短描述该主题的风格氛围')}
                />
              </label>
            </div>
          </fieldset>

          {/* 核心色彩令牌 */}
          <fieldset className="theme-customizer-section">
            <legend>{t('appearance.editor.colors.title', '核心色彩配置')}</legend>
            <div className="theme-customizer-colors">
              <div className="theme-color-field">
                <span>{t('appearance.editor.colors.accent', '核心强调色')}</span>
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
                      title={t('appearance.editor.colors.preset', '选择预设色 {color}', { color })}
                    />
                  ))}
                </div>
              </div>

              <div className="theme-color-field">
                <span>{t('appearance.editor.colors.pageBackground', '主背景色')}</span>
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
                <span>{t('appearance.editor.colors.userBubble', '你的气泡底色')}</span>
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
                <span>{t('appearance.editor.colors.characterBubble', '角色气泡底色')}</span>
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

          {/* 本机上传的统一场景与立绘素材 */}
          <fieldset className="theme-customizer-section">
            <legend>{t('appearance.editor.assets.title', '场景与立绘素材（可选）')}</legend>
            <div className="theme-customizer-assets">
              <ThemeAssetUpload
                label={t('appearance.editor.assets.scene', '统一全景场景')}
                description={t('appearance.editor.assets.sceneDescription', '同一张图片用于聊天背景与 2.5D 世界，避免两个区域显示不同房间。')}
                value={tokens.worldMapImage ?? tokens.backdropImage}
                uploading={uploadingAsset === 'scene'}
                onUpload={(file) => void uploadAsset('scene', file)}
                onRemove={() => removeAsset('scene')}
              />
              <div className="theme-customizer-row theme-customizer-row--assets">
                <ThemeAssetUpload label={t('appearance.editor.assets.left', '左侧陪伴立绘')} description={t('appearance.editor.assets.companionDescription', '建议上传透明背景 PNG 或 WebP。')} value={tokens.characterLeftImage} uploading={uploadingAsset === 'characterLeftImage'} onUpload={(file) => void uploadAsset('characterLeftImage', file)} onRemove={() => removeAsset('characterLeftImage')} />
                <ThemeAssetUpload label={t('appearance.editor.assets.right', '右侧陪伴立绘')} description={t('appearance.editor.assets.companionDescription', '建议上传透明背景 PNG 或 WebP。')} value={tokens.characterRightImage} uploading={uploadingAsset === 'characterRightImage'} onUpload={(file) => void uploadAsset('characterRightImage', file)} onRemove={() => removeAsset('characterRightImage')} />
              </div>
              <small className="theme-asset-help">{t('appearance.editor.assets.help', '支持 PNG、JPEG、WebP，单张最大 5 MiB；图片仅保存在当前设备。')}</small>
              {assetError === undefined ? null : <p className="theme-asset-error" role="alert">{assetError}</p>}
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
              {t('appearance.editor.preview.character', '管家：主人，这里是当前皮肤的实时效果预览。')}
            </span>
            <span
              className="preview-bubble is-user"
              style={{
                background: tokens.ownerBubbleColor,
                borderColor: tokens.accentColor,
                color: tokens.textColor ?? '#fff',
              }}
            >
              {t('appearance.editor.preview.user', '你：配色很和谐，保存后将在当前世界永久生效！')}
            </span>
          </div>
        </div>

        <footer className="theme-customizer-dialog__footer">
          {isCustom ? (
            <button type="button" className="danger-button" onClick={handleDelete}>
              <Trash size={15} />
              <span>{t('appearance.editor.delete', '删除此皮肤')}</span>
            </button>
          ) : <div />}

          <div className="theme-customizer-actions">
            <button
              type="button"
              className={`secondary-button${previewActive ? ' is-active' : ''}`}
              onClick={togglePreview}
            >
              <Sparkle size={15} />
              <span>{previewActive ? t('appearance.editor.preview.exit', '退出实时预览') : t('appearance.editor.preview.start', '开启全局实时预览')}</span>
            </button>
            <button type="button" className="text-button" onClick={close}>
              {t('appearance.editor.cancel', '取消')}
            </button>
            <button type="button" className="primary-button" onClick={handleSave}>
              <FloppyDisk size={16} />
              <span>{t('appearance.editor.save', '保存并应用到当前世界')}</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function ThemeAssetUpload({
  label,
  description,
  value,
  uploading,
  onUpload,
  onRemove,
}: {
  label: string
  description: string
  value: string | undefined
  uploading: boolean
  onUpload(file: File): void
  onRemove(): void
}) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <article className="theme-asset-upload">
      <div className="theme-asset-upload__preview">
        {value === undefined ? <Image size={28} aria-hidden="true" /> : <img src={value} alt="" />}
      </div>
      <div className="theme-asset-upload__copy">
        <strong>{label}</strong>
        <small>{description}</small>
        <div>
          <button type="button" className="secondary-button" disabled={uploading} onClick={() => inputRef.current?.click()}>
            <UploadSimple size={15} />{uploading ? t('appearance.editor.assets.uploading', '正在上传…') : value === undefined ? t('appearance.editor.assets.choose', '选择图片') : t('appearance.editor.assets.replace', '替换图片')}
          </button>
          {value === undefined ? null : <button type="button" className="text-button" disabled={uploading} onClick={onRemove}>{t('appearance.editor.assets.remove', '移除')}</button>}
        </div>
      </div>
      <input ref={inputRef} className="theme-asset-upload__input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
        const file = event.target.files?.[0]
        if (file !== undefined) onUpload(file)
        event.currentTarget.value = ''
      }} />
    </article>
  )
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('theme_asset_read_failed'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}
