import { ArrowClockwise, ArrowLeft, ArrowRight, Check, ImageSquare, Info, Palette } from '@phosphor-icons/react'
import type { CyberSkinPaletteV1, SkinDraft, SkinGeneratorBackdropCatalogItem, SkinGeneratorBackdropSelection, SkinGeneratorCatalog } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'
import { TextField } from '../character-generator/CharacterGeneratorSteps.js'
import {
  SKIN_BACKDROP_OPACITY_MAX,
  SKIN_BACKDROP_OPACITY_MIN,
  SKIN_PALETTE_COLOR_KEYS,
  backdropPreviewUrl,
  parseHexColor,
  type SkinPaletteColorKey,
} from './model.js'

/**
 * Skin Generator steps 02–04. Step 01 is the Character Generator's SourceStep
 * with skin copy; the text field below is its export too, so the three
 * generators share one review vocabulary.
 */

interface SkinAnalysisStepProps {
  source: string
  draft?: SkinDraft
  analyzing: boolean
  error?: string
  onCancel(): void
  onRetry(): void
  onContinue(): void
}

export function SkinAnalysisStep({ source, draft, analyzing, error, onCancel, onRetry, onContinue }: SkinAnalysisStepProps) {
  const { t } = useI18n()
  return (
    <div className="character-generator-step character-generator-step--analysis">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">02</span>
        <div><h3>{t('skinGenerator.analyzeTitle', '正在整理配色')}</h3><p>{t('skinGenerator.analyzeDescription', '分析只会生成临时草稿，原文会保留在当前流程中。')}</p></div>
      </div>
      <section className="character-generator-analysis-status" aria-live="polite">
        {analyzing ? <><span className="character-generator-spinner" aria-hidden="true" /><strong>{t('skinGenerator.analyzeProgress', '正在读取来源并整理配色与背景建议…')}</strong><button className="secondary-button" type="button" data-generator-initial-focus onClick={onCancel}>{t('characterGenerator.cancelAnalysis', '取消分析')}</button></> : error === undefined ? <><Check size={20} aria-hidden="true" /><strong>{t('skinGenerator.analysisReady', '分析完成。请继续检查并编辑皮肤草稿。')}</strong></> : <><Info size={20} aria-hidden="true" /><strong>{t('characterGenerator.analysisError', '分析没有完成。来源和已生成内容仍然保留。')}</strong><button className="secondary-button" type="button" data-generator-initial-focus onClick={onRetry}><ArrowClockwise size={16} aria-hidden="true" />{t('characterGenerator.retryAnalysis', '重新分析')}</button></>}
      </section>
      <details className="character-generator-source-preview" open>
        <summary>{t('skinGenerator.sourceLabel', '皮肤描述')}</summary>
        <pre>{source}</pre>
      </details>
      {draft === undefined ? null : <section className="character-generator-analysis-result"><h4>{draft.displayName || t('skinGenerator.title', '自定义皮肤')}</h4><p>{draft.summary}</p><div className="character-generator-request-summary"><PaletteSwatches palette={draft.palette} /><span>{t('skinGenerator.colorsSummary', '{count} 种颜色', { count: SKIN_PALETTE_COLOR_KEYS.length })}</span></div></section>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" data-generator-initial-focus onClick={onRetry} disabled={analyzing}>{t('characterGenerator.retryAnalysis', '重新分析')}</button><button className="primary-button" type="button" disabled={analyzing || draft === undefined} onClick={onContinue}>{t('skinGenerator.previewTitle', '检查皮肤草稿')}<ArrowRight size={16} aria-hidden="true" /></button></div>
    </div>
  )
}

interface SkinPreviewStepProps {
  draft: SkinDraft
  catalog: SkinGeneratorCatalog
  backdrop?: SkinGeneratorBackdropSelection
  validationError?: string
  onDraftChange(patch: Partial<SkinDraft>): void
  onPaletteChange(patch: Partial<CyberSkinPaletteV1>): void
  onBackdropSelect(selection: SkinGeneratorBackdropSelection | undefined): void
  onBack(): void
  onContinue(): void
}

export function SkinPreviewStep({ draft, catalog, backdrop, validationError, onDraftChange, onPaletteChange, onBackdropSelect, onBack, onContinue }: SkinPreviewStepProps) {
  const { t } = useI18n()
  const invalid = validationError !== undefined
  const backdropItem = backdrop === undefined ? undefined : catalog.backdrops.find((option) => option.id === backdrop.id)
  const colorLabels: Record<SkinPaletteColorKey, string> = {
    accentColor: t('skinGenerator.accentColor', '强调色'),
    pageBackground: t('skinGenerator.pageBackground', '页面背景'),
    panelBackground: t('skinGenerator.panelBackground', '面板背景'),
    textColor: t('skinGenerator.textColor', '文字颜色'),
    ownerBubbleColor: t('skinGenerator.ownerBubbleColor', '我的气泡'),
    characterBubbleColor: t('skinGenerator.characterBubbleColor', '角色气泡'),
  }
  return (
    <div className="character-generator-step character-generator-step--preview skin-generator-step--preview">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">03</span>
        <div><h3>{t('skinGenerator.previewTitle', '检查皮肤草稿')}</h3><p>{t('skinGenerator.previewDescription', '所有颜色都可以修改。皮肤只包含六种颜色、一个透明度和一个官方场景选择，不含任何样式代码。')}</p></div>
      </div>
      <div className="character-generator-preview-layout">
        <div className="character-generator-preview-media">
          <SkinLivePreview palette={draft.palette} {...(backdropItem === undefined ? {} : { backdropId: backdropItem.id })} />
          <BackdropPicker2D options={catalog.backdrops} selection={backdrop} onSelect={onBackdropSelect} />
        </div>
        <div className="character-generator-preview-fields">
          <TextField id="skin-generator-name" initialFocus label={t('skinGenerator.displayName', '皮肤名称')} value={draft.displayName} maxLength={100} error={invalid && draft.displayName.trim().length === 0} onChange={(value) => onDraftChange({ displayName: value })} />
          <TextField id="skin-generator-summary" label={t('skinGenerator.summary', '皮肤简介')} value={draft.summary} maxLength={500} multiline rows={3} error={invalid && draft.summary.trim().length === 0} onChange={(value) => onDraftChange({ summary: value })} />
          <fieldset className="character-generator-fieldset">
            <legend>{t('skinGenerator.palette', '配色')}</legend>
            <p className="character-generator-helper">{t('skinGenerator.paletteHint', '每个颜色都是一个 #rrggbb 十六进制值，其余视觉效果由宿主推导。')}</p>
            <div className="skin-generator-palette">
              {SKIN_PALETTE_COLOR_KEYS.map((key) => <ColorField key={key} id={`skin-generator-color-${key}`} label={colorLabels[key]} value={draft.palette[key]} error={invalid && parseHexColor(draft.palette[key]) === undefined} onChange={(value) => onPaletteChange({ [key]: value })} />)}
            </div>
            <label className="character-generator-field skin-generator-opacity" htmlFor="skin-generator-opacity">
              <span>{t('skinGenerator.backdropOpacity', '背景透明度')}</span>
              <div><input id="skin-generator-opacity" type="range" min={SKIN_BACKDROP_OPACITY_MIN} max={SKIN_BACKDROP_OPACITY_MAX} step={0.05} value={draft.palette.backdropOpacity} onChange={(event) => onPaletteChange({ backdropOpacity: Number(event.target.value) })} /><output htmlFor="skin-generator-opacity">{draft.palette.backdropOpacity.toFixed(2)}</output></div>
            </label>
          </fieldset>
        </div>
      </div>
      {validationError === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{validationError}</div>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{t('characterGenerator.previous', '上一步')}</button><button className="primary-button" type="button" onClick={onContinue}>{t('characterGenerator.next', '下一步')}<ArrowRight size={16} aria-hidden="true" /></button></div>
    </div>
  )
}

function ColorField({ id, label, value, error, onChange }: { id: string; label: string; value: string; error: boolean; onChange(value: string): void }) {
  const parsed = parseHexColor(value)
  return (
    <div className="skin-generator-color">
      <span id={`${id}-label`}>{label}</span>
      <input type="color" aria-label={`${label} · 取色`} value={parsed ?? '#000000'} onChange={(event) => onChange(event.target.value)} />
      <input id={id} type="text" aria-label={label} value={value} maxLength={7} spellCheck={false} placeholder="#rrggbb" aria-invalid={error} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

/**
 * A self-contained mock of the chat surface, coloured from the draft by inline
 * styles. Nothing here touches the document's theme variables: previewing is
 * never equivalent to applying.
 */
export function SkinLivePreview({ palette, backdropId }: { palette: CyberSkinPaletteV1; backdropId?: string }) {
  const { t } = useI18n()
  const color = (key: SkinPaletteColorKey): string => parseHexColor(palette[key]) ?? 'transparent'
  const backdropImage = backdropId === undefined ? undefined : backdropPreviewUrl(backdropId)
  return (
    <section className="character-generator-fieldset" aria-label={t('skinGenerator.livePreview', '实时预览')}>
      <p className="character-generator-helper">{t('skinGenerator.livePreview', '实时预览')} · {t('skinGenerator.livePreviewHint', '只在这个预览里生效，不会改变当前界面。')}</p>
      <div className="skin-generator-preview" style={{ backgroundColor: color('pageBackground') }}>
        {backdropImage === undefined ? null : <div className="skin-generator-preview__backdrop" style={{ backgroundImage: `url("${backdropImage}")`, opacity: palette.backdropOpacity }} aria-hidden="true" />}
        <div className="skin-generator-preview__panel" style={{ backgroundColor: color('panelBackground'), color: color('textColor'), border: `1px solid ${color('accentColor')}` }}>
          <div className="skin-generator-preview__bubble" style={{ backgroundColor: color('characterBubbleColor') }}>{t('skinGenerator.previewCharacter', '角色：已按时间排好，需要我标出时效吗？')}</div>
          <div className="skin-generator-preview__bubble is-owner" style={{ backgroundColor: color('ownerBubbleColor') }}>{t('skinGenerator.previewOwner', '我：把今天的资料整理成时间线。')}</div>
          <span className="skin-generator-preview__action" style={{ backgroundColor: color('accentColor'), color: color('pageBackground') }}>{t('skinGenerator.previewAction', '发送')}</span>
        </div>
      </div>
    </section>
  )
}

export function PaletteSwatches({ palette }: { palette: CyberSkinPaletteV1 }) {
  return <span className="skin-generator-swatches" aria-hidden="true">{SKIN_PALETTE_COLOR_KEYS.map((key) => <i key={key} style={{ backgroundColor: parseHexColor(palette[key]) ?? 'transparent' }} />)}</span>
}

interface BackdropPicker2DProps {
  options: SkinGeneratorBackdropCatalogItem[]
  selection: SkinGeneratorBackdropSelection | undefined
  onSelect(selection: SkinGeneratorBackdropSelection | undefined): void
}

/**
 * Official backdrops only, plus "none". Mirrors the World Generator's scene
 * picker without an upload half: a user-supplied bitmap is the stated
 * follow-up, not this slice. Thumbnails are the host's own built-in scenes.
 */
export function BackdropPicker2D({ options, selection, onSelect }: BackdropPicker2DProps) {
  const { t } = useI18n()
  const selected = selection === undefined ? undefined : options.find((option) => option.id === selection.id)
  const selectedPreview = selected === undefined ? undefined : backdropPreviewUrl(selected.id)
  return (
    <fieldset className="character-generator-avatar skin-generator-backdrop">
      <legend>{t('skinGenerator.backdropTitle', '会话背景')}</legend>
      <div className="character-generator-avatar__preview skin-generator-backdrop__preview">
        {selectedPreview === undefined ? <ImageSquare size={48} aria-hidden="true" /> : <img src={selectedPreview} alt={selected?.displayName ?? ''} />}
        <div>
          <strong>{selected?.displayName ?? t('skinGenerator.backdropNone', '不使用背景图')}</strong>
          <span>{t('skinGenerator.backdropHint', '从官方皮肤中挑选一个场景作为聊天背景；上传自定义背景将在后续版本提供。')}</span>
        </div>
      </div>
      <div className="character-generator-avatar__options skin-generator-backdrop__options" role="group" aria-label={t('skinGenerator.backdropPick', '选择一个官方背景')}>
        <button className={selection === undefined ? 'is-selected' : ''} type="button" aria-label={t('skinGenerator.backdropNone', '不使用背景图')} aria-pressed={selection === undefined} onClick={() => onSelect(undefined)}><Palette size={22} aria-hidden="true" /></button>
        {options.length === 0 ? <span className="character-generator-empty">{t('skinGenerator.backdropEmpty', '官方背景目录为空。')}</span> : options.map((option) => {
          const active = selection?.id === option.id
          const preview = backdropPreviewUrl(option.id)
          return <button key={option.id} className={active ? 'is-selected' : ''} type="button" aria-label={option.displayName} aria-pressed={active} onClick={() => onSelect({ kind: 'official', id: option.id })}>{preview === undefined ? <ImageSquare size={22} aria-hidden="true" /> : <img src={preview} alt="" aria-hidden="true" />}</button>
        })}
      </div>
    </fieldset>
  )
}

interface SkinPublishStepProps {
  draft: SkinDraft
  source: string
  backdrop?: SkinGeneratorBackdropCatalogItem
  publishing: boolean
  error?: string
  published: boolean
  onBack(): void
  onPublish(): void
  onViewInstall(): void
}

export function SkinPublishStep({ draft, source, backdrop, publishing, error, published, onBack, onPublish, onViewInstall }: SkinPublishStepProps) {
  const { t } = useI18n()
  if (published) {
    return <div className="character-generator-step character-generator-step--published"><div className="character-generator-published-mark"><Check size={26} aria-hidden="true" /></div><h3>{t('skinGenerator.published', '皮肤已发布')}</h3><p>{t('skinGenerator.publishDescription', '发布会生成一个本地皮肤包，并出现在皮肤市场中。')}</p><button className="primary-button" type="button" data-generator-initial-focus onClick={onViewInstall}>{t('characterGenerator.viewInstall', '查看并安装')}<ArrowRight size={16} aria-hidden="true" /></button></div>
  }
  return (
    <div className="character-generator-step character-generator-step--publish">
      <div className="character-generator-step__heading"><span className="character-generator-step__eyebrow">04</span><div><h3>{t('skinGenerator.publishTitle', '确认发布皮肤')}</h3><p>{t('skinGenerator.publishDescription', '发布会生成一个本地皮肤包，并出现在皮肤市场中。')}</p></div></div>
      <section className="character-generator-publish-card"><div className="character-generator-publish-card__identity"><strong>{draft.displayName}</strong><PaletteSwatches palette={draft.palette} /><p>{draft.summary}</p></div><dl><div><dt>{t('skinGenerator.palette', '配色')}</dt><dd>{SKIN_PALETTE_COLOR_KEYS.map((key) => draft.palette[key]).join(' · ')}</dd></div><div><dt>{t('skinGenerator.backdropOpacity', '背景透明度')}</dt><dd>{draft.palette.backdropOpacity.toFixed(2)}</dd></div><div><dt>{t('skinGenerator.backdropTitle', '会话背景')}</dt><dd>{backdrop?.displayName ?? t('skinGenerator.backdropNone', '不使用背景图')}</dd></div><div><dt>{t('characterGenerator.publishSource', '来源摘要')}</dt><dd>{draft.sourceSummary || source.slice(0, 180)}</dd></div></dl></section>
      <div className="character-generator-publish-notice"><Info size={17} aria-hidden="true" /><span>{t('skinGenerator.publishPackageHint', '发布不会自动安装或应用皮肤。')}</span></div>
      {error === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{error}</div>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" disabled={publishing} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{t('characterGenerator.previous', '上一步')}</button><button className="primary-button" type="button" data-generator-initial-focus disabled={publishing} onClick={onPublish}>{publishing ? t('characterGenerator.publishing', '正在发布…') : t('skinGenerator.publishButton', '发布到皮肤市场')}<Check size={16} aria-hidden="true" /></button></div>
    </div>
  )
}
