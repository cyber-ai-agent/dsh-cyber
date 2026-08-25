import { Archive, IdentificationCard, PuzzlePiece, ShieldCheck, ShieldWarning, SlidersHorizontal, Sparkle, X } from '@phosphor-icons/react'
import { useState } from 'react'
import type { EmployeeInstance, EmployeeProfile, EmployeeRevision, ModelProfile, WorldCharacterAuthority } from '@dsh-cyber/contracts'

import { Avatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { SkillGrantEditor } from './SkillGrantEditor.js'
import { WorldPermissionEditor, type WorldPermissionEditorValue } from './WorldPermissionEditor.js'

export type EmployeeSettingsSection = 'profile' | 'behavior' | 'abilities' | 'permissions' | 'advanced'

interface EmployeeManagementDialogProps {
  employee: EmployeeInstance
  profile?: EmployeeProfile
  currentRevision?: EmployeeRevision
  models: ModelProfile[]
  avatarIndex: number
  saving: boolean
  authority?: WorldCharacterAuthority | undefined
  initialSection?: EmployeeSettingsSection
  onClose(): void
  onRevise(input: { reason: string; persona?: string; skillGrants?: string[]; capabilityGrants?: string[]; modelPolicy: { modelProfileId?: string } }): Promise<void>
  onAuthorityChange?(input: WorldPermissionEditorValue): Promise<void>
  onUpdateProfile(input: {
    displayName: string
    role: string
    avatarIndex: number
    background: string
    personalityTraits: string[]
    relationshipToUser: string
    addressUserAs: string
    selfReference: string
  }): Promise<void>
  onArchive(): Promise<void>
}

interface CharacterRuntimeProfile {
  identityLabel: string
  relationshipToUser: string
  addressUserAs: string
  selfReference: string
  personalityTraits: string[]
  background: string
  persona: string
}

const PROFILE_START = '[角色关系与背景]'
const PROFILE_END = '[/角色关系与背景]'

export function EmployeeManagementDialog({ employee, profile, currentRevision, models, avatarIndex, saving, authority, initialSection = 'profile', onClose, onRevise, onAuthorityChange = async () => undefined, onUpdateProfile, onArchive }: EmployeeManagementDialogProps) {
  const parsed = parseCharacterRuntimeProfile(currentRevision?.persona ?? '', profile, employee.role)
  const [displayName, setDisplayName] = useState(employee.displayName)
  const [role, setRole] = useState(parsed.identityLabel)
  const [selectedAvatar, setSelectedAvatar] = useState(avatarIndex)
  const [background, setBackground] = useState(parsed.background)
  const [personality, setPersonality] = useState(parsed.personalityTraits.join('、'))
  const [relationshipToUser, setRelationshipToUser] = useState(parsed.relationshipToUser)
  const [addressUserAs, setAddressUserAs] = useState(parsed.addressUserAs)
  const [selfReference, setSelfReference] = useState(parsed.selfReference)
  const [reason, setReason] = useState('调整角色设定')
  const [persona, setPersona] = useState(parsed.persona)
  const [skills, setSkills] = useState<string[]>(currentRevision?.skillGrants ?? [])
  const [capabilities, setCapabilities] = useState(currentRevision?.capabilityGrants.join(', ') ?? '')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [activeSection, setActiveSection] = useState<EmployeeSettingsSection>(initialSection)

  const runtimeProfile = (): CharacterRuntimeProfile => ({
    identityLabel: role.trim(),
    relationshipToUser: relationshipToUser.trim(),
    addressUserAs: addressUserAs.trim(),
    selfReference: selfReference.trim(),
    personalityTraits: splitList(personality),
    background: background.trim(),
    persona: persona.trim(),
  })

  const saveIdentityAndRelationship = async () => {
    if (!displayName.trim() || !role.trim() || !background.trim() || saving) return
    const profile = runtimeProfile()
    await onUpdateProfile({
      displayName: displayName.trim(),
      role: profile.identityLabel,
      avatarIndex: selectedAvatar,
      background: profile.background,
      personalityTraits: profile.personalityTraits,
      relationshipToUser: profile.relationshipToUser,
      addressUserAs: profile.addressUserAs,
      selfReference: profile.selfReference,
    })
    await onRevise({
      reason: '更新角色身份、关系与背景',
      persona: composeCharacterPersona(runtimeProfile()),
      skillGrants: skills,
      capabilityGrants: splitList(capabilities),
      modelPolicy: {},
    })
  }

  const saveBehavior = async () => {
    if (!reason.trim() || !role.trim() || !persona.trim() || saving) return
    await onRevise({
      reason: reason.trim(),
      persona: composeCharacterPersona(runtimeProfile()),
      skillGrants: skills,
      capabilityGrants: splitList(capabilities),
      modelPolicy: {},
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="employee-management-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-management-title">
        <header className="dialog-header">
          <div><h2 id="employee-management-title">角色设置 · {employee.displayName}<AuthorityBadge role={authority?.role} size="md" /></h2><p>{employee.role} · 独立角色</p></div>
          <button className="icon-button" type="button" aria-label="关闭角色设置" onClick={onClose}><X size={18} /></button>
        </header>

        <nav className="employee-settings-nav" role="tablist" aria-label="角色设置栏目">
          <button type="button" role="tab" aria-selected={activeSection === 'profile'} className={activeSection === 'profile' ? 'is-active' : ''} onClick={() => setActiveSection('profile')}><IdentificationCard size={16} /><span>身份资料</span></button>
          <button type="button" role="tab" aria-selected={activeSection === 'behavior'} className={activeSection === 'behavior' ? 'is-active' : ''} onClick={() => setActiveSection('behavior')}><Sparkle size={16} /><span>行为方式</span></button>
          <button type="button" role="tab" aria-selected={activeSection === 'abilities'} className={activeSection === 'abilities' ? 'is-active' : ''} onClick={() => setActiveSection('abilities')}><PuzzlePiece size={16} /><span>可用能力</span></button>
          <button type="button" role="tab" aria-selected={activeSection === 'permissions'} className={activeSection === 'permissions' ? 'is-active' : ''} onClick={() => setActiveSection('permissions')}><ShieldCheck size={16} /><span>世界权限</span></button>
          <button type="button" role="tab" aria-selected={activeSection === 'advanced'} className={activeSection === 'advanced' ? 'is-active' : ''} onClick={() => setActiveSection('advanced')}><SlidersHorizontal size={16} /><span>高级设置</span></button>
        </nav>

        <div className="employee-management-content">
          {activeSection === 'profile' ? <section className="employee-settings-panel" role="tabpanel">
            <div className="settings-section__heading"><h3><IdentificationCard size={18} />身份、关系与形象</h3><p>这里保存角色在当前世界中的名字、身份、关系和背景，不受最初模板名称限制。</p></div>
            <div className="identity-editor-layout">
              <label className="dialog-field"><span>角色名字</span><input maxLength={48} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
              <label className="dialog-field"><span>当前身份或形态</span><input maxLength={100} value={role} onChange={(event) => setRole(event.target.value)} placeholder="例如：开发工程师、酒馆老板、陪伴机器人" /><small>用于角色资料、会话标题和世界中的身份说明。</small></label>
            </div>
            <div><span className="field-label">角色形象</span><div className="avatar-picker" role="radiogroup" aria-label="选择角色形象">{Array.from({ length: 8 }, (_, index) => <button key={index} type="button" role="radio" aria-label={`形象 ${index + 1}`} aria-checked={selectedAvatar === index} className={selectedAvatar === index ? 'is-active' : ''} onClick={() => setSelectedAvatar(index)}><Avatar index={index} size="md" label={`形象 ${index + 1}`} /></button>)}</div></div>
            <div className="character-profile-grid">
              <label className="dialog-field"><span>与我的关系</span><input value={relationshipToUser} onChange={(event)=>setRelationshipToUser(event.target.value)} placeholder="管家、伙伴、顾问或同事"/></label>
              <label className="dialog-field"><span>如何称呼我</span><input value={addressUserAs} onChange={(event)=>setAddressUserAs(event.target.value)} placeholder="留空则跟随世界默认称呼"/></label>
              <label className="dialog-field"><span>角色如何自称</span><input value={selfReference} onChange={(event)=>setSelfReference(event.target.value)} placeholder="我、本喵、老夫……"/></label>
              <label className="dialog-field"><span>性格关键词</span><input value={personality} onChange={(event)=>setPersonality(event.target.value)} placeholder="冷静、细致、幽默"/></label>
              <label className="dialog-field character-profile-grid__wide"><span>背景故事</span><textarea rows={5} value={background} onChange={(event)=>setBackground(event.target.value)} placeholder="这个角色在当前世界里的经历、身份和重要背景。"/></label>
            </div>
            <footer className="employee-settings-actions"><span>保存后将用于角色资料和后续对话。</span><button className="primary-button" type="button" disabled={!displayName.trim() || !role.trim() || !background.trim() || saving} onClick={() => void saveIdentityAndRelationship()}>{saving ? '正在保存…' : '保存角色资料'}</button></footer>
          </section> : null}

          {activeSection === 'behavior' ? <section className="employee-settings-panel" role="tabpanel">
            <div className="settings-section__heading"><h3><Sparkle size={18} />性格与行为方式</h3><p>用自然语言说明角色如何思考、表达和行动。保存后只影响后续对话，已有历史不会改变。</p></div>
            <label className="dialog-field"><span>角色设定</span><textarea rows={10} value={persona} onChange={(event) => setPersona(event.target.value)} placeholder="例如：你做事细致，先确认事实再给建议；遇到不确定的信息会明确说明。" /></label>
            <label className="dialog-field"><span>修改说明</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：调整说话方式和职责边界"/></label>
            <footer className="employee-settings-actions"><span>保存后用于接下来的新对话。</span><button className="primary-button" type="button" disabled={!reason.trim() || !role.trim() || !persona.trim() || saving} onClick={() => void saveBehavior()}>{saving ? '正在保存…' : '保存行为设定'}</button></footer>
          </section> : null}

          {activeSection === 'abilities' ? <section className="employee-settings-panel" role="tabpanel">
            <div className="settings-section__heading"><h3><PuzzlePiece size={18} />可用能力</h3><p>选择这个角色可以使用的能力。执行计划和外部操作前，系统仍会重新检查当前授权。</p></div>
            <SkillGrantEditor employee={employee} value={skills} onChange={setSkills} />
            <footer className="employee-settings-actions"><span>高风险操作仍会单独请求确认。</span><button className="primary-button" type="button" disabled={!role.trim() || !persona.trim() || saving} onClick={() => void saveBehavior()}>{saving ? '正在保存…' : '保存能力设置'}</button></footer>
          </section> : null}

          {activeSection === 'permissions' ? <section className="employee-settings-panel" role="tabpanel"><WorldPermissionEditor authority={authority} saving={saving} onSave={onAuthorityChange} /></section> : null}

          {activeSection === 'advanced' ? <section className="employee-settings-panel" role="tabpanel">
            <div className="settings-section__heading"><h3><SlidersHorizontal size={18} />高级设置</h3><p>这些设置主要用于旧扩展兼容。普通使用无需修改。</p></div>
            <div className="character-model-note"><strong>运行模型</strong><span>当前角色使用的模型请前往“设置 → 模型 → 模型分配”选择。这里不重复提供模型配置，避免设置冲突。</span><small>当前可选模型：{models.length === 0 ? '尚未配置' : models.map((model)=>model.displayName).join('、')}</small></div>
            <label className="dialog-field"><span>兼容权限标识</span><input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /><small>仅用于兼容旧扩展，不会授予世界管理员身份，也不会开启完整系统访问。</small></label>
            <footer className="employee-settings-actions"><span>不确定时请保持原值。</span><button className="primary-button" type="button" disabled={!role.trim() || !persona.trim() || saving} onClick={() => void saveBehavior()}>{saving ? '正在保存…' : '保存高级设置'}</button></footer>
            <div className="archive-section">
              <div><Archive size={18} /><div><strong>归档角色</strong><p>角色将从当前世界和提及列表移除，但会话、交付物、成长记录和审计历史不会删除。</p></div></div>
              {confirmArchive ? <div className="archive-confirm"><ShieldWarning size={17} /><span>确认归档 {employee.displayName}？</span><button type="button" disabled={saving} onClick={() => void onArchive()}>确认归档</button><button type="button" onClick={() => setConfirmArchive(false)}>取消</button></div> : <button className="danger-button" type="button" onClick={() => setConfirmArchive(true)}>归档角色</button>}
            </div>
          </section> : null}
        </div>
      </section>
    </div>
  )
}

function composeCharacterPersona(value: CharacterRuntimeProfile): string {
  const metadata = [
    PROFILE_START,
    `当前身份/形态：${value.identityLabel}`,
    `与用户的关系：${value.relationshipToUser || '未单独设定'}`,
    `称呼用户：${value.addressUserAs || '跟随当前世界默认称呼'}`,
    `自称：${value.selfReference || '我'}`,
    `性格关键词：${value.personalityTraits.join('、') || '未单独设定'}`,
    `背景故事：${value.background}`,
    PROFILE_END,
  ].join('\n')
  return `${metadata}\n\n${value.persona}`.trim()
}

function parseCharacterRuntimeProfile(persona: string, profile: EmployeeProfile | undefined, role: string): CharacterRuntimeProfile {
  const start = persona.indexOf(PROFILE_START)
  const end = persona.indexOf(PROFILE_END)
  const block = start >= 0 && end > start ? persona.slice(start + PROFILE_START.length, end) : ''
  const corePersona = start >= 0 && end > start ? `${persona.slice(0, start)}${persona.slice(end + PROFILE_END.length)}`.trim() : persona.trim()
  const values = new Map<string, string>()
  for (const line of block.split('\n')) {
    const separator = line.indexOf('：')
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const traits = values.get('性格关键词')
  return {
    identityLabel: cleanUnset(values.get('当前身份/形态')) || role,
    relationshipToUser: cleanUnset(values.get('与用户的关系')),
    addressUserAs: cleanUnset(values.get('称呼用户')),
    selfReference: cleanUnset(values.get('自称')),
    personalityTraits: traits && !traits.startsWith('未单独') ? splitList(traits) : (profile?.personalityTraits ?? []),
    background: cleanUnset(values.get('背景故事')) || profile?.background || role,
    persona: corePersona || '保持自己的当前角色身份、知识边界和权限，不冒充其他角色。',
  }
}

function cleanUnset(value: string | undefined): string {
  if (value === undefined || value.startsWith('未单独') || value.startsWith('跟随当前世界')) return ''
  return value
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean))]
}
