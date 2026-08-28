import { ArrowLeft, ArrowRight, BracketsCurly, ChatCircleDots, Check, FileArrowUp, MagnifyingGlass, Plus, Sparkle, Trash, UsersThree } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { ModelProfile, WorldTemplateManifest } from '@dsh-cyber/contracts'
import type { CharacterSkillDescriptor, EmbodimentPresetDescriptor } from '@dsh-cyber/contracts/creative-platform'

import { createRoleDraft, type WorkshopDraft, type WorkshopRoleDraft } from './model.js'
import { WorkshopJsonEditor } from './WorkshopJsonEditor.js'
import { ModelPicker } from '../../features/models/ModelPicker.js'
import { useI18n } from '../../i18n/runtime.js'

interface CreativeWorkshopEditorProps {
  draft: WorkshopDraft
  templates: WorldTemplateManifest[]
  presets: EmbodimentPresetDescriptor[]
  skills: CharacterSkillDescriptor[]
  models: ModelProfile[]
  saving: boolean
  error?: string
  promptReply?: string
  onChange(next: WorkshopDraft): void
  onAnalyzePrompt(input: string): Promise<void>
  onBack(): void
  onSubmit(): void
}

const STEPS = [
  ['workshop.step.world', '世界', 'workshop.step.worldDescription', '名称与目标'],
  ['workshop.step.roles', '角色', 'workshop.step.rolesDescription', '身份与行为'],
  ['workshop.step.permissions', '权限', 'workshop.step.permissionsDescription', '模型与能力'],
  ['workshop.step.review', '确认', 'workshop.step.reviewDescription', '检查后创建'],
] as const

