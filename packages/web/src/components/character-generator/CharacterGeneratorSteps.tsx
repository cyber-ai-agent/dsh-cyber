import { ArrowClockwise, ArrowLeft, ArrowRight, Check, FileText, Info, Plus, Sparkle, X } from '@phosphor-icons/react'
import type { CharacterBlueprintDraft, CharacterGeneratorAvatarCatalogItem, CharacterGeneratorAvatarSelection, CharacterGeneratorCatalog } from '@dsh-cyber/contracts'
import { useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n/runtime.js'
import { AvatarPicker2D } from './AvatarPicker2D.js'
import { CHARACTER_SOURCE_MAX_BYTES } from './model.js'

interface SourceStepProps {
  sourceMode: 'description' | 'paste' | 'file'
  source: string
  sourceFileName?: string
  error?: string
  analyzing: boolean
  onSourceMode(mode: SourceStepProps['sourceMode']): void
  onSource(value: string): void
  onFile(file: File): void
  onAnalyze(): void
}

export function SourceStep({ sourceMode, source, sourceFileName, error, analyzing, onSourceMode, onSource, onFile, onAnalyze }: SourceStepProps) {
  const { t } = useI18n()
  return (
    <div className="character-generator-step character-generator-step--source">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">01</span>
        <div><h3>{t('characterGenerator.sourceIntro', '从一段描述开始')}</h3><p>{t('characterGenerator.sourceHint', '支持 Markdown 或纯文本。导入内容会作为数据分析，不会获得系统指令或权限。')}</p></div>
      </div>
      <fieldset className="character-generator-source-types">
        <legend>{t('characterGenerator.sourceType', '输入方式')}</legend>
        <div role="radiogroup" aria-label={t('characterGenerator.sourceType', '输入方式')}>
          <SourceModeButton value="description" selected={sourceMode === 'description'} onSelect={onSourceMode} label={t('characterGenerator.sourceDescription', '自然语言描述')} />
          <SourceModeButton value="paste" selected={sourceMode === 'paste'} onSelect={onSourceMode} label={t('characterGenerator.sourcePaste', '粘贴文本')} />
          <SourceModeButton value="file" selected={sourceMode === 'file'} onSelect={onSourceMode} label={t('characterGenerator.sourceFile', '导入文件')} />
        </div>
      </fieldset>
      {sourceMode === 'file' ? (
        <label className="character-generator-file-picker">
          <input type="file" accept="text/markdown,text/plain,.md,.txt" onChange={(event) => handleFileChange(event, onFile)} />
          <FileText size={22} aria-hidden="true" />
          <strong>{sourceFileName === undefined ? t('characterGenerator.chooseFile', '选择 .md 或 .txt 文件') : t('characterGenerator.fileSelected', '已选择：{name}', { name: sourceFileName })}</strong>
          <span>{t('characterGenerator.fileLimit', '文件大小上限 128 KiB。')}</span>
        </label>
      ) : null}
      <label className="character-generator-field character-generator-field--source">
        <span>{t('characterGenerator.sourceLabel', '角色描述')}</span>
        <textarea
          value={source}
          rows={9}
          maxLength={CHARACTER_SOURCE_MAX_BYTES}
          placeholder={t('characterGenerator.sourcePlaceholder', '例如：创建一名沉着的技术负责人，擅长把复杂问题拆成可执行步骤。')}
          data-generator-initial-focus
          aria-describedby="character-generator-source-help"
          aria-invalid={error !== undefined}
          onChange={(event) => onSource(event.target.value)}
        />
        <small id="character-generator-source-help">{t('characterGenerator.sourceSafety', '来源内容是不可信数据。分析结果需要你逐项检查后才会生成角色模板。')}</small>
      </label>
      {error === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{error}</div>}
      <div className="character-generator-step__actions">
        <span className="character-generator-step__note">{t('characterGenerator.sourceHint', '支持 Markdown 或纯文本。导入内容会作为数据分析，不会获得系统指令或权限。')}</span>
        <button className="primary-button" type="button" disabled={analyzing || source.trim().length === 0} onClick={onAnalyze}><Sparkle size={17} aria-hidden="true" />{t('characterGenerator.analyze', '开始分析')}<ArrowRight size={16} aria-hidden="true" /></button>
      </div>
    </div>
  )
}

function SourceModeButton({ value, selected, label, onSelect }: { value: SourceStepProps['sourceMode']; selected: boolean; label: string; onSelect(value: SourceStepProps['sourceMode']): void }) {
  return <button className={selected ? 'is-selected' : ''} type="button" role="radio" aria-checked={selected} onClick={() => onSelect(value)}>{label}</button>
}

function handleFileChange(event: ChangeEvent<HTMLInputElement>, onFile: (file: File) => void): void {
  const file = event.currentTarget.files?.[0]
  event.currentTarget.value = ''
  if (file !== undefined) onFile(file)
}

interface AnalysisStepProps {
  source: string
  draft?: CharacterBlueprintDraft
  analyzing: boolean
  error?: string
  onCancel(): void
  onRetry(): void
  onContinue(): void
}

export function AnalysisStep({ source, draft, analyzing, error, onCancel, onRetry, onContinue }: AnalysisStepProps) {
  const { t } = useI18n()
  return (
    <div className="character-generator-step character-generator-step--analysis">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">02</span>
        <div><h3>{t('characterGenerator.analyzeTitle', '正在整理角色设定')}</h3><p>{t('characterGenerator.analyzeDescription', '分析只会生成临时草稿，原文会保留在当前流程中。')}</p></div>
      </div>
      <section className="character-generator-analysis-status" aria-live="polite">
        {analyzing ? <><span className="character-generator-spinner" aria-hidden="true" /><strong>{t('characterGenerator.analyzeProgress', '正在读取来源并匹配可用能力…')}</strong><button className="secondary-button" type="button" data-generator-initial-focus onClick={onCancel}>{t('characterGenerator.cancelAnalysis', '取消分析')}</button></> : error === undefined ? <><Check size={20} aria-hidden="true" /><strong>{t('characterGenerator.analysisReady', '分析完成。请继续检查并编辑草稿。')}</strong></> : <><Info size={20} aria-hidden="true" /><strong>{t('characterGenerator.analysisError', '分析没有完成。来源和已生成内容仍然保留。')}</strong><button className="secondary-button" type="button" data-generator-initial-focus onClick={onRetry}><ArrowClockwise size={16} aria-hidden="true" />{t('characterGenerator.retryAnalysis', '重新分析')}</button></>}
      </section>
      <details className="character-generator-source-preview" open>
        <summary>{t('characterGenerator.sourceLabel', '角色描述')}</summary>
        <pre>{source}</pre>
      </details>
      {draft === undefined ? null : <section className="character-generator-analysis-result"><h4>{draft.displayName || t('characterGenerator.title', '自定义角色')}</h4><p>{draft.summary || draft.persona}</p><div className="character-generator-request-summary"><span>{t('characterGenerator.skills', '请求的角色技能')}：{draft.requestedSkillIds.length}</span><span>{t('characterGenerator.capabilities', '请求的底层能力')}：{draft.requestedCapabilities.length}</span></div></section>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" data-generator-initial-focus onClick={onRetry} disabled={analyzing}>{t('characterGenerator.retryAnalysis', '重新分析')}</button><button className="primary-button" type="button" disabled={analyzing || draft === undefined} onClick={onContinue}>{t('characterGenerator.previewTitle', '检查角色草稿')}<ArrowRight size={16} aria-hidden="true" /></button></div>
    </div>
  )
}

interface PreviewStepProps {
  draft: CharacterBlueprintDraft
  catalog: CharacterGeneratorCatalog
  avatar?: CharacterGeneratorAvatarSelection
  avatarError?: string
  validationError?: string
  onDraftChange(patch: Partial<CharacterBlueprintDraft>): void
  onAvatarSelect(option: CharacterGeneratorAvatarCatalogItem): void
  onAvatarUpload(file: File): void
  onBack(): void
  onContinue(): void
}

export function PreviewStep({ draft, catalog, avatar, avatarError, validationError, onDraftChange, onAvatarSelect, onAvatarUpload, onBack, onContinue }: PreviewStepProps) {
  const { t } = useI18n()
  const [traitDraft, setTraitDraft] = useState('')
  const updateTraitDraft = (event: ChangeEvent<HTMLInputElement>) => setTraitDraft(event.target.value)
  const addTrait = () => {
    const value = traitDraft.trim()
    if (value.length === 0 || draft.personalityTraits.includes(value)) return
    onDraftChange({ personalityTraits: [...draft.personalityTraits, value] })
    setTraitDraft('')
  }
  const onTraitKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    addTrait()
  }
  const toggle = (key: 'requestedSkillIds' | 'requestedCapabilities', id: string) => {
    if (key === 'requestedCapabilities') {
      const capabilityId = id as CharacterBlueprintDraft['requestedCapabilities'][number]
      const values = draft.requestedCapabilities
      onDraftChange({ requestedCapabilities: values.includes(capabilityId) ? values.filter((value) => value !== capabilityId) : [...values, capabilityId] })
      return
    }
    const values = draft.requestedSkillIds
    onDraftChange({ requestedSkillIds: values.includes(id) ? values.filter((value) => value !== id) : [...values, id] })
  }
  return (
    <div className="character-generator-step character-generator-step--preview">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">03</span>
        <div><h3>{t('characterGenerator.previewTitle', '检查角色草稿')}</h3><p>{t('characterGenerator.previewDescription', '所有字段都可以修改。技能和能力只是请求，不代表已经授权。')}</p></div>
      </div>
      <div className="character-generator-preview-layout">
        <div className="character-generator-preview-media"><AvatarPicker2D options={catalog.avatars} selection={avatar} onSelect={onAvatarSelect} onUpload={onAvatarUpload} error={avatarError} /></div>
        <div className="character-generator-preview-fields">
          <TextField id="character-generator-name" initialFocus label={t('characterGenerator.displayName', '角色名字')} value={draft.displayName} maxLength={100} error={validationError !== undefined && draft.displayName.trim().length === 0} onChange={(value) => onDraftChange({ displayName: value })} />
          <TextField id="character-generator-role" label={t('characterGenerator.role', '岗位或身份')} value={draft.role} maxLength={100} error={validationError !== undefined && draft.role.trim().length === 0} onChange={(value) => onDraftChange({ role: value })} />
          <TextField id="character-generator-summary" label={t('characterGenerator.summary', '简介')} value={draft.summary} maxLength={500} multiline rows={3} error={validationError !== undefined && draft.summary.trim().length === 0} onChange={(value) => onDraftChange({ summary: value })} />
          <TextField id="character-generator-persona" label={t('characterGenerator.persona', 'Persona 与行为方式')} value={draft.persona} maxLength={2_000} multiline rows={5} error={validationError !== undefined && draft.persona.trim().length === 0} onChange={(value) => onDraftChange({ persona: value })} />
          <TextField id="character-generator-background" label={t('characterGenerator.background', '背景')} value={draft.background} maxLength={4_000} multiline rows={3} onChange={(value) => onDraftChange({ background: value })} />
          <fieldset className="character-generator-fieldset"><legend>{t('characterGenerator.traits', '性格特点')}</legend><div className="character-generator-trait-input"><input value={traitDraft} placeholder={t('characterGenerator.traitPlaceholder', '输入特点后按回车添加')} onChange={updateTraitDraft} onKeyDown={onTraitKeyDown} /><button className="secondary-button" type="button" onClick={addTrait} disabled={traitDraft.trim().length === 0}><Plus size={16} aria-hidden="true" />{t('characterGenerator.addTrait', '添加')}</button></div><div className="character-generator-traits">{draft.personalityTraits.map((trait) => <span key={trait}>{trait}<button type="button" aria-label={`${t('characterGenerator.removeTrait', '移除')} ${trait}`} onClick={() => onDraftChange({ personalityTraits: draft.personalityTraits.filter((item) => item !== trait) })}><X size={14} aria-hidden="true" /></button></span>)}</div></fieldset>
          <CatalogChoices title={t('characterGenerator.skills', '请求的角色技能')} helper={t('characterGenerator.requestedOnly', '仅表示角色希望使用，招募时仍需单独审阅。')} empty={t('characterGenerator.noSkills', '当前世界没有可请求的角色技能。')} values={catalog.skills.map((skill) => ({ id: skill.id, label: skill.displayName, summary: skill.summary, selected: draft.requestedSkillIds.includes(skill.id) }))} onToggle={(id) => toggle('requestedSkillIds', id)} />
          <CatalogChoices title={t('characterGenerator.capabilities', '请求的底层能力')} helper={t('characterGenerator.requestedOnly', '仅表示角色希望使用，招募时仍需单独审阅。')} empty={t('characterGenerator.noCapabilities', '当前世界没有可请求的底层能力。')} values={catalog.capabilities.map((capability) => ({ id: capability.id, label: capability.displayName, summary: capability.summary, selected: draft.requestedCapabilities.includes(capability.id) }))} onToggle={(id) => toggle('requestedCapabilities', id)} />
          <section className="character-generator-world-note"><strong>{t('characterGenerator.compatibleWorld', '适用世界')}</strong><span>{t('characterGenerator.worldHint', '发布后仍需在兼容世界中安装并通过招募确认。')}</span></section>
        </div>
      </div>
      {validationError === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{validationError}</div>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{t('characterGenerator.previous', '上一步')}</button><button className="primary-button" type="button" onClick={onContinue}>{t('characterGenerator.next', '下一步')}<ArrowRight size={16} aria-hidden="true" /></button></div>
    </div>
  )
}

function TextField({ id, label, value, maxLength, multiline = false, rows = 2, error = false, initialFocus = false, onChange }: { id: string; label: string; value: string; maxLength: number; multiline?: boolean; rows?: number; error?: boolean; initialFocus?: boolean; onChange(value: string): void }) {
  return <label className="character-generator-field" htmlFor={id}><span>{label}</span>{multiline ? <textarea id={id} value={value} rows={rows} maxLength={maxLength} aria-invalid={error} {...(initialFocus ? { 'data-generator-initial-focus': true } : {})} onChange={(event) => onChange(event.target.value)} /> : <input id={id} value={value} maxLength={maxLength} aria-invalid={error} {...(initialFocus ? { 'data-generator-initial-focus': true } : {})} onChange={(event) => onChange(event.target.value)} />}</label>
}

function CatalogChoices({ title, helper, empty, values, onToggle }: { title: string; helper: string; empty: string; values: Array<{ id: string; label: string; summary: string; selected: boolean }>; onToggle(id: string): void }) {
  return <fieldset className="character-generator-fieldset"><legend>{title}</legend><p className="character-generator-helper">{helper}</p>{values.length === 0 ? <span className="character-generator-empty">{empty}</span> : <div className="character-generator-choice-list">{values.map((value) => <label key={value.id} className={value.selected ? 'is-selected' : ''}><input type="checkbox" checked={value.selected} onChange={() => onToggle(value.id)} /><span><strong>{value.label}</strong><small>{value.summary}</small></span></label>)}</div>}</fieldset>
}

interface PublishStepProps {
  draft: CharacterBlueprintDraft
  source: string
  avatar?: CharacterGeneratorAvatarSelection
  catalog: CharacterGeneratorCatalog
  publishing: boolean
  error?: string
  published: boolean
  onBack(): void
  onPublish(): void
  onViewInstall(): void
}

export function PublishStep({ draft, source, avatar, catalog, publishing, error, published, onBack, onPublish, onViewInstall }: PublishStepProps) {
  const { t } = useI18n()
  const selectedSkills = catalog.skills.filter((skill) => draft.requestedSkillIds.includes(skill.id))
  const selectedCapabilities = catalog.capabilities.filter((capability) => draft.requestedCapabilities.includes(capability.id))
  if (published) {
    return <div className="character-generator-step character-generator-step--published"><div className="character-generator-published-mark"><Check size={26} aria-hidden="true" /></div><h3>{t('characterGenerator.published', '角色模板已发布')}</h3><p>{t('characterGenerator.publishDescription', '发布会生成一个本地 Talent Package，并出现在角色市场中。')}</p><button className="primary-button" type="button" data-generator-initial-focus onClick={onViewInstall}>{t('characterGenerator.viewInstall', '查看并安装')}<ArrowRight size={16} aria-hidden="true" /></button></div>
  }
  return (
    <div className="character-generator-step character-generator-step--publish">
      <div className="character-generator-step__heading"><span className="character-generator-step__eyebrow">04</span><div><h3>{t('characterGenerator.publishTitle', '确认发布角色模板')}</h3><p>{t('characterGenerator.publishDescription', '发布会生成一个本地 Talent Package，并出现在角色市场中。')}</p></div></div>
      <section className="character-generator-publish-card"><div className="character-generator-publish-card__identity"><strong>{draft.displayName}</strong><span>{draft.role}</span><p>{draft.summary}</p></div><dl><div><dt>{t('characterGenerator.publishRequests', '能力请求')}</dt><dd>{selectedSkills.length + selectedCapabilities.length === 0 ? t('characterGenerator.publishNoRequests', '没有请求额外的技能或能力。') : `${selectedSkills.length + selectedCapabilities.length}`}</dd></div><div><dt>{t('characterGenerator.publishSource', '来源摘要')}</dt><dd>{draft.sourceSummary || source.slice(0, 180)}</dd></div><div><dt>{t('characterGenerator.compatibleWorld', '适用世界')}</dt><dd>{t('characterGenerator.worldHint', '发布后仍需在兼容世界中安装并通过招募确认。')}</dd></div></dl></section>
      <div className="character-generator-publish-notice"><Info size={17} aria-hidden="true" /><span>{t('characterGenerator.publishPackageHint', '发布不会自动安装、招募角色或发送消息。')}</span></div>
      {avatar?.kind === 'upload' ? <p className="character-generator-helper">{t('characterGenerator.avatarSelected', '已选择图片：{name}', { name: avatar.fileName })}</p> : null}
      {error === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{error}</div>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" disabled={publishing} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{t('characterGenerator.previous', '上一步')}</button><button className="primary-button" type="button" data-generator-initial-focus disabled={publishing} onClick={onPublish}>{publishing ? t('characterGenerator.publishing', '正在发布…') : t('characterGenerator.publishButton', '发布到角色市场')}<Check size={16} aria-hidden="true" /></button></div>
    </div>
  )
}
