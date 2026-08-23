import { ArrowLeft, Plus, Sparkle, Trash } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import type {
  CharacterSkillDescriptor,
  EmbodimentPresetDescriptor,
} from '@dsh-cyber/contracts/creative-platform'

import { createRoleDraft, type WorkshopDraft, type WorkshopRoleDraft } from './model.js'

interface CreativeWorkshopEditorProps {
  draft: WorkshopDraft
  templates: WorldTemplateManifest[]
  presets: EmbodimentPresetDescriptor[]
  skills: CharacterSkillDescriptor[]
  saving: boolean
  error?: string
  onChange(next: WorkshopDraft): void
  onBack(): void
  onSubmit(): void
}

export function CreativeWorkshopEditor({
  draft,
  templates,
  presets,
  skills,
  saving,
  error,
  onChange,
  onBack,
  onSubmit,
}: CreativeWorkshopEditorProps) {
  const [selectedRoleId, setSelectedRoleId] = useState(draft.roles[0]?.clientId)
  const presetMap = useMemo(() => new Map(presets.map((preset) => [preset.id, preset])), [presets])
  const selected = draft.roles.find((role) => role.clientId === selectedRoleId) ?? draft.roles[0]
  const fallbackPresetId = presets[0]?.id ?? 'general'

  useEffect(() => {
    if (selected !== undefined) return
    setSelectedRoleId(draft.roles[0]?.clientId)
  }, [draft.roles, selected])

  const patchDraft = (patch: Partial<WorkshopDraft>) => onChange({ ...draft, ...patch })
  const updateSelected = (patch: Partial<WorkshopRoleDraft>) => {
    if (selected === undefined) return
    onChange({
      ...draft,
      roles: draft.roles.map((role) => role.clientId === selected.clientId ? { ...role, ...patch } : role),
    })
  }

  const addRole = () => {
    if (draft.roles.length >= 16) return
    const role = createRoleDraft(draft.roles.length + 1, fallbackPresetId)
    onChange({ ...draft, roles: [...draft.roles, role] })
    setSelectedRoleId(role.clientId)
  }

  const removeRole = (roleId: string) => {
    if (draft.roles.length <= 1) return
    const next = draft.roles.filter((role) => role.clientId !== roleId)
    onChange({ ...draft, roles: next })
    if (selectedRoleId === roleId) setSelectedRoleId(next[0]?.clientId)
  }

  return (
    <div className="creative-workshop-editor-shell">
      <div className="creative-workshop-editor-nav">
        <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={14} />返回项目库</button>
        <span>新建本地世界</span>
      </div>

      <div className="creative-workshop-layout">
        <aside className="creative-workshop-sidebar">
          <section className="creative-workshop-world-card">
            <div className="creative-workshop-section-title"><Sparkle size={17} /><strong>世界项目</strong></div>
            <label className="dialog-field"><span>世界名称</span><input value={draft.displayName} maxLength={80} placeholder="例如：短剧增长工作室" onChange={(event) => patchDraft({ displayName: event.target.value })} /></label>
            <label className="dialog-field"><span>基础运行时模板</span><select value={draft.baseTemplateId} onChange={(event) => patchDraft({ baseTemplateId: event.target.value })}>{templates.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><small>模板只提供场景能力；角色岗位、具身语义与 Skill 单独定义。</small></label>
            <label className="dialog-field"><span>世界观 / 背景</span><textarea rows={3} value={draft.lore} placeholder="这个世界长期遵循的背景、规则和文化。" onChange={(event) => patchDraft({ lore: event.target.value })} /></label>
            <label className="dialog-field"><span>当前场景 / 经营目标</span><textarea rows={2} value={draft.scenario} placeholder="当前阶段的业务、故事或经营目标。" onChange={(event) => patchDraft({ scenario: event.target.value })} /></label>
          </section>

          <div className="creative-workshop-role-heading"><strong>初始角色</strong><button type="button" onClick={addRole} disabled={draft.roles.length >= 16}><Plus size={15} />添加</button></div>
          <div className="creative-workshop-role-list">
            {draft.roles.map((role, index) => (
              <button key={role.clientId} type="button" className={role.clientId === selected?.clientId ? 'is-active' : ''} onClick={() => setSelectedRoleId(role.clientId)}>
                <span>{index + 1}</span><div><strong>{role.displayName || `角色 ${index + 1}`}</strong><small>{role.role || presetMap.get(role.embodimentPresetId)?.displayName || '自定义角色'}</small></div>
              </button>
            ))}
          </div>
        </aside>

        <main className="creative-workshop-role-editor">
          {selected === undefined ? null : <>
            <div className="creative-workshop-role-toolbar">
              <div><h3>{selected.displayName || '配置角色'}</h3><p>显示名称、Agent Persona、空间具身语义和 Skill 请求彼此独立，不从职位字符串推断权限。</p></div>
              <button type="button" className="text-button" disabled={draft.roles.length <= 1} onClick={() => removeRole(selected.clientId)}><Trash size={15} />删除角色</button>
            </div>

            <div className="creative-workshop-grid">
              <label className="dialog-field"><span>角色名字</span><input value={selected.displayName} maxLength={50} placeholder="阿策" onChange={(event) => updateSelected({ displayName: event.target.value })} /></label>
              <label className="dialog-field"><span>岗位 / 身份</span><input value={selected.role} maxLength={100} placeholder="短剧投流专家" onChange={(event) => updateSelected({ role: event.target.value })} /></label>
            </div>
            <label className="dialog-field"><span>角色简介</span><textarea rows={2} value={selected.summary} maxLength={500} placeholder="负责什么、交付什么、对什么结果负责。" onChange={(event) => updateSelected({ summary: event.target.value })} /></label>
            <label className="dialog-field"><span>Agent Persona</span><textarea rows={4} value={selected.persona} maxLength={2000} placeholder="定义工作原则、事实边界、协作方式和表达习惯。" onChange={(event) => updateSelected({ persona: event.target.value })} /></label>

            <fieldset className="creative-workshop-presets">
              <legend>空间与行为语义</legend>
              <p>预设来自宿主 Catalog，只提供可移植语义；主题再把语义映射为 Zone / Facility / Slot。</p>
              <div>{presets.map((preset) => <label key={preset.id} className={selected.embodimentPresetId === preset.id ? 'is-active' : ''}><input type="radio" name={`preset-${selected.clientId}`} checked={selected.embodimentPresetId === preset.id} onChange={() => updateSelected({ embodimentPresetId: preset.id })} /><strong>{preset.displayName}</strong><small>{preset.description}</small></label>)}</div>
            </fieldset>

            <fieldset className="creative-workshop-skills">
              <legend>请求 Skills</legend>
              <p>这里只声明 Blueprint 请求。世界创建后 Skill Grant 仍为空，必须在角色档案里显式批准。</p>
              {skills.length === 0 ? <div className="dialog-empty">当前宿主没有注册可供工坊选择的 Skill Adapter。</div> : <div>{skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={selected.requestedSkillIds.includes(skill.id)} onChange={(event) => updateSelected({ requestedSkillIds: event.target.checked ? [...selected.requestedSkillIds, skill.id] : selected.requestedSkillIds.filter((id) => id !== skill.id) })} /><span><strong>{skill.displayName}</strong><small>{skill.summary}</small><code>{skill.id}</code></span></label>)}</div>}
            </fieldset>
          </>}
        </main>
      </div>

      {error === undefined ? null : <div className="creative-workshop-error" role="alert">{error}</div>}
      <footer className="dialog-footer creative-workshop-editor-footer"><span>项目源写入本地 Workshop；生成角色包仍通过 PackageManager 校验和安装。</span><div><button className="text-button" type="button" onClick={onBack}>取消</button><button className="primary-button" type="button" disabled={saving} onClick={onSubmit}>{saving ? '正在构建世界…' : '创建世界'}</button></div></footer>
    </div>
  )
}
