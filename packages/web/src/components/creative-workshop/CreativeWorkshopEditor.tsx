import { ArrowLeft, ArrowRight, ChatCircleDots, Check, FileArrowUp, MagnifyingGlass, Plus, Sparkle, Trash, UsersThree } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import type { CharacterSkillDescriptor, EmbodimentPresetDescriptor } from '@dsh-cyber/contracts/creative-platform'

import { createRoleDraft, type WorkshopDraft, type WorkshopRoleDraft } from './model.js'

interface CreativeWorkshopEditorProps {
  draft: WorkshopDraft
  templates: WorldTemplateManifest[]
  presets: EmbodimentPresetDescriptor[]
  skills: CharacterSkillDescriptor[]
  saving: boolean
  error?: string
  promptReply?: string
  onChange(next: WorkshopDraft): void
  onAnalyzePrompt(input: string): void
  onBack(): void
  onSubmit(): void
}

const STEPS = [
  ['世界', '名称与目标'],
  ['角色', '身份与行为'],
  ['权限', 'Skills 与风险'],
  ['确认', '检查后创建'],
] as const

export function CreativeWorkshopEditor({
  draft, templates, presets, skills, saving, error, promptReply, onChange, onAnalyzePrompt, onBack, onSubmit,
}: CreativeWorkshopEditorProps) {
  const [step, setStep] = useState(0)
  const [selectedRoleId, setSelectedRoleId] = useState(draft.roles[0]?.clientId)
  const [skillQuery, setSkillQuery] = useState('')
  const [localError, setLocalError] = useState<string>()
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
    const message = validateStep(step, draft)
    if (message !== undefined) { setLocalError(message); return }
    setLocalError(undefined)
    setStep((current) => Math.min(STEPS.length - 1, current + 1))
  }

  return (
    <div className="creative-workshop-editor-shell creative-workshop-wizard">
      <div className="creative-workshop-editor-nav">
        <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={14} />返回项目库</button>
        <span>新建本地世界</span>
      </div>

      <ol className="creative-workshop-steps" aria-label="创建世界步骤">
        {STEPS.map(([label, description], index) => <li key={label} className={index === step ? 'is-active' : index < step ? 'is-complete' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? <Check size={14} /> : index + 1}</span><div><strong>{label}</strong><small>{description}</small></div></li>)}
      </ol>

      <main className="creative-workshop-wizard__body">
        {step === 0 ? <section className="creative-workshop-wizard__section" aria-labelledby="workshop-world-step">
          <header><Sparkle size={22} /><div><h3 id="workshop-world-step">先描述你要创建的世界</h3><p>名称和当前目标足以开始；详细背景可以稍后继续完善。</p></div></header>
          <WorkshopPromptAssistant reply={promptReply} onAnalyze={onAnalyzePrompt} />
          <label className="dialog-field"><span>世界名称</span><input autoFocus value={draft.displayName} maxLength={80} placeholder="例如：短剧增长工作室" onChange={(event) => patchDraft({ displayName: event.target.value })} /></label>
          <label className="dialog-field"><span>基础世界模板</span><select value={draft.baseTemplateId} onChange={(event) => patchDraft({ baseTemplateId: event.target.value })}>{templates.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><small>模板只决定场景和运行能力，不会替角色决定身份或权限。</small></label>
          <label className="dialog-field"><span>当前目标</span><textarea rows={3} value={draft.scenario} placeholder="这个世界现在要完成什么？" onChange={(event) => patchDraft({ scenario: event.target.value })} /></label>
          <details className="workshop-disclosure"><summary>补充长期世界观</summary><label className="dialog-field"><span>背景、规则与文化</span><textarea rows={5} value={draft.lore} placeholder="可选。记录这个世界长期遵循的设定。" onChange={(event) => patchDraft({ lore: event.target.value })} /></label></details>
        </section> : null}

        {step === 1 ? <section className="creative-workshop-wizard__section" aria-labelledby="workshop-role-step">
          <header><UsersThree size={22} /><div><h3 id="workshop-role-step">配置初始角色</h3><p>先选择一个角色，再完成他的职责和工作方式。你可以创建多个角色。</p></div></header>
          <RolePicker draft={draft} selectedRoleId={selected?.clientId} presetMap={presetMap} onSelect={setSelectedRoleId} onAdd={addRole} onRemove={removeRole} canAdd={draft.roles.length < 16 && fallbackPreset !== undefined} />
          {selected === undefined ? null : <div className="creative-workshop-role-form">
            <label className="dialog-field"><span>角色名字</span><input value={selected.displayName} maxLength={50} placeholder="例如：阿策" onChange={(event) => updateSelected({ displayName: event.target.value })} /></label>
            <label className="dialog-field"><span>岗位 / 身份</span><input value={selected.role} maxLength={100} placeholder="例如：内容增长负责人" onChange={(event) => updateSelected({ role: event.target.value })} /></label>
            <label className="dialog-field"><span>职责摘要</span><textarea rows={3} value={selected.summary} maxLength={500} placeholder="负责什么、交付什么、对什么结果负责。" onChange={(event) => updateSelected({ summary: event.target.value })} /></label>
            <label className="dialog-field"><span>工作原则与表达方式</span><textarea rows={5} value={selected.persona} maxLength={2000} placeholder="事实边界、协作方式、决策习惯和表达风格。" onChange={(event) => updateSelected({ persona: event.target.value })} /></label>
            <fieldset className="creative-workshop-presets"><legend>在世界中的行为方式</legend><p>只选择语义角色，不包含坐标或主题实现。</p><div>{presets.map((preset) => <label key={preset.id} className={selected.embodimentPresetId === preset.id ? 'is-active' : ''}><input type="radio" name={`preset-${selected.clientId}`} checked={selected.embodimentPresetId === preset.id} onChange={() => applyPreset(preset)} /><strong>{preset.displayName}</strong><small>{preset.description}</small></label>)}</div></fieldset>
          </div>}
        </section> : null}

        {step === 2 ? <section className="creative-workshop-wizard__section" aria-labelledby="workshop-permission-step">
          <header><Sparkle size={22} /><div><h3 id="workshop-permission-step">为角色配置能力范围</h3><p>这里决定角色会请求哪些 Skills。外部写入和副作用仍会在具体动作发生时经过审批。</p></div></header>
          <RolePicker draft={draft} selectedRoleId={selected?.clientId} presetMap={presetMap} onSelect={setSelectedRoleId} onAdd={addRole} onRemove={removeRole} canAdd={false} compact />
          {selected === undefined ? null : <>
            <label className="workshop-skill-search"><MagnifyingGlass size={17} /><input type="search" value={skillQuery} placeholder="搜索 Skill 名称、用途或 ID" aria-label="搜索角色 Skills" onChange={(event) => setSkillQuery(event.target.value)} /></label>
            <div className="creative-workshop-permission-summary"><strong>{selected.displayName || '当前角色'}</strong><span>已选择 {selected.requestedSkillIds.length} 个 Skill</span></div>
            {skills.length === 0 ? <div className="dialog-empty">当前宿主没有注册可用 Skill。</div> : visibleSkills.length === 0 ? <div className="dialog-empty">没有匹配的 Skill。</div> : <div className="creative-workshop-skill-catalog">{visibleSkills.map((skill) => <label key={skill.id} className={selected.requestedSkillIds.includes(skill.id) ? 'is-selected' : ''}><input type="checkbox" checked={selected.requestedSkillIds.includes(skill.id)} onChange={(event) => updateSelected({ requestedSkillIds: event.target.checked ? [...selected.requestedSkillIds, skill.id] : selected.requestedSkillIds.filter((id) => id !== skill.id) })} /><span><strong>{skill.displayName}</strong><small>{skill.summary}</small><em>{skill.kind === 'integration' ? '外部连接' : '工作方法'} · {riskLabel(skill)}</em></span></label>)}</div>}
            <p className="creative-workshop-permission-note">创建世界会保存这些能力请求。角色获得 Skill Grant 后才能执行；涉及外部副作用的具体动作仍需按审批策略确认。</p>
          </>}
        </section> : null}

        {step === 3 ? <section className="creative-workshop-wizard__section" aria-labelledby="workshop-review-step">
          <header><Check size={22} /><div><h3 id="workshop-review-step">确认后创建本地世界</h3><p>项目源和生成包都会保存在本地，程序更新不会覆盖它们。</p></div></header>
          <dl className="creative-workshop-review"><div><dt>世界</dt><dd>{draft.displayName}</dd></div><div><dt>基础模板</dt><dd>{templates.find((item) => item.id === draft.baseTemplateId)?.displayName ?? draft.baseTemplateId}</dd></div><div><dt>当前目标</dt><dd>{draft.scenario || '未填写'}</dd></div><div><dt>初始角色</dt><dd>{draft.roles.length} 个</dd></div></dl>
          <div className="creative-workshop-review-roles">{draft.roles.map((role) => <article key={role.clientId}><header><strong>{role.displayName}</strong><span>{role.role}</span></header><p>{role.summary}</p><small>{role.requestedSkillIds.length === 0 ? '未请求额外 Skill' : `请求 ${role.requestedSkillIds.length} 个 Skill`}</small></article>)}</div>
        </section> : null}
      </main>

      {localError ?? error ? <div className="creative-workshop-error" role="alert">{localError ?? error}</div> : null}
      <footer className="dialog-footer creative-workshop-editor-footer"><span>第 {step + 1} 步，共 {STEPS.length} 步</span><div>{step === 0 ? <button className="text-button" type="button" onClick={onBack}>取消</button> : <button className="text-button" type="button" onClick={() => { setLocalError(undefined); setStep((current) => Math.max(0, current - 1)) }}><ArrowLeft size={14} />上一步</button>}{step < STEPS.length - 1 ? <button className="primary-button" type="button" onClick={goNext}>下一步<ArrowRight size={14} /></button> : <button className="primary-button" type="button" disabled={saving} onClick={onSubmit}>{saving ? '正在构建世界…' : '创建世界'}</button>}</div></footer>
    </div>
  )
}