export function CreativeWorkshopEditor({
  draft, templates, presets, skills, models, saving, error, promptReply, onChange, onAnalyzePrompt, onBack, onSubmit,
}: CreativeWorkshopEditorProps) {
  const { t } = useI18n()
  const [step, setStep] = useState(0)
  const [selectedRoleId, setSelectedRoleId] = useState(draft.roles[0]?.clientId)
  const [skillQuery, setSkillQuery] = useState('')
  const [localError, setLocalError] = useState<string>()
  const [jsonOpen, setJsonOpen] = useState(false)
  const presetMap = useMemo(() => new Map(presets.map((preset) => [preset.id, preset])), [presets])
  const selected = draft.roles.find((role) => role.clientId === selectedRoleId) ?? draft.roles[0]
  const fallbackPreset = presets[0]
  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase()
    return query === '' ? skills : skills.filter((skill) => `${skill.displayName} ${skill.summary} ${skill.id}`.toLocaleLowerCase().includes(query))
  }, [skillQuery, skills])

  useEffect(() => {
    if (selected !== undefined) return
    setSelectedRoleId(draft.roles[0]?.clientId)
  }, [draft.roles, selected])

  const patchDraft = (patch: Partial<WorkshopDraft>) => { setLocalError(undefined); onChange({ ...draft, ...patch }) }
  const updateSelected = (patch: Partial<WorkshopRoleDraft>) => {
    if (selected === undefined) return
    setLocalError(undefined)
    onChange({ ...draft, roles: draft.roles.map((role) => role.clientId === selected.clientId ? { ...role, ...patch } : role) })
  }
  const setWorldModel = (modelProfileId: string | undefined) => {
    if (modelProfileId !== undefined) { patchDraft({ worldModelProfileId: modelProfileId }); return }
    const next = { ...draft }
    delete next.worldModelProfileId
    onChange(next)
  }
  const setSelectedModel = (modelProfileId: string | undefined) => {
    if (selected === undefined) return
    const next = { ...selected }
    if (modelProfileId === undefined) delete next.modelProfileId
    else next.modelProfileId = modelProfileId
    onChange({ ...draft, roles: draft.roles.map((role) => role.clientId === selected.clientId ? next : role) })
  }
  const addRole = () => {
    if (draft.roles.length >= 16 || fallbackPreset === undefined) return
    const role = createRoleDraft(draft.roles.length + 1, fallbackPreset)
    onChange({ ...draft, roles: [...draft.roles, role] })
    setSelectedRoleId(role.clientId)
  }
  const removeRole = (roleId: string) => {
    if (draft.roles.length <= 1) return
    const next = draft.roles.filter((role) => role.clientId !== roleId)
    onChange({ ...draft, roles: next })
    if (selectedRoleId === roleId) setSelectedRoleId(next[0]?.clientId)
  }
  const applyPreset = (preset: EmbodimentPresetDescriptor) => updateSelected({ embodimentPresetId: preset.id, embodiment: structuredClone(preset.profile) })
  const goNext = () => {
    const message = validateStep(step, draft, t)
    if (message !== undefined) { setLocalError(message); return }
    setLocalError(undefined)
    setStep((current) => Math.min(STEPS.length - 1, current + 1))
  }

  return (
    <div className="creative-workshop-editor-shell creative-workshop-wizard">
      <div className="creative-workshop-editor-nav">
        <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={14} />{t('workshop.back', '返回项目库')}</button>
        <span>{t('workshop.newWorld', '新建本地世界')}</span>
      </div>

      <ol className="creative-workshop-steps" aria-label={t('workshop.stepsAria', '创建世界步骤')}>
        {STEPS.map(([labelKey, labelFallback, descriptionKey, descriptionFallback], index) => <li key={labelKey} className={index === step ? 'is-active' : index < step ? 'is-complete' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? <Check size={14} /> : index + 1}</span><div><strong>{t(labelKey, labelFallback)}</strong><small>{t(descriptionKey, descriptionFallback)}</small></div></li>)}
      </ol>

      <main className="creative-workshop-wizard__body">
        {step === 0 ? <section className="creative-workshop-wizard__section" aria-labelledby="workshop-world-step">
          <header><Sparkle size={22} /><div><h3 id="workshop-world-step">{t('workshop.world.title', '先描述你要创建的世界')}</h3><p>{t('workshop.world.description', '名称和当前目标足以开始；详细背景可以稍后继续完善。')}</p></div></header>
          <WorkshopPromptAssistant reply={promptReply} onAnalyze={onAnalyzePrompt} />
          <label className="dialog-field"><span>{t('workshop.world.name', '世界名称')}</span><input autoFocus value={draft.displayName} maxLength={80} placeholder={t('workshop.world.namePlaceholder', '例如：短剧增长工作室')} onChange={(event) => patchDraft({ displayName: event.target.value })} /></label>
          <label className="dialog-field"><span>{t('workshop.world.template', '基础世界模板')}</span><select value={draft.baseTemplateId} onChange={(event) => patchDraft({ baseTemplateId: event.target.value })}>{templates.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><small>{t('workshop.world.templateHelp', '模板只决定场景和运行能力，不会替角色决定身份或权限。')}</small></label>
          <label className="dialog-field"><span>{t('workshop.world.scenario', '当前目标')}</span><textarea rows={3} value={draft.scenario} placeholder={t('workshop.world.scenarioPlaceholder', '这个世界现在要完成什么？')} onChange={(event) => patchDraft({ scenario: event.target.value })} /></label>
          <details className="workshop-disclosure"><summary>{t('workshop.world.loreDisclosure', '补充长期世界观')}</summary><label className="dialog-field"><span>{t('workshop.world.lore', '背景、规则与文化')}</span><textarea rows={5} value={draft.lore} placeholder={t('workshop.world.lorePlaceholder', '可选。记录这个世界长期遵循的设定。')} onChange={(event) => patchDraft({ lore: event.target.value })} /></label></details>
        </section> : null}

        {step === 1 ? <section className="creative-workshop-wizard__section" aria-labelledby="workshop-role-step">
          <header><UsersThree size={22} /><div><h3 id="workshop-role-step">{t('workshop.roles.title', '检查初始角色')}</h3><p>{t('workshop.roles.description', '创建角色只需要名字；身份、职责和工作方式都可以现在补充，也可以创建后再完善。')}</p></div></header>
          <RolePicker draft={draft} selectedRoleId={selected?.clientId} presetMap={presetMap} onSelect={setSelectedRoleId} onAdd={addRole} onRemove={removeRole} canAdd={draft.roles.length < 16 && fallbackPreset !== undefined} />
          {selected === undefined ? null : <div className="creative-workshop-role-form">
            <label className="dialog-field"><span>{t('workshop.roles.name', '角色名字')}</span><input value={selected.displayName} maxLength={50} placeholder={t('workshop.roles.namePlaceholder', '例如：阿策')} onChange={(event) => updateSelected({ displayName: event.target.value })} /></label>
            <details className="workshop-disclosure"><summary>{t('workshop.roles.details', '推荐信息与高级设置（可稍后补充）')}</summary>
              <label className="dialog-field"><span>{t('workshop.roles.identity', '岗位 / 身份（可选）')}</span><input value={selected.role} maxLength={100} placeholder={t('workshop.roles.identityPlaceholder', '例如：内容增长负责人')} onChange={(event) => updateSelected({ role: event.target.value })} /></label>
              <label className="dialog-field"><span>{t('workshop.roles.summary', '职责摘要（可选）')}</span><textarea rows={3} value={selected.summary} maxLength={500} placeholder={t('workshop.roles.summaryPlaceholder', '负责什么、交付什么、对什么结果负责。')} onChange={(event) => updateSelected({ summary: event.target.value })} /></label>
              <label className="dialog-field"><span>{t('workshop.roles.persona', '工作原则与表达方式（可选）')}</span><textarea rows={5} value={selected.persona} maxLength={2000} placeholder={t('workshop.roles.personaPlaceholder', '事实边界、协作方式、决策习惯和表达风格。')} onChange={(event) => updateSelected({ persona: event.target.value })} /></label>
              <fieldset className="creative-workshop-presets"><legend>{t('workshop.roles.behavior', '在世界中的行为方式')}</legend><p>{t('workshop.roles.behaviorHelp', '只选择语义角色，不包含坐标或主题实现。')}</p><div>{presets.map((preset) => <label key={preset.id} className={selected.embodimentPresetId === preset.id ? 'is-active' : ''}><input type="radio" name={`preset-${selected.clientId}`} checked={selected.embodimentPresetId === preset.id} onChange={() => applyPreset(preset)} /><strong>{preset.displayName}</strong><small>{preset.description}</small></label>)}</div></fieldset>
            </details>
          </div>}
        </section> : null}

        {step === 2 ? <section className="creative-workshop-wizard__section" aria-labelledby="workshop-permission-step">
          <header><Sparkle size={22} /><div><h3 id="workshop-permission-step">{t('workshop.permissions.title', '检查模型与能力')}</h3><p>{t('workshop.permissions.description', '模型按应用 → 世界 → 角色继承；技能仍只是请求，外部写入和副作用必须在具体动作时审批。')}</p></div></header>
          <div className="workshop-model-review">
            <label><span><strong>{t('workshop.permissions.worldModel', '世界默认模型')}</strong><small>{t('workshop.permissions.worldModelHelp', '未单独设置的角色会继承它')}</small></span><ModelPicker models={models} value={draft.worldModelProfileId} inheritLabel={t('workshop.permissions.inheritAppModel', '继承应用默认模型')} ariaLabel={t('workshop.permissions.chooseWorldModel', '选择世界默认模型')} onChange={setWorldModel} /></label>
            {selected === undefined ? null : <label><span><strong>{selected.displayName || t('workshop.permissions.currentRole', '当前角色')}的模型</strong><small>{t('workshop.permissions.roleModelHelp', '角色覆盖只保存 ModelProfile 引用，不复制 API 密钥')}</small></span><ModelPicker models={models} value={selected.modelProfileId} inheritLabel={t('workshop.permissions.inheritWorldModel', '继承世界默认模型')} ariaLabel={t('workshop.permissions.chooseRoleModel', '选择角色模型')} onChange={setSelectedModel} /></label>}
          </div>
          <RolePicker draft={draft} selectedRoleId={selected?.clientId} presetMap={presetMap} onSelect={setSelectedRoleId} onAdd={addRole} onRemove={removeRole} canAdd={false} compact />
          {selected === undefined ? null : <>
            <label className="workshop-skill-search"><MagnifyingGlass size={17} /><input type="search" value={skillQuery} placeholder={t('workshop.permissions.skillsSearch', '搜索技能名称、用途或 ID')} aria-label={t('workshop.permissions.skillsSearchAria', '搜索角色技能')} onChange={(event) => setSkillQuery(event.target.value)} /></label>
            <div className="creative-workshop-permission-summary"><strong>{selected.displayName || t('workshop.permissions.currentRole', '当前角色')}</strong><span>{t('workshop.permissions.selectedSkills', '已选择 {count} 个技能', { count: selected.requestedSkillIds.length })}</span></div>
            {skills.length === 0 ? <div className="dialog-empty">{t('workshop.permissions.noSkills', '当前宿主没有注册可用技能。')}</div> : visibleSkills.length === 0 ? <div className="dialog-empty">{t('workshop.permissions.noMatches', '没有匹配的技能。')}</div> : <div className="creative-workshop-skill-catalog">{visibleSkills.map((skill) => <label key={skill.id} className={selected.requestedSkillIds.includes(skill.id) ? 'is-selected' : ''}><input type="checkbox" checked={selected.requestedSkillIds.includes(skill.id)} onChange={(event) => updateSelected({ requestedSkillIds: event.target.checked ? [...selected.requestedSkillIds, skill.id] : selected.requestedSkillIds.filter((id) => id !== skill.id) })} /><span><strong>{skill.displayName}</strong><small>{skill.summary}</small><em>{skill.kind === 'integration' ? t('workshop.permissions.external', '外部连接') : t('workshop.permissions.method', '工作方法')} · {riskLabel(skill, t)}</em></span></label>)}</div>}
            <p className="creative-workshop-permission-note">{t('workshop.permissions.note', '创建世界会保存这些能力请求。角色获得技能授权后才能执行；涉及外部副作用的具体动作仍需按审批策略确认。')}</p>
          </>}
        </section> : null}

        {step === 3 ? <section className="creative-workshop-wizard__section" aria-labelledby="workshop-review-step">
          <header><Check size={22} /><div><h3 id="workshop-review-step">{t('workshop.review.title', '确认后创建本地世界')}</h3><p>{t('workshop.review.description', '项目源和生成包都会保存在本地，程序更新不会覆盖它们。')}</p></div></header>
          <button type="button" className="secondary-button workshop-json-open" onClick={() => setJsonOpen(true)}><BracketsCurly size={16}/>{t('workshop.review.json', '查看和编辑 JSON')}</button>
          <dl className="creative-workshop-review"><div><dt>{t('workshop.review.world', '世界')}</dt><dd>{draft.displayName}</dd></div><div><dt>{t('workshop.review.template', '基础模板')}</dt><dd>{templates.find((item) => item.id === draft.baseTemplateId)?.displayName ?? draft.baseTemplateId}</dd></div><div><dt>{t('workshop.review.scenario', '当前目标')}</dt><dd>{draft.scenario || t('workshop.review.notFilled', '未填写')}</dd></div><div><dt>{t('workshop.review.roles', '初始角色')}</dt><dd>{draft.roles.length} 个</dd></div></dl>
          <div className="creative-workshop-review-roles">{draft.roles.map((role) => <article key={role.clientId}><header><strong>{role.displayName}</strong><span>{role.role || t('workshop.review.identityLater', '身份可稍后完善')}</span></header><p>{role.summary || t('workshop.review.summaryLater', '职责可稍后完善')}</p><small>{role.modelProfileId === undefined ? t('workshop.review.inheritModel', '模型继承世界默认') : t('workshop.review.customModel', '自定义模型：{name}', { name: models.find((model) => model.id === role.modelProfileId)?.displayName ?? t('workshop.review.modelUnavailable', '当前模型不可用') })} · {role.requestedSkillIds.length === 0 ? t('workshop.review.noSkills', '未请求额外技能') : t('workshop.review.skillsCount', '请求 {count} 个技能', { count: role.requestedSkillIds.length })}</small></article>)}</div>
        </section> : null}
      </main>

      {localError ?? error ? <div className="creative-workshop-error" role="alert">{localError ?? error}</div> : null}
      <footer className="dialog-footer creative-workshop-editor-footer"><span>{t('workshop.footer.step', '第 {current} 步，共 {total} 步', { current: step + 1, total: STEPS.length })}</span><div>{step === 0 ? <button className="text-button" type="button" onClick={onBack}>{t('workshop.cancel', '取消')}</button> : <button className="text-button" type="button" onClick={() => { setLocalError(undefined); setStep((current) => Math.max(0, current - 1)) }}><ArrowLeft size={14} />{t('workshop.previous', '上一步')}</button>}{step < STEPS.length - 1 ? <button className="primary-button" type="button" onClick={goNext}>{t('workshop.next', '下一步')}<ArrowRight size={14} /></button> : <button className="primary-button" type="button" disabled={saving} onClick={onSubmit}>{saving ? t('workshop.creating', '正在构建世界…') : t('workshop.create', '创建世界')}</button>}</div></footer>
      {jsonOpen ? <WorkshopJsonEditor draft={draft} templates={templates} presets={presets} onApply={(next) => { onChange(next); setLocalError(undefined) }} onClose={() => setJsonOpen(false)} /> : null}
    </div>
  )
}

