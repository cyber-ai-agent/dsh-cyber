import { Archive, IdentificationCard, ShieldWarning, Sparkle, X } from '@phosphor-icons/react'
import { useState } from 'react'
import type { EmployeeInstance, EmployeeProfile, EmployeeRevision, ModelProfile, WorldCharacterAuthority } from '@dsh-cyber/contracts'

import { Avatar } from './Avatar.js'
import { SkillGrantEditor } from './SkillGrantEditor.js'
import { WorldPermissionEditor, type WorldPermissionEditorValue } from './WorldPermissionEditor.js'

interface EmployeeManagementDialogProps {
  employee: EmployeeInstance
  profile?: EmployeeProfile
  currentRevision?: EmployeeRevision
  models: ModelProfile[]
  avatarIndex: number
  saving: boolean
  authority?: WorldCharacterAuthority | undefined
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

export function EmployeeManagementDialog({ employee, profile, currentRevision, models, avatarIndex, saving, authority, onClose, onRevise, onAuthorityChange = async () => undefined, onUpdateProfile, onArchive }: EmployeeManagementDialogProps) {
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
          <div><h2 id="employee-management-title">角色设置 · {employee.displayName}</h2><p>{employee.role} · 独立角色 · 当前设定版本 r{employee.currentRevision}</p></div>
          <button className="icon-button" type="button" aria-label="关闭角色设置" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="employee-management-content">
          <section className="employee-identity-editor">
            <div className="settings-section__heading"><h3><IdentificationCard size={17} />身份、关系与形象</h3><p>当前身份由角色实例自己持有。初始 Blueprint 只提供创建默认值；名字、身份/形态、关系和背景保存后都会成为当前角色事实。</p></div>
            <div className="identity-editor-layout">
              <label className="dialog-field"><span>角色名字</span><input maxLength={48} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
              <label className="dialog-field"><span>当前身份 / 形态</span><input maxLength={100} value={role} onChange={(event) => setRole(event.target.value)} placeholder="陪伴小猫 / 开发工程师 / 酒馆老板 / 机器人" /><small>这是当前角色标签，可以完全脱离最初模板岗位。</small></label>
              <div className="avatar-picker" role="radiogroup" aria-label="选择角色形象">
                {Array.from({ length: 8 }, (_, index) => (
                  <button key={index} type="button" role="radio" aria-checked={selectedAvatar === index} className={selectedAvatar === index ? 'is-active' : ''} onClick={() => setSelectedAvatar(index)}>
                    <Avatar index={index} size="md" label={`形象 ${index + 1}`} authorityRole={authority?.role} />
                  </button>
                ))}
              </div>
            </div>

            <div className="character-profile-grid">
              <label className="dialog-field"><span>与我的关系</span><input value={relationshipToUser} onChange={(event)=>setRelationshipToUser(event.target.value)} placeholder="管家 / 伙伴 / 宠物 / 顾问 / 同事"/></label>
              <label className="dialog-field"><span>如何称呼我</span><input value={addressUserAs} onChange={(event)=>setAddressUserAs(event.target.value)} placeholder="留空则跟随世界默认称呼"/></label>
              <label className="dialog-field"><span>角色如何自称</span><input value={selfReference} onChange={(event)=>setSelfReference(event.target.value)} placeholder="我 / 本喵 / 老夫……"/></label>
              <label className="dialog-field"><span>性格关键词</span><input value={personality} onChange={(event)=>setPersonality(event.target.value)} placeholder="冷静、细致、幽默"/></label>
              <label className="dialog-field character-profile-grid__wide"><span>背景故事</span><textarea rows={4} value={background} onChange={(event)=>setBackground(event.target.value)} placeholder="这个角色在当前世界里的经历、身份和重要背景。"/></label>
            </div>

            <div className="identity-editor-footer"><span>保存后会同步当前实例身份，并生成新的角色设定版本</span><button className="secondary-button" type="button" disabled={!displayName.trim() || !role.trim() || !background.trim() || saving} onClick={() => void saveIdentityAndRelationship()}>{saving ? '正在保存…' : '保存角色资料'}</button></div>
          </section>

          <section>
            <div className="settings-section__heading"><h3><Sparkle size={17} />性格与行为设定</h3><p>用自然语言描述角色应该如何思考、表达和行动。保存会生成新的不可变版本，历史对话不会被改写。</p></div>
            <label className="dialog-field"><span>角色设定</span><textarea rows={6} value={persona} onChange={(event) => setPersona(event.target.value)} placeholder="例如：你做事细致，先确认事实再给建议；遇到不确定的信息会明确说明。" /></label>
            <label className="dialog-field"><span>这次修改的说明</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：调整说话方式和职责边界"/></label>
          </section>

          <section>
            <div className="settings-section__heading"><h3>Skills</h3><p>每次保存都会生成新的角色 revision。计划任务执行前也会重新检查这里的当前授权。</p></div>
            <SkillGrantEditor employee={employee} value={skills} onChange={setSkills} />
          </section>

          <WorldPermissionEditor authority={authority} saving={saving} onSave={onAuthorityChange} />

          <details className="character-advanced-settings">
            <summary>高级兼容设置</summary>
            <p>底层 Runtime Capability 仅用于兼容旧包。世界管理权限请使用上方“世界权限”，普通用户通常无需修改这里。</p>
            <div className="dialog-field-grid">
              <label className="dialog-field"><span>底层 Capability 权限</span><input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /><small>这里不会授予世界管理员身份，也不会自动开启 danger-full-access。</small></label>
            </div>
          </details>

          <section>
            <div className="character-model-note"><strong>运行模型</strong><span>当前角色模型请在“设置 → 模型 → 模型分配”中选择。活动路由统一按角色 → 世界 → 全局继承，避免出现两个互相冲突的模型设置。</span><small>可用模型：{models.length === 0 ? '尚未配置' : models.map((model)=>model.displayName).join('、')}</small></div>

            <button className="primary-button" type="button" disabled={!reason.trim() || !role.trim() || !persona.trim() || saving} onClick={() => void saveBehavior()}>{saving ? '正在保存…' : `保存为 r${employee.currentRevision + 1}`}</button>
          </section>

          <section className="archive-section">
            <div><Archive size={18} /><div><strong>归档角色</strong><p>角色将从当前世界和 @ 列表移除，但会话、交付物、成长记录和审计历史不会删除。</p></div></div>
            {confirmArchive ? <div className="archive-confirm"><ShieldWarning size={17} /><span>确认归档 {employee.displayName}？</span><button type="button" disabled={saving} onClick={() => void onArchive()}>确认归档</button><button type="button" onClick={() => setConfirmArchive(false)}>取消</button></div> : <button className="danger-button" type="button" onClick={() => setConfirmArchive(true)}>归档角色</button>}
          </section>
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