function WorkshopPromptAssistant({ reply, onAnalyze }: { reply: string | undefined; onAnalyze(input: string): void }) {
  const [value, setValue] = useState('')
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string>()

  const submit = () => {
    const input = value.trim()
    if (input.length === 0) return
    setFileError(undefined)
    onAnalyze(input)
  }

  const importPrompt = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      setFileError('提示词文件不能超过 2 MiB')
      return
    }
    setReading(true)
    try {
      const text = await file.text()
      setFileError(undefined)
      setValue(text)
      onAnalyze(text)
    } catch {
      setFileError('提示词文件读取失败，请重新选择')
    } finally {
      setReading(false)
    }
  }

  return (
    <section className="creative-workshop-prompt-assistant" aria-labelledby="workshop-prompt-assistant-title">
      <header>
        <ChatCircleDots size={20} />
        <div><strong id="workshop-prompt-assistant-title">创意助手</strong><small>可以直接描述目标，也可以粘贴完整 JSON 或导入提示词文件</small></div>
      </header>
      <textarea value={value} rows={4} placeholder="例如：创建一个围绕短剧制作的内容工作室，包含编剧、剪辑和审校角色……" onChange={(event) => { setFileError(undefined); setValue(event.target.value) }} />
      <footer>
        <button className="primary-button" type="button" disabled={reading || value.trim().length === 0} onClick={submit}>根据描述生成草稿</button>
        <label className="creative-workshop-prompt-assistant__import"><FileArrowUp size={16} />导入提示词文件<input type="file" accept=".txt,.md,.json,application/json,text/plain,text/markdown" disabled={reading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPrompt(file); event.target.value = '' }} /></label>
      </footer>
      {fileError === undefined ? null : <p className="creative-workshop-prompt-assistant__error" role="alert">{fileError}</p>}
      {reply === undefined ? null : <p role="status">{reply}</p>}
    </section>
  )
}

