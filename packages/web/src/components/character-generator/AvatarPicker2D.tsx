import { ImageSquare, UploadSimple } from '@phosphor-icons/react'
import type { CharacterGeneratorAvatarCatalogItem, CharacterGeneratorAvatarSelection } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'

interface AvatarPicker2DProps {
  options: CharacterGeneratorAvatarCatalogItem[]
  selection: CharacterGeneratorAvatarSelection | undefined
  onSelect(option: CharacterGeneratorAvatarCatalogItem): void
  onUpload(file: File): void
  disabled?: boolean
  error?: string | undefined
}

export function AvatarPicker2D({ options, selection, onSelect, onUpload, disabled = false, error }: AvatarPicker2DProps) {
  const { t } = useI18n()
  const uploaded = selection?.kind === 'upload' ? selection : undefined
  const selectedBuiltin = selection?.kind === 'builtin' ? options.find((option) => option.id === selection.id) : undefined
  return (
    <fieldset className="character-generator-avatar">
      <legend>{t('characterGenerator.avatarTitle', '2D 头像')}</legend>
      <div className="character-generator-avatar__preview">
        {uploaded === undefined && selectedBuiltin === undefined
          ? <ImageSquare size={48} aria-hidden="true" />
          : uploaded === undefined
            ? <img src={avatarPreviewUrl(selectedBuiltin!)} alt={selectedBuiltin!.displayName} />
            : <img src={`data:${uploaded.mimeType};base64,${uploaded.dataBase64}`} alt={t('characterGenerator.avatarSelected', '已选择图片：{name}', { name: uploaded.fileName })} />}
        <div>
          <strong>{uploaded === undefined ? selectedBuiltin?.displayName ?? t('characterGenerator.avatarBuiltIn', '内置头像') : uploaded.fileName}</strong>
          <span>{t('characterGenerator.avatarUploadHint', '支持 PNG、JPEG、WebP，最大 5 MiB。')}</span>
        </div>
      </div>
      <div className="character-generator-avatar__actions">
        <label className="character-generator-upload-button">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            disabled={disabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) onUpload(file)
            }}
          />
          <UploadSimple size={17} aria-hidden="true" />
          {t('characterGenerator.avatarUpload', '上传图片')}
        </label>
        {uploaded === undefined ? null : <span className="character-generator-avatar__file" role="status">{t('characterGenerator.avatarSelected', '已选择图片：{name}', { name: uploaded.fileName })}</span>}
      </div>
      <div className="character-generator-avatar__options" role="group" aria-label={t('characterGenerator.avatarFallback', '选择一个内置头像')}>
        {options.map((option) => {
          const selected = selection?.kind === 'builtin' && selection.id === option.id
          const label = option.displayName
          return (
            <button
              key={option.id}
              className={selected ? 'is-selected' : ''}
              type="button"
              aria-label={label}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onSelect(option)}
            >
              <img src={avatarPreviewUrl(option)} alt="" aria-hidden="true" />
            </button>
          )
        })}
      </div>
      {error === undefined ? null : <span className="character-generator-field-error" role="alert"><ImageSquare size={16} aria-hidden="true" />{error}</span>}
    </fieldset>
  )
}

function avatarPreviewUrl(option: CharacterGeneratorAvatarCatalogItem): string {
  if (option.previewPath.startsWith('/')) return option.previewPath
  return `/api/marketplace/packages/${encodeURIComponent(option.packageId)}/${encodeURIComponent(option.packageVersion)}/preview`
}
