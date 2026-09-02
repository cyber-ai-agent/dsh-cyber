import { ArrowClockwise, ArrowLeft, ArrowRight, Check, ImageSquare, Info, Plus, Trash, X } from '@phosphor-icons/react'
import type { CharacterBlueprintDraft, WorldGeneratorCatalog, WorldGeneratorSceneCatalogItem, WorldGeneratorSceneSelection, WorldThemeDraft } from '@dsh-cyber/contracts'
import { useState, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n/runtime.js'
import { CatalogChoices, TextField } from '../character-generator/CharacterGeneratorSteps.js'
import { WORLD_THEME_MAX_CAST, WORLD_THEME_MAX_RULES, WORLD_THEME_MAX_WORKFLOW_STEPS } from './model.js'

/**
 * World Generator steps 02–04. Step 01 is the Character Generator's SourceStep
 * with world copy; the field and catalog controls below are its exports too,
 * so both generators share one review vocabulary.
 */

interface WorldAnalysisStepProps {
  source: string
  draft?: WorldThemeDraft
  analyzing: boolean
  error?: string
  onCancel(): void
  onRetry(): void
  onContinue(): void
}

export function WorldAnalysisStep({ source, draft, analyzing, error, onCancel, onRetry, onContinue }: WorldAnalysisStepProps) {
  const { t } = useI18n()
  return (
    <div className="character-generator-step character-generator-step--analysis">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">02</span>
        <div><h3>{t('worldGenerator.analyzeTitle', '正在整理世界设定')}</h3><p>{t('worldGenerator.analyzeDescription', '分析只会生成临时草稿，原文会保留在当前流程中。')}</p></div>
      </div>
      <section className="character-generator-analysis-status" aria-live="polite">
        {analyzing ? <><span className="character-generator-spinner" aria-hidden="true" /><strong>{t('worldGenerator.analyzeProgress', '正在读取来源并整理术语、流程、规则与默认角色…')}</strong><button className="secondary-button" type="button" data-generator-initial-focus onClick={onCancel}>{t('characterGenerator.cancelAnalysis', '取消分析')}</button></> : error === undefined ? <><Check size={20} aria-hidden="true" /><strong>{t('worldGenerator.analysisReady', '分析完成。请继续检查并编辑世界草稿。')}</strong></> : <><Info size={20} aria-hidden="true" /><strong>{t('characterGenerator.analysisError', '分析没有完成。来源和已生成内容仍然保留。')}</strong><button className="secondary-button" type="button" data-generator-initial-focus onClick={onRetry}><ArrowClockwise size={16} aria-hidden="true" />{t('characterGenerator.retryAnalysis', '重新分析')}</button></>}
      </section>
      <details className="character-generator-source-preview" open>
        <summary>{t('worldGenerator.sourceLabel', '世界描述')}</summary>
        <pre>{source}</pre>
      </details>
      {draft === undefined ? null : <section className="character-generator-analysis-result"><h4>{draft.displayName || t('worldGenerator.title', '自定义世界')}</h4><p>{draft.summary}</p><div className="character-generator-request-summary"><span>{t('worldGenerator.workflow', '工作流程')}：{draft.workflow.length}</span><span>{t('worldGenerator.rules', '世界规则')}：{draft.rules.length}</span><span>{t('worldGenerator.cast', '默认角色')}：{draft.cast.length}</span></div></section>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" data-generator-initial-focus onClick={onRetry} disabled={analyzing}>{t('characterGenerator.retryAnalysis', '重新分析')}</button><button className="primary-button" type="button" disabled={analyzing || draft === undefined} onClick={onContinue}>{t('worldGenerator.previewTitle', '检查世界草稿')}<ArrowRight size={16} aria-hidden="true" /></button></div>
    </div>
  )
}

interface WorldPreviewStepProps {
  draft: WorldThemeDraft
  catalog: WorldGeneratorCatalog
  scene?: WorldGeneratorSceneSelection
  validationError?: string
  onDraftChange(patch: Partial<WorldThemeDraft>): void
  onSceneSelect(option: WorldGeneratorSceneCatalogItem): void
  onCastChange(index: number, patch: Partial<CharacterBlueprintDraft>): void
  onCastAdd(): void
  onCastRemove(index: number): void
  onBack(): void
  onContinue(): void
}

export function WorldPreviewStep({ draft, catalog, scene, validationError, onDraftChange, onSceneSelect, onCastChange, onCastAdd, onCastRemove, onBack, onContinue }: WorldPreviewStepProps) {
  const { t } = useI18n()
  const invalid = validationError !== undefined
  const term = (key: keyof WorldThemeDraft['terminology'], label: string) => (
    <TextField id={`world-generator-term-${key}`} label={label} value={draft.terminology[key]} maxLength={40} error={invalid && draft.terminology[key].trim().length === 0} onChange={(value) => onDraftChange({ terminology: { ...draft.terminology, [key]: value } })} />
  )
  return (
    <div className="character-generator-step character-generator-step--preview world-generator-step--preview">
      <div className="character-generator-step__heading">
        <span className="character-generator-step__eyebrow">03</span>
        <div><h3>{t('worldGenerator.previewTitle', '检查世界草稿')}</h3><p>{t('worldGenerator.previewDescription', '所有字段都可以修改。默认角色的技能和能力只是请求，招募时仍需单独审阅。')}</p></div>
      </div>
      <div className="character-generator-preview-layout">
        <div className="character-generator-preview-media"><ScenePicker2D options={catalog.scenes} selection={scene} onSelect={onSceneSelect} /></div>
        <div className="character-generator-preview-fields">
          <TextField id="world-generator-name" initialFocus label={t('worldGenerator.displayName', '世界名称')} value={draft.displayName} maxLength={100} error={invalid && draft.displayName.trim().length === 0} onChange={(value) => onDraftChange({ displayName: value })} />
          <TextField id="world-generator-summary" label={t('worldGenerator.summary', '世界简介')} value={draft.summary} maxLength={500} multiline rows={3} error={invalid && draft.summary.trim().length === 0} onChange={(value) => onDraftChange({ summary: value })} />
          <fieldset className="character-generator-fieldset"><legend>{t('worldGenerator.terminology', '世界术语')}</legend><p className="character-generator-helper">{t('worldGenerator.terminologyHint', '这些称谓会出现在世界界面里，替换默认的“世界 / 角色 / 会话 / 事迹”。')}</p><div className="world-generator-term-grid">{term('world', t('worldGenerator.termWorld', '世界称谓'))}{term('participant', t('worldGenerator.termParticipant', '参与者称谓'))}{term('session', t('worldGenerator.termSession', '会话称谓'))}{term('milestone', t('worldGenerator.termMilestone', '事迹称谓'))}</div></fieldset>
          <ListEditor id="world-generator-workflow" title={t('worldGenerator.workflow', '工作流程')} helper={t('worldGenerator.workflowHint', '按顺序列出这个世界的工作环节。')} placeholder={t('worldGenerator.workflowPlaceholder', '输入环节名称后按回车添加')} addLabel={t('characterGenerator.addTrait', '添加')} removeLabel={t('characterGenerator.removeTrait', '移除')} values={draft.workflow} maximum={WORLD_THEME_MAX_WORKFLOW_STEPS} itemMaxLength={40} ordered onChange={(workflow) => onDraftChange({ workflow })} />
          <ListEditor id="world-generator-rules" title={t('worldGenerator.rules', '世界规则')} helper={t('worldGenerator.rulesHint', '每条规则一句话，所有角色都要遵守。')} placeholder={t('worldGenerator.rulesPlaceholder', '输入规则后按回车添加')} addLabel={t('characterGenerator.addTrait', '添加')} removeLabel={t('characterGenerator.removeTrait', '移除')} values={draft.rules} maximum={WORLD_THEME_MAX_RULES} itemMaxLength={200} onChange={(rules) => onDraftChange({ rules })} />
          <fieldset className="character-generator-fieldset world-generator-cast">
            <legend>{t('worldGenerator.cast', '默认角色')}</legend>
            <p className="character-generator-helper">{t('worldGenerator.castHint', '每名角色都会作为独立的角色模板发布，安装后再招募到世界。')}</p>
            {draft.cast.length === 0 ? <span className="character-generator-empty">{t('worldGenerator.noCast', '还没有默认角色。')}</span> : null}
            {draft.cast.map((member, index) => (
              <details key={index} className="world-generator-cast__member" open={index === 0}>
                <summary><strong>{member.displayName || t('worldGenerator.castUnnamed', '未命名角色')}</strong><span>{member.role}</span></summary>
                <div className="world-generator-cast__fields">
                  <TextField id={`world-generator-cast-${index}-name`} label={t('characterGenerator.displayName', '角色名字')} value={member.displayName} maxLength={100} error={invalid && member.displayName.trim().length === 0} onChange={(value) => onCastChange(index, { displayName: value })} />
                  <TextField id={`world-generator-cast-${index}-role`} label={t('characterGenerator.role', '岗位或身份')} value={member.role} maxLength={100} error={invalid && member.role.trim().length === 0} onChange={(value) => onCastChange(index, { role: value })} />
                  <TextField id={`world-generator-cast-${index}-summary`} label={t('characterGenerator.summary', '简介')} value={member.summary} maxLength={500} multiline rows={2} error={invalid && member.summary.trim().length === 0} onChange={(value) => onCastChange(index, { summary: value })} />
                  <TextField id={`world-generator-cast-${index}-persona`} label={t('characterGenerator.persona', 'Persona 与行为方式')} value={member.persona} maxLength={2_000} multiline rows={4} error={invalid && member.persona.trim().length === 0} onChange={(value) => onCastChange(index, { persona: value })} />
                  <CatalogChoices title={t('characterGenerator.skills', '请求的角色技能')} helper={t('characterGenerator.requestedOnly', '仅表示角色希望使用，招募时仍需单独审阅。')} empty={t('characterGenerator.noSkills', '当前世界没有可请求的角色技能。')} values={catalog.skills.map((skill) => ({ id: skill.id, label: skill.displayName, summary: skill.summary, selected: member.requestedSkillIds.includes(skill.id) }))} onToggle={(id) => onCastChange(index, { requestedSkillIds: member.requestedSkillIds.includes(id) ? member.requestedSkillIds.filter((value) => value !== id) : [...member.requestedSkillIds, id] })} />
                  <CatalogChoices title={t('characterGenerator.capabilities', '请求的底层能力')} helper={t('characterGenerator.requestedOnly', '仅表示角色希望使用，招募时仍需单独审阅。')} empty={t('characterGenerator.noCapabilities', '当前世界没有可请求的底层能力。')} values={catalog.capabilities.map((capability) => ({ id: capability.id, label: capability.displayName, summary: capability.summary, selected: member.requestedCapabilities.includes(capability.id) }))} onToggle={(id) => { const capabilityId = id as CharacterBlueprintDraft['requestedCapabilities'][number]; onCastChange(index, { requestedCapabilities: member.requestedCapabilities.includes(capabilityId) ? member.requestedCapabilities.filter((value) => value !== capabilityId) : [...member.requestedCapabilities, capabilityId] }) }} />
                  <button className="secondary-button world-generator-cast__remove" type="button" onClick={() => onCastRemove(index)}><Trash size={15} aria-hidden="true" />{t('worldGenerator.removeCast', '移除这名角色')}</button>
                </div>
              </details>
            ))}
            <button className="secondary-button" type="button" disabled={draft.cast.length >= WORLD_THEME_MAX_CAST} onClick={onCastAdd}><Plus size={16} aria-hidden="true" />{t('worldGenerator.addCast', '添加角色')}</button>
          </fieldset>
          <section className="character-generator-world-note"><strong>{t('worldGenerator.baseTemplate', '基础模板')}</strong><span>{t('worldGenerator.baseTemplateHint', '生成的世界基于“我的世界”模板，安装后可从中创建独立的新世界。')}</span></section>
        </div>
      </div>
      {validationError === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{validationError}</div>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{t('characterGenerator.previous', '上一步')}</button><button className="primary-button" type="button" onClick={onContinue}>{t('characterGenerator.next', '下一步')}<ArrowRight size={16} aria-hidden="true" /></button></div>
    </div>
  )
}

interface ScenePicker2DProps {
  options: WorldGeneratorSceneCatalogItem[]
  selection: WorldGeneratorSceneSelection | undefined
  onSelect(option: WorldGeneratorSceneCatalogItem): void
}

/**
 * Official 2D scenes only. Mirrors AvatarPicker2D without the upload half:
 * a user-supplied background is the stated follow-up, not this slice.
 */
export function ScenePicker2D({ options, selection, onSelect }: ScenePicker2DProps) {
  const { t } = useI18n()
  const selected = selection === undefined ? undefined : options.find((option) => option.id === selection.id)
  return (
    <fieldset className="character-generator-avatar world-generator-scene">
      <legend>{t('worldGenerator.sceneTitle', '默认 2D 场景')}</legend>
      <div className="character-generator-avatar__preview world-generator-scene__preview">
        {selected === undefined ? <ImageSquare size={48} aria-hidden="true" /> : <img src={scenePreviewUrl(selected)} alt={selected.displayName} />}
        <div>
          <strong>{selected?.displayName ?? t('worldGenerator.sceneNone', '尚未选择场景')}</strong>
          <span>{t('worldGenerator.sceneHint', '从官方场景中挑选一个作为世界的默认布局；上传自定义背景将在后续版本提供。')}</span>
        </div>
      </div>
      <div className="character-generator-avatar__options world-generator-scene__options" role="group" aria-label={t('worldGenerator.scenePick', '选择一个官方场景')}>
        {options.length === 0 ? <span className="character-generator-empty">{t('worldGenerator.sceneEmpty', '官方场景目录为空。')}</span> : options.map((option) => {
          const active = selection?.id === option.id
          return <button key={option.id} className={active ? 'is-selected' : ''} type="button" aria-label={option.displayName} aria-pressed={active} onClick={() => onSelect(option)}><img src={scenePreviewUrl(option)} alt="" aria-hidden="true" /></button>
        })}
      </div>
    </fieldset>
  )
}

function scenePreviewUrl(option: WorldGeneratorSceneCatalogItem): string {
  return `/api/marketplace/packages/${encodeURIComponent(option.packageId)}/${encodeURIComponent(option.packageVersion)}/preview`
}

interface ListEditorProps {
  id: string
  title: string
  helper: string
  placeholder: string
  addLabel: string
  removeLabel: string
  values: string[]
  maximum: number
  itemMaxLength: number
  ordered?: boolean
  onChange(values: string[]): void
}

function ListEditor({ id, title, helper, placeholder, addLabel, removeLabel, values, maximum, itemMaxLength, ordered = false, onChange }: ListEditorProps) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const value = draft.trim()
    if (value.length === 0 || values.includes(value) || values.length >= maximum) return
    onChange([...values, value])
    setDraft('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    add()
  }
  const List = ordered ? 'ol' : 'ul'
  return (
    <fieldset className="character-generator-fieldset world-generator-list">
      <legend>{title}</legend>
      <p className="character-generator-helper">{helper}</p>
      <div className="character-generator-trait-input"><input id={id} aria-label={title} value={draft} maxLength={itemMaxLength} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} /><button className="secondary-button" type="button" onClick={add} disabled={draft.trim().length === 0 || values.length >= maximum}><Plus size={16} aria-hidden="true" />{addLabel}</button></div>
      <List className="world-generator-list__items">{values.map((value) => <li key={value}><span>{value}</span><button type="button" aria-label={`${removeLabel} ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}><X size={14} aria-hidden="true" /></button></li>)}</List>
    </fieldset>
  )
}

interface WorldPublishStepProps {
  draft: WorldThemeDraft
  source: string
  scene?: WorldGeneratorSceneCatalogItem
  publishing: boolean
  error?: string
  published: boolean
  onBack(): void
  onPublish(): void
  onViewInstall(): void
}

export function WorldPublishStep({ draft, source, scene, publishing, error, published, onBack, onPublish, onViewInstall }: WorldPublishStepProps) {
  const { t } = useI18n()
  if (published) {
    return <div className="character-generator-step character-generator-step--published"><div className="character-generator-published-mark"><Check size={26} aria-hidden="true" /></div><h3>{t('worldGenerator.published', '世界主题已发布')}</h3><p>{t('worldGenerator.publishDescription', '发布会生成一个本地世界主题包和对应的角色模板包，并出现在世界市场与角色市场中。')}</p><button className="primary-button" type="button" data-generator-initial-focus onClick={onViewInstall}>{t('characterGenerator.viewInstall', '查看并安装')}<ArrowRight size={16} aria-hidden="true" /></button></div>
  }
  return (
    <div className="character-generator-step character-generator-step--publish">
      <div className="character-generator-step__heading"><span className="character-generator-step__eyebrow">04</span><div><h3>{t('worldGenerator.publishTitle', '确认发布世界主题')}</h3><p>{t('worldGenerator.publishDescription', '发布会生成一个本地世界主题包和对应的角色模板包，并出现在世界市场与角色市场中。')}</p></div></div>
      <section className="character-generator-publish-card"><div className="character-generator-publish-card__identity"><strong>{draft.displayName}</strong><span>{draft.terminology.world} · {draft.terminology.participant} · {draft.terminology.session} · {draft.terminology.milestone}</span><p>{draft.summary}</p></div><dl><div><dt>{t('worldGenerator.sceneTitle', '默认 2D 场景')}</dt><dd>{scene?.displayName ?? t('worldGenerator.sceneNone', '尚未选择场景')}</dd></div><div><dt>{t('worldGenerator.workflow', '工作流程')}</dt><dd>{draft.workflow.length === 0 ? t('worldGenerator.none', '无') : draft.workflow.join(' → ')}</dd></div><div><dt>{t('worldGenerator.rules', '世界规则')}</dt><dd>{t('worldGenerator.countRules', '{count} 条', { count: draft.rules.length })}</dd></div><div><dt>{t('worldGenerator.cast', '默认角色')}</dt><dd>{draft.cast.length === 0 ? t('worldGenerator.none', '无') : draft.cast.map((member) => member.displayName).join('、')}</dd></div><div><dt>{t('characterGenerator.publishSource', '来源摘要')}</dt><dd>{draft.sourceSummary || source.slice(0, 180)}</dd></div></dl></section>
      <div className="character-generator-publish-notice"><Info size={17} aria-hidden="true" /><span>{t('worldGenerator.publishPackageHint', '发布不会自动安装、创建世界或招募角色。')}</span></div>
      {error === undefined ? null : <div className="character-generator-error" role="alert"><Info size={17} aria-hidden="true" />{error}</div>}
      <div className="character-generator-step__actions"><button className="secondary-button" type="button" disabled={publishing} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{t('characterGenerator.previous', '上一步')}</button><button className="primary-button" type="button" data-generator-initial-focus disabled={publishing} onClick={onPublish}>{publishing ? t('characterGenerator.publishing', '正在发布…') : t('worldGenerator.publishButton', '发布到世界市场')}<Check size={16} aria-hidden="true" /></button></div>
    </div>
  )
}
