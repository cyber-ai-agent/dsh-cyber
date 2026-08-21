import { Archive, GitBranch, IdentificationCard, ShieldWarning, Sparkle, X } from '@phosphor-icons/react'
import { useState } from 'react'
import type { EmployeeInstance, EmployeeProfile, EmployeeRevision, ModelProfile } from '@dsh-cyber/contracts'

import { Avatar } from './Avatar.js'

interface CharacterProfileUpdate {
  displayName: string
  avatarIndex: number
  background: string
  personalityTraits: string[]
  relationshipToUser: string
  addressUserAs: string
  selfReference: string
}

interface EmployeeManagementDialogProps {
  employee: EmployeeInstance
  profile?: EmployeeProfile
  currentRevision?: EmployeeRevision
  models: ModelProfile[]
  avatarIndex: number
  saving: boolean
  onClose(): void
  onRevise(input: { reason: string; persona?: string; skillGrants?: string[]; capabilityGrants?: string[]; modelPolicy: { modelProfileId?: string } }): Promise<void>
  onUpdateProfile(input: CharacterProfileUpdate): Promise<void>
  onArchive(): Promise<void>
}

export function EmployeeManagementDialog({ employee, profile, currentRevision, models, avatarIndex, saving, onClose, onRevise, onUpdateProfile, onArchive }: EmployeeManagementDialogProps) {
  const [displayName, setDisplayName] = useState(employee.displayName)
  const [selectedAvatar, setSelectedAvatar] = useState(avatarIndex)
  const [background, setBackground] = useState(profile?.background ?? employee.role)
  const [personality, setPersonality] = useState((profile?.personalityTraits ?? []).join('、'))
  const [relationshipToUser, setRelationshipToUser] = useState(textAppearance(profile, 'relationshipToUser'))
  const [addressUserAs, setAddressUserAs] = useState(textAppearance(profile, 'addressUserAs'))
  const [selfReference, setSelfReference] = useState(textAppearance(profile, 'selfReference'))
  const [reason, setReason] = useState('调整角色设定')
  const [persona, setPersona] = useState(currentRevision?.persona ?? '')
  const [skills, setSkills] = useState(currentRevision?.skillGrants.join(', ') ?? '')
  const [capabilities, setCapabilities] = useState(currentRevision?.capabilityGrants.join(', ') ?? '')
  const [confirmArchive, setConfirmArchive] = useState(false)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="employee-management-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-management-title">
        <header className="dialog-header">
          <div><h2 id="employee-management-title">角色设置 · {employee.displayName}</h2><p>{employee.role} · 独立角色 · 当前设定版本 r{employee.currentRevision}</p></div>
          <button className="icon-button" type="button" aria-label="关闭角色设置" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="employee-management-content">
          <section className="employee-identity-editor">
            <div className="settings-section__heading"><h3><IdentificationCard size={17} />身份与形象</h3><p>这里的名字与形象会同步到通讯录、聊天、档案和互动世界。</p></div>
            <div className="identity-editor-layout">
              <label className="dialog-field"><span>角色名字</span><input maxLength={48} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
              <div className="avatar-picker" role="radiogroup" aria-label="选择角色形象">
                {Array.from({ length: 8 }, (_, index) => (
                  <button key={index} type="button" role="radio" aria-checked={selectedAvatar === index} className={selectedAvatar === index ? 'is-active' : ''} onClick={() => setSelectedAvatar(index)}>
                    <Avatar index={index} size="md" label={`形象 ${index + 1}`} />
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

            <div className="identity-editor-footer"><span>角色档案版本 p{(profile?.revision ?? 0) + 1}</span><button className="secondary-button" type="button" disabled={!displayName.trim() || !background.trim() || saving} onClick={() => void onUpdateProfile({ displayName: displayName.trim(), avatarIndex: selectedAvatar, background: background.trim(), personalityTraits: splitList(personality), relationshipToUser: relationshipToUser.trim(), addressUserAs: addressUserAs.trim(), selfReference: selfReference.trim() })}>{saving ? '正在保存…' : '保存角色资料'}</button></div>
          </section>

          <section>
            <div className="settings-section__heading"><h3><Sparkle size={17} />性格与行为设定</h3><p>用自然语言描述角色应该如何思考、表达和行动。保存会生成新的不可变版本，历史对话不会被改写。</p></div>
            <label className="dialog-field"><span>角色设定</span><textarea rows={6} value={persona} onChange={(event) => setPersona(event.target.value)} placeholder="例如：你做事细致，先确认事实再给建议；遇到不确定的信息会明确说明。" /></label>
            <label className="dialog-field"><span>这次修改的说明</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：调整说话方式和职责边界"/></label>

            <details className="character-advanced-settings">
              <summary><GitBranch size={15}/>高级能力与权限</summary>
              <p>普通用户通常不需要修改这里。技能和权限仍受角色模板允许范围约束。</p>
              <div className="dialog-field-grid">
                <label className="dialog-field"><span>技能授权</span><input value={skills} onChange={(event) => setSkills(event.target.value)} /></label>
                <label className="dialog-field"><span>能力权限</span><input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /></label>
              </div>
            </details>

            <div className="character-model-note"><strong>运行模型</strong><span>当前角色模型请在“设置 → 模型 → 模型分配”中选择。活动路由统一按角色 → 世界 → 全局继承，避免出现两个互相冲突的模型设置。</span><small>可用模型：{models.length === 0 ? '尚未配置' : models.map((model)=>model.displayName).join('、')}</small></div>

            <button className="primary-button" type="button" disabled={!reason.trim() || !persona.trim() || saving} onClick={() => void onRevise({ reason: reason.trim(), persona: persona.trim(), skillGrants: splitList(skills), capabilityGrants: splitList(capabilities), modelPolicy: {} })}>{saving ? '正在保存…' : `保存为 r${employee.currentRevision + 1}`}</button>
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

function textAppearance(profile: EmployeeProfile | undefined, key: string): string {
  const value = profile?.appearance[key]
  return typeof value === 'string' ? value : ''
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean))]
}