function WorkshopPromptAssistant({ reply, onAnalyze }: { reply: string | undefined; onAnalyze(input: string): Promise<void> }) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string>()
  const [analyzing, setAnalyzing] = useState(false)

  const submit = async () => {
    const input = value.trim()
    if (input.length === 0) return
    setFileError(undefined)
    setAnalyzing(true)
    try {
      await onAnalyze(input)
    } finally {
      setAnalyzing(false)
    }
  }

  const importPrompt = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      setFileError(t('workshop.prompt.fileTooLarge', '提示词文件不能超过 2 MiB'))
      return
    }
    setReading(true)
    try {
      const text = await file.text()
      setFileError(undefined)
      setValue(text)
      await onAnalyze(text)
    } catch {
      setFileError(t('workshop.prompt.fileReadError', '提示词文件读取失败，请重新选择'))
    } finally {
      setReading(false)
    }
  }

  return (
    <section className="creative-workshop-prompt-assistant" aria-labelledby="workshop-prompt-assistant-title">
      <header>
        <ChatCircleDots size={20} />
        <div><strong id="workshop-prompt-assistant-title">{t('workshop.prompt.title', 'AI 草稿助手')}</strong><small>{t('workshop.prompt.description', '输入描述后只填充可编辑草稿；不会创建世界，也不会自动授予任何权限')}</small></div>
      </header>
      <textarea value={value} rows={4} placeholder={t('workshop.prompt.placeholder', '例如：创建一个围绕短剧制作的内容工作室，包含编剧、剪辑和审校角色……')} onChange={(event) => { setFileError(undefined); setValue(event.target.value) }} />
      <footer>
        <button className="primary-button" type="button" disabled={reading || analyzing || value.trim().length === 0} onClick={() => void submit()}>{analyzing ? t('workshop.prompt.generating', '正在生成草稿…') : t('workshop.prompt.generate', 'AI 生成草稿')}</button>
        <label className="creative-workshop-prompt-assistant__import"><FileArrowUp size={16} />{t('workshop.prompt.import', '导入提示词文件')}<input type="file" accept=".txt,.md,.json,application/json,text/plain,text/markdown" disabled={reading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPrompt(file); event.target.value = '' }} /></label>
      </footer>
      {fileError === undefined ? null : <p className="creative-workshop-prompt-assistant__error" role="alert">{fileError}</p>}
      {reply === undefined ? null : <p role="status">{reply}</p>}
    </section>
  )
}

