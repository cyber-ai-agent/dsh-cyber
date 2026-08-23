import { Plus, Sparkle, Trash, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import type {
  CharacterSkillDescriptor,
  EmbodimentProfile,
  WorkshopCreateInput,
  WorkshopProject,
} from '@dsh-cyber/contracts/creative-platform'

import { api } from '../api.js'
import './CreativeWorkshopDialog.css'

interface CreativeWorkshopDialogProps {
  workspaceId: string
  onClose(): void
  onCreated(project: WorkshopProject): void
}

interface RoleDraft {
  id: string
  displayName: string
  role: string
  summary: string
  persona: string
  semanticPreset: SemanticPresetId
  requestedSkillIds: string[]
}

type SemanticPresetId = 'general' | 'engineering' | 'research' | 'operations' | 'administration' | 'creative'

const PRESETS: Record<SemanticPresetId, { label: string; description: string; profile: EmbodimentProfile }> = {
  general: {
    label: '通用角色',
    description: '适合顾问、自由角色和暂未确定固定工作区的角色。',
    profile: profile(['general'], ['public'], ['collaboration'], ['public', 'meeting', 'rest'], ['public'], ['observe-world']),
  },
  engineering: {
    label: '工程 / 开发',
    description: '优先工程工位、白板和测试设施。',
    profile: profile(['engineering', 'coding'], ['engineering'], ['coding', 'testing'], ['engineering', 'meeting', 'rest', 'public'], ['engineering', 'work'], ['inspect-workbench']),
  },
  research: {
    label: '研究 / 知识',
    description: '优先研究、资料、档案与分析设施。',
    profile: profile(['research', 'knowledge'], ['research'], ['research', 'inspect'], ['research', 'meeting', 'rest', 'public'], ['research', 'work'], ['inspect-research-material']),
  },
  operations: {
    label: '运营 / 数据',
    description: '优先监控、运营看板和控制设施。',
    profile: profile(['operations', 'analytics'], ['operations'], ['monitoring', 'analysis'], ['operations', 'meeting', 'rest', 'public'], ['operations', 'work'], ['inspect-dashboard']),
  },
  administration: {
    label: '行政 / 协调',
    description: '优先行政桌、档案和会议准备区域。',
    profile: profile(['administration', 'coordination'], ['administration'], ['schedule', 'coordination'], ['administration', 'meeting', 'rest', 'public'], ['administration', 'work'], ['prepare-meeting']),
  },
  creative: {
    label: '创作 / 内容',
    description: '适合编剧、编辑、设计、视频与内容制作角色。',
    profile: profile(['creative', 'content'], ['creative'], ['create', 'review'], ['creative', 'meeting', 'rest', 'public'], ['creative', 'work'], ['review-creative-board']),
  },
}

export function CreativeWorkshopDialog({ workspaceId, onClose, onCreated }: CreativeWorkshopDialogProps) {
  const [templates, setTemplates] = useState<WorldTemplateManifest[]>([])
  const [skills, setSkills] = useState<CharacterSkillDescriptor[]>([])
  const [displayName, setDisplayName] = useState('')
  const [baseTemplateId, setBaseTemplateId] = useState('personal-world')
  const [lore, setLore] = useState('')
  const [scenario, setScenario] = useState('')
  const [roles, setRoles] = useState<RoleDraft[]>(() => [newRole(1)])
  const [selectedRoleId, setSelectedRoleId] = useState(roles[0]!.id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api<{ items: WorldTemplateManifest[] }>('/api/catalog/world-templates'),
      api<{ items: CharacterSkillDescriptor[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill-catalog`),
    ]).then(([templateResult, skillResult]) => {
      if (cancelled) return
      setTemplates(templateResult.items)
      setSkills(skillResult.items)
      if (!templateResult.items.some((item) => item.id === baseTemplateId) && templateResult.items[0] !== undefined) {
        setBaseTemplateId(templateResult.items[0].id)
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '创意工坊目录加载失败')
    })
    return () => { cancelled = true }
  }, [workspaceId])

  const selected = useMemo(() => roles.find((item) => item.id === selectedRoleId) ?? roles[0], [roles, selectedRoleId])
  const updateSelected = (patch: Partial<RoleDraft>) => {
    if (selected === undefined) return
    setRoles((current) => current.map((item) => item.id === selected.id ? { ...item, ...patch } : item))
  }

  const addRole = () => {
    if (roles.length >= 16) return
    const role = newRole(roles.length + 1)
    setRoles((current) => [...current, role])
    setSelectedRoleId(role.id)
  }

  const removeRole = (roleId: string) => {
    if (roles.length <= 1) return
    const next = roles.filter((item) => item.id !== roleId)
    setRoles(next)
    if (selectedRoleId === roleId) setSelectedRoleId(next[0]!.id)
  }

  const create = async () => {
    if (!displayName.trim()) { setError('请填写世界名称'); return }
    const incomplete = roles.find((role) => !role.displayName.trim() || !role.role.trim() || !role.summary.trim() || !role.persona.trim())
    if (incomplete !== undefined) { setError(`请补全角色“${incomplete.displayName || incomplete.role || '未命名角色'}”的资料`); return }
    setSaving(true)
    setError(undefined)
    try {
      const input: WorkshopCreateInput = {
        displayName: displayName.trim(),
        baseTemplateId,
        lore: lore.trim(),
        scenario: scenario.trim(),
        roles: roles.map((role, index) => ({
          id: `role-${index + 1}`,
          displayName: role.displayName.trim(),
          role: role.role.trim(),
          summary: role.summary.trim(),
          persona: role.persona.trim(),
          embodiment: structuredClone(PRESETS[role.semanticPreset].profile),
          requestedSkillIds: role.requestedSkillIds,
        })),
      }
      const result = await api<{ project: WorkshopProject }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/workshop/projects`, {
        method: 'POST',
        body: JSON.stringify(input),
      })
      onCreated(result.project)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="creative-workshop-dialog" role="dialog" aria-modal="true" aria-labelledby="creative-workshop-title">
        <header className="dialog-header">
          <div>
            <h2 id="creative-workshop-title">创意工坊</h2>
            <p>创建可持续保存的本地世界与角色。世界、角色身体、Agent 身份和 Skill 请求分别建模，再由运行时组合。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭创意工坊" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="creative-workshop-layout">
          <aside className="creative-workshop-sidebar">
            <section className="creative-workshop-world-card">
              <div className="creative-workshop-section-title"><Sparkle size={17} /><strong>世界项目</strong></div>
              <label className="dialog-field"><span>世界名称</span><input value={displayName} maxLength={80} placeholder="例如：短剧增长工作室" onChange={(event) => setDisplayName(event.target.value)} /></label>
              <label className="dialog-field"><span>基础运行时模板</span><select value={baseTemplateId} onChange={(event) => setBaseTemplateId(event.target.value)}>{templates.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><small>模板只提供场景能力，角色岗位由下方语义契约决定。</small></label>
              <label className="dialog-field"><span>世界观 / 背景</span><textarea rows={3} value={lore} placeholder="这个世界长期遵循的背景、规则和文化。" onChange={(event) => setLore(event.target.value)} /></label>
              <label className="dialog-field"><span>当前场景</span><textarea rows={2} value={scenario} placeholder="当前阶段的业务、故事或经营目标。" onChange={(event) => setScenario(event.target.value)} /></label>
            </section>

            <div className="creative-workshop-role-heading"><strong>初始角色</strong><button type="button" onClick={addRole} disabled={roles.length >= 16}><Plus size={15} />添加</button></div>
            <div className="creative-workshop-role-list">
              {roles.map((role, index) => (
                <button key={role.id} type="button" className={role.id === selected?.id ? 'is-active' : ''} onClick={() => setSelectedRoleId(role.id)}>
                  <span>{index + 1}</span><div><strong>{role.displayName || `角色 ${index + 1}`}</strong><small>{role.role || PRESETS[role.semanticPreset].label}</small></div>
                </button>
              ))}
            </div>
          </aside>

          <main className="creative-workshop-role-editor">
            {selected === undefined ? null : <>
              <div className="creative-workshop-role-toolbar">
                <div><h3>{selected.displayName || '配置角色'}</h3><p>角色名称只负责展示；空间行为、Agent Persona 与 Skill 请求互不推断。</p></div>
                <button type="button" className="text-button" disabled={roles.length <= 1} onClick={() => removeRole(selected.id)}><Trash size={15} />删除角色</button>
              </div>

              <div className="creative-workshop-grid">
                <label className="dialog-field"><span>角色名字</span><input value={selected.displayName} maxLength={50} placeholder="阿策" onChange={(event) => updateSelected({ displayName: event.target.value })} /></label>
                <label className="dialog-field"><span>岗位 / 身份</span><input value={selected.role} maxLength={100} placeholder="短剧投流专家" onChange={(event) => updateSelected({ role: event.target.value })} /></label>
              </div>
              <label className="dialog-field"><span>角色简介</span><textarea rows={2} value={selected.summary} maxLength={500} placeholder="负责什么、交付什么、对什么结果负责。" onChange={(event) => updateSelected({ summary: event.target.value })} /></label>
              <label className="dialog-field"><span>Agent Persona</span><textarea rows={4} value={selected.persona} maxLength={2000} placeholder="定义工作原则、事实边界、协作方式和表达习惯。" onChange={(event) => updateSelected({ persona: event.target.value })} /></label>

              <fieldset className="creative-workshop-presets">
                <legend>空间与行为语义</legend>
                <p>这是角色身体在任何兼容世界里的语义，不包含坐标、动画帧或职位名判断。</p>
                <div>{(Object.entries(PRESETS) as Array<[SemanticPresetId, (typeof PRESETS)[SemanticPresetId]]>).map(([id, preset]) => <label key={id} className={selected.semanticPreset === id ? 'is-active' : ''}><input type="radio" name={`preset-${selected.id}`} checked={selected.semanticPreset === id} onChange={() => updateSelected({ semanticPreset: id })} /><strong>{preset.label}</strong><small>{preset.description}</small></label>)}</div>
              </fieldset>

              <fieldset className="creative-workshop-skills">
                <legend>请求 Skills</legend>
                <p>这里仅写入 Blueprint 的请求。创建角色不会自动授权；角色需要真实使用时，再由用户逐项批准。</p>
                {skills.length === 0 ? <div className="dialog-empty">当前宿主还没有注册可供工坊选择的 Skill Adapter。</div> : <div>{skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={selected.requestedSkillIds.includes(skill.id)} onChange={(event) => updateSelected({ requestedSkillIds: event.target.checked ? [...selected.requestedSkillIds, skill.id] : selected.requestedSkillIds.filter((id) => id !== skill.id) })} /><span><strong>{skill.displayName}</strong><small>{skill.summary}</small><code>{skill.id}</code></span></label>)}</div>}
              </fieldset>
            </>}
          </main>
        </div>

        {error === undefined ? null : <div className="creative-workshop-error" role="alert">{error}</div>}
        <footer className="dialog-footer"><span>生成内容保存在本地 Workshop，角色包仍经过 PackageManager 校验与安装。</span><div><button className="text-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={saving} onClick={() => void create()}>{saving ? '正在构建世界…' : '创建世界'}</button></div></footer>
      </section>
    </div>
  )
}

function newRole(index: number): RoleDraft {
  return {
    id: `draft-${Date.now()}-${index}`,
    displayName: '',
    role: '',
    summary: '',
    persona: '',
    semanticPreset: 'general',
    requestedSkillIds: [],
  }
}

function profile(
  roleTags: string[],
  preferredZoneTags: string[],
  preferredFacilityCapabilities: string[],
  allowedZoneTags: string[],
  homeSlotTags: string[],
  ambientBehaviors: string[],
): EmbodimentProfile {
  return {
    roleTags,
    preferredZoneTags,
    preferredFacilityCapabilities,
    allowedZoneTags,
    homeSlotTags,
    ambientBehaviors,
    socialPolicy: {
      canInitiateConversation: false,
      cooldownSeconds: 1_800,
      maxDailyConversations: 0,
    },
  }
}
