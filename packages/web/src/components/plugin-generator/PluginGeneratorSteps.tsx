import { ArrowClockwise, ArrowLeft, ArrowRight, Check, Info, Plus, Trash } from '@phosphor-icons/react'
import type { PluginDraft, PluginGeneratorCatalog, PluginTransformDraft, PluginTransformMode } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'
import { TextField } from '../character-generator/CharacterGeneratorSteps.js'
import { PLUGIN_TRANSFORM_MODES, normalizeTrigger, previewPrompt, reservedTriggerOwner, transformIssue } from './model.js'

type Translate = ReturnType<typeof useI18n>['t']

/**
 * Plugin Generator steps 02–04. Step 01 is the Character Generator's SourceStep
 * with plugin copy; the text field below is its export too, so the four
 * generators share one review vocabulary.
 */

interface PluginAnalysisStepProps {
  source: string
  draft?: PluginDraft
  analyzing: boolean
  error?: string
  onCancel(): void
  onRetry(): void
  onContinue(): void
}

export function PluginAnalysisStep({ source, draft, analyzing, error, onCancel, onRetry, onContinue }: PluginAnalysisStepProps) {
  const { t } = useI18n()
  return (
    <div className="character-generator-step character-generator-step--analysis">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">02</span>
        <div><h3>{t('pluginGenerator.analyzeTitle', '正在整理指令')}</h3><p>{t('pluginGenerator.analyzeDescription', '分析只会生成临时草稿，原文会保留在当前流程中。')}</p></div>
      </div>
      <section className="character-generator-analysis-status" aria-live="polite">
        {analyzing ? <><span className="character-generator-spinner" aria-hidden="true" /><strong>{t('pluginGenerator.analyzeProgress', '正在读取来源并整理触发词与指令…')}</strong><button className="secondary-button" type="button" data-generator-initial-focus onClick={onCancel}>{t('characterGenerator.cancelAnalysis', '取消分析')}</button></> : error === undefined ? <><Check size={20} aria-hidden="true" /><strong>{t('pluginGenerator.analysisReady', '分析完成。请继续检查并编辑插件草稿。')}</strong></> : <><Info size={20} aria-hidden="true" /><strong>{t('characterGenerator.analysisError', '分析没有完成。来源和已生成内容仍然保留。')}</strong><button className="secondary-button" type="button" data-generator-initial-focus onClick={onRetry}><ArrowClockwise size={16} aria-hidden="true" />{t('characterGenerator.retryAnalysis', '重新分析')}</button></>}
      </section>
      <details className="character-generator-source-preview" open>
        <summary>{t('pluginGenerator.sourceLabel', '提示词配方')}</summary>
        <pre>{source}</pre>
      </details>
      {draft === undefined ? null : <section className="character-generator-analysis-result"><h4>{draft.displayName || t('pluginGenerator.title', '自定义插件')}</h4><p>{draft.summary}</p><div className="character-generator-request-summary"><TriggerChips transforms={draft.transforms} /><span>{t('pluginGenerator.transformsSummary', '{count} 条指令', { count: draft.transforms.length })}</span></div></section>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" data-generator-initial-focus onClick={onRetry} disabled={analyzing}>{t('characterGenerator.retryAnalysis', '重新分析')}</button><button className="primary-button" type="button" disabled={analyzing || draft === undefined} onClick={onContinue}>{t('pluginGenerator.previewTitle', '检查插件草稿')}<ArrowRight size={16} aria-hidden="true" /></button></div>
    </div>
  )
}

interface PluginPreviewStepProps {
  draft: PluginDraft
  catalog: PluginGeneratorCatalog
  validationError?: string
  onDraftChange(patch: Partial<PluginDraft>): void
  onTransformChange(index: number, patch: Partial<PluginTransformDraft>): void
  onAddTransform(): void
  onRemoveTransform(index: number): void
  onBack(): void
  onContinue(): void
}

export function PluginPreviewStep({ draft, catalog, validationError, onDraftChange, onTransformChange, onAddTransform, onRemoveTransform, onBack, onContinue }: PluginPreviewStepProps) {
  const { t } = useI18n()
  const invalid = validationError !== undefined
  const canAdd = draft.transforms.length < catalog.limits.maxTransforms
  return (
    <div className="character-generator-step character-generator-step--preview plugin-generator-step--preview">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">03</span>
        <div><h3>{t('pluginGenerator.previewTitle', '检查插件草稿')}</h3><p>{t('pluginGenerator.previewDescription', '每条指令都可以修改。插件只包含触发词和一段纯文本指令，不含代码、网址、密钥或任何额外权限。')}</p></div>
      </div>
      <div className="character-generator-preview-fields">
        <TextField id="plugin-generator-name" initialFocus label={t('pluginGenerator.displayName', '插件名称')} value={draft.displayName} maxLength={100} error={invalid && draft.displayName.trim().length === 0} onChange={(value) => onDraftChange({ displayName: value })} />
        <TextField id="plugin-generator-summary" label={t('pluginGenerator.summary', '插件简介')} value={draft.summary} maxLength={500} multiline rows={3} error={invalid && draft.summary.trim().length === 0} onChange={(value) => onDraftChange({ summary: value })} />
        <fieldset className="character-generator-fieldset">
          <legend>{t('pluginGenerator.transforms', '指令')}</legend>
          <p className="character-generator-helper">{t('pluginGenerator.transformsHint', '每条指令绑定一个 / 开头的触发词；在会话中输入触发词时，宿主按所选模式把指令加进这条消息。')}</p>
          {draft.transforms.length === 0 ? <span className="character-generator-empty">{t('pluginGenerator.transformsEmpty', '至少需要一条指令。')}</span> : <div className="plugin-generator-transforms">{draft.transforms.map((transform, index) => <TransformEditor key={index} index={index} transform={transform} draft={draft} catalog={catalog} invalid={invalid} onChange={(patch) => onTransformChange(index, patch)} onRemove={() => onRemoveTransform(index)} />)}</div>}
          <div className="character-generator-step__actions"><button className="secondary-button" type="button" disabled={!canAdd} onClick={onAddTransform}><Plus size={16} aria-hidden="true" />{t('pluginGenerator.addTransform', '添加指令')}</button></div>
        </fieldset>
      </div>
      {validationError === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{validationError}</div>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{t('characterGenerator.previous', '上一步')}</button><button className="primary-button" type="button" onClick={onContinue}>{t('characterGenerator.next', '下一步')}<ArrowRight size={16} aria-hidden="true" /></button></div>
    </div>
  )
}

interface TransformEditorProps {
  index: number
  transform: PluginTransformDraft
  draft: PluginDraft
  catalog: PluginGeneratorCatalog
  invalid: boolean
  onChange(patch: Partial<PluginTransformDraft>): void
  onRemove(): void
}

/** One transform, editable field by field, with the runtime prompt it will produce shown underneath. */
function TransformEditor({ index, transform, draft, catalog, invalid, onChange, onRemove }: TransformEditorProps) {
  const { t } = useI18n()
  const issue = transformIssue(transform, index, draft, catalog)
  const owner = reservedTriggerOwner(transform.trigger, catalog)
  const trigger = normalizeTrigger(transform.trigger)
  const number = index + 1
  const prefix = `plugin-generator-transform-${index}`
  const triggerInvalid = issue === 'transform.triggerInvalid' || issue === 'transform.triggerDuplicate' || issue === 'transform.triggerReserved'
  return (
    <section className="plugin-generator-transform" aria-label={t('pluginGenerator.transformTitle', '第 {index} 条指令', { index: number })}>
      <div className="plugin-generator-transform__header">
        <code>{trigger}</code>
        <span className="plugin-generator-mode">{modeLabel(transform.mode, t)}</span>
        <button className="icon-button" type="button" aria-label={t('pluginGenerator.removeTransform', '移除第 {index} 条指令', { index: number })} onClick={onRemove}><Trash size={16} aria-hidden="true" /></button>
      </div>
      <div className="plugin-generator-transform__grid">
        <TextField id={`${prefix}-trigger`} label={t('pluginGenerator.trigger', '触发词')} value={transform.trigger} maxLength={catalog.limits.maxTriggerLength} error={invalid && triggerInvalid} onChange={(value) => onChange({ trigger: value })} />
        <TextField id={`${prefix}-description`} label={t('pluginGenerator.description', '用途说明')} value={transform.description} maxLength={catalog.limits.maxDescriptionLength} error={invalid && (issue === 'transform.descriptionRequired' || issue === 'transform.descriptionTooLong')} onChange={(value) => onChange({ description: value })} />
        <label className="character-generator-field" htmlFor={`${prefix}-mode`}><span>{t('pluginGenerator.mode', '模式')}</span><select id={`${prefix}-mode`} value={transform.mode} onChange={(event) => onChange({ mode: event.target.value as PluginTransformMode })}>{PLUGIN_TRANSFORM_MODES.map((mode) => <option key={mode} value={mode}>{modeLabel(mode, t)}</option>)}</select></label>
        <label className="character-generator-field" htmlFor={`${prefix}-priority`}><span>{t('pluginGenerator.priority', '优先级')}</span><input id={`${prefix}-priority`} type="number" step={1} value={transform.priority} aria-invalid={invalid && issue === 'transform.priorityInvalid'} onChange={(event) => { const next = Number(event.target.value); onChange({ priority: Number.isFinite(next) ? Math.trunc(next) : 0 }) }} /></label>
      </div>
      {owner === undefined
        ? <p className="character-generator-helper">{t('pluginGenerator.triggerHint', '以 / 开头，只含小写字母、数字和连字符。')} · {modeHint(transform.mode, t)} · {t('pluginGenerator.priorityHint', '多条指令同时命中时，数字大的先应用。')}</p>
        : <p className="character-generator-helper is-reserved" role="alert">{t('pluginGenerator.triggerReserved', '触发词 {trigger} 已被官方插件「{owner}」使用，请换一个。', { trigger, owner: owner.displayName })}</p>}
      <TextField id={`${prefix}-instruction`} label={t('pluginGenerator.instruction', '指令内容')} value={transform.instruction} maxLength={catalog.limits.maxInstructionLength} multiline rows={5} error={invalid && (issue === 'transform.instructionRequired' || issue === 'transform.instructionTooLong')} onChange={(value) => onChange({ instruction: value })} />
      <TransformEffectPreview transform={transform} />
    </section>
  )
}

/**
 * The prompt the runtime will send for one sample message, composed exactly
 * the way `applyInstalledPromptTransforms` composes it. Nothing here is sent
 * anywhere: previewing is never equivalent to installing.
 */
export function TransformEffectPreview({ transform }: { transform: PluginTransformDraft }) {
  const { t } = useI18n()
  const sample = `${normalizeTrigger(transform.trigger)} ${t('pluginGenerator.effectSample', '请整理本周的会话。')}`
  return (
    <div className="plugin-generator-effect" aria-label={t('pluginGenerator.effectTitle', '效果预览')}>
      <strong>{t('pluginGenerator.effectTitle', '效果预览')}</strong>
      <span>{t('pluginGenerator.effectYouType', '你输入：')}<code>{sample}</code></span>
      <span>{modeHint(transform.mode, t)}</span>
      <span>{t('pluginGenerator.effectReceives', '角色实际收到：')}</span>
      <pre>{previewPrompt(transform, sample)}</pre>
    </div>
  )
}

export function TriggerChips({ transforms }: { transforms: PluginTransformDraft[] }) {
  return <span className="plugin-generator-chips">{transforms.map((transform, index) => <code key={`${index}-${transform.trigger}`}>{normalizeTrigger(transform.trigger)}</code>)}</span>
}

export function modeLabel(mode: PluginTransformMode, t: Translate): string {
  if (mode === 'append') return t('pluginGenerator.modeAppend', '追加到消息后')
  if (mode === 'replace') return t('pluginGenerator.modeReplace', '替换整条消息')
  return t('pluginGenerator.modePrepend', '前置到消息前')
}

export function modeHint(mode: PluginTransformMode, t: Translate): string {
  if (mode === 'append') return t('pluginGenerator.modeAppendHint', '指令放在你的消息之后。')
  if (mode === 'replace') return t('pluginGenerator.modeReplaceHint', '你的消息会被这段指令整个替换。')
  return t('pluginGenerator.modePrependHint', '指令放在你的消息之前。')
}

interface PluginPublishStepProps {
  draft: PluginDraft
  source: string
  publishing: boolean
  error?: string
  published: boolean
  onBack(): void
  onPublish(): void
  onViewInstall(): void
}

export function PluginPublishStep({ draft, source, publishing, error, published, onBack, onPublish, onViewInstall }: PluginPublishStepProps) {
  const { t } = useI18n()
  if (published) {
    return <div className="character-generator-step character-generator-step--published"><div className="character-generator-published-mark"><Check size={26} aria-hidden="true" /></div><h3>{t('pluginGenerator.published', '插件已发布')}</h3><p>{t('pluginGenerator.publishDescription', '发布会生成一个本地插件包，并出现在插件市场中。')}</p><button className="primary-button" type="button" data-generator-initial-focus onClick={onViewInstall}>{t('characterGenerator.viewInstall', '查看并安装')}<ArrowRight size={16} aria-hidden="true" /></button></div>
  }
  return (
    <div className="character-generator-step character-generator-step--publish">
      <div className="character-generator-step__heading"><span className="character-generator-step__eyebrow">04</span><div><h3>{t('pluginGenerator.publishTitle', '确认发布插件')}</h3><p>{t('pluginGenerator.publishDescription', '发布会生成一个本地插件包，并出现在插件市场中。')}</p></div></div>
      <section className="character-generator-publish-card"><div className="character-generator-publish-card__identity"><strong>{draft.displayName}</strong><TriggerChips transforms={draft.transforms} /><p>{draft.summary}</p></div><dl><div><dt>{t('pluginGenerator.transforms', '指令')}</dt><dd>{draft.transforms.map((transform) => `${normalizeTrigger(transform.trigger)} · ${modeLabel(transform.mode, t)}`).join(' / ')}</dd></div><div><dt>{t('characterGenerator.publishSource', '来源摘要')}</dt><dd>{draft.sourceSummary || source.slice(0, 180)}</dd></div></dl></section>
      <div className="character-generator-publish-notice"><Info size={17} aria-hidden="true" /><span>{t('pluginGenerator.publishPackageHint', '发布不会自动安装插件。安装后在当前世界的会话中输入触发词即可使用。')}</span></div>
      {error === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{error}</div>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" disabled={publishing} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{t('characterGenerator.previous', '上一步')}</button><button className="primary-button" type="button" data-generator-initial-focus disabled={publishing} onClick={onPublish}>{publishing ? t('characterGenerator.publishing', '正在发布…') : t('pluginGenerator.publishButton', '发布到插件市场')}<Check size={16} aria-hidden="true" /></button></div>
    </div>
  )
}