function RolePicker({ draft, selectedRoleId, presetMap, onSelect, onAdd, onRemove, canAdd, compact = false }: { draft: WorkshopDraft; selectedRoleId: string | undefined; presetMap: Map<string, EmbodimentPresetDescriptor>; onSelect(id: string): void; onAdd(): void; onRemove(id: string): void; canAdd: boolean; compact?: boolean }) {
  const { t } = useI18n()
  return <div className={`creative-workshop-role-picker${compact ? ' is-compact' : ''}`}><div className="creative-workshop-role-picker__list" aria-label={t('workshop.roles.aria', '角色列表')}>{draft.roles.map((role, index) => <button key={role.clientId} type="button" className={role.clientId === selectedRoleId ? 'is-active' : ''} onClick={() => onSelect(role.clientId)}><span>{index + 1}</span><div><strong>{role.displayName || t('workshop.roles.fallback', '角色 {index}', { index: index + 1 })}</strong><small>{role.role || presetMap.get(role.embodimentPresetId ?? '')?.displayName || t('workshop.roles.pending', '待配置')}</small></div></button>)}</div><div className="creative-workshop-role-picker__actions">{canAdd ? <button type="button" className="secondary-button" onClick={onAdd}><Plus size={15} />{t('workshop.roles.add', '添加角色')}</button> : null}{!compact && draft.roles.length > 1 && selectedRoleId ? <button type="button" className="text-button is-danger" onClick={() => onRemove(selectedRoleId)}><Trash size={15} />{t('workshop.roles.remove', '移除当前角色')}</button> : null}</div></div>
}

function validateStep(step: number, draft: WorkshopDraft, t: ReturnType<typeof useI18n>['t']): string | undefined {
  if (step === 0) {
    if (!draft.displayName.trim()) return t('workshop.validation.worldName', '请先填写世界名称')
    if (!draft.baseTemplateId.trim()) return t('workshop.validation.template', '请选择基础世界模板')
  }
  if (step === 1) {
    const incomplete = draft.roles.find((role) => !role.displayName.trim())
    if (incomplete !== undefined) return t('workshop.validation.roleNames', '请为每个角色填写名字')
  }
  return undefined
}

function riskLabel(skill: CharacterSkillDescriptor, t: ReturnType<typeof useI18n>['t']): string {
  if (skill.risks.includes('external-side-effect')) return t('workshop.permissions.riskExternal', '外部操作需审批')
  if (skill.risks.includes('write-local')) return t('workshop.permissions.riskWrite', '可写当前世界')
  return t('workshop.permissions.riskRead', '只读')
}