function RolePicker({ draft, selectedRoleId, presetMap, onSelect, onAdd, onRemove, canAdd, compact = false }: { draft: WorkshopDraft; selectedRoleId: string | undefined; presetMap: Map<string, EmbodimentPresetDescriptor>; onSelect(id: string): void; onAdd(): void; onRemove(id: string): void; canAdd: boolean; compact?: boolean }) {
  return <div className={`creative-workshop-role-picker${compact ? ' is-compact' : ''}`}><div className="creative-workshop-role-picker__list">{draft.roles.map((role, index) => <button key={role.clientId} type="button" className={role.clientId === selectedRoleId ? 'is-active' : ''} onClick={() => onSelect(role.clientId)}><span>{index + 1}</span><div><strong>{role.displayName || `角色 ${index + 1}`}</strong><small>{role.role || presetMap.get(role.embodimentPresetId ?? '')?.displayName || '待配置'}</small></div></button>)}</div><div className="creative-workshop-role-picker__actions">{canAdd ? <button type="button" className="secondary-button" onClick={onAdd}><Plus size={15} />添加角色</button> : null}{!compact && draft.roles.length > 1 && selectedRoleId ? <button type="button" className="text-button is-danger" onClick={() => onRemove(selectedRoleId)}><Trash size={15} />移除当前角色</button> : null}</div></div>
}

function validateStep(step: number, draft: WorkshopDraft): string | undefined {
  if (step === 0) {
    if (!draft.displayName.trim()) return '请先填写世界名称'
    if (!draft.baseTemplateId.trim()) return '请选择基础世界模板'
  }
  if (step === 1) {
    const incomplete = draft.roles.find((role) => !role.displayName.trim() || !role.role.trim() || !role.summary.trim() || !role.persona.trim())
    if (incomplete !== undefined) return `请补全角色“${incomplete.displayName || incomplete.role || '未命名角色'}”的名字、身份、职责和工作原则`
  }
  return undefined
}

function riskLabel(skill: CharacterSkillDescriptor): string {
  if (skill.risks.includes('external-side-effect')) return '外部操作需审批'
  if (skill.risks.includes('write-local')) return '可写当前世界'
  return '只读'
}
