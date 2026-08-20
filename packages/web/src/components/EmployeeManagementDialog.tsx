import { Archive, Cpu, GitBranch, IdentificationCard, ShieldWarning, X } from '@phosphor-icons/react'
import { useState } from 'react'
import type { EmployeeInstance, EmployeeProfile, EmployeeRevision, ModelProfile } from '@dsh-cyber/contracts'

import { Avatar } from './Avatar.js'

interface EmployeeManagementDialogProps {
  employee: EmployeeInstance
  profile?: EmployeeProfile
  currentRevision?: EmployeeRevision
  models: ModelProfile[]
  avatarIndex: number
  saving: boolean
  onClose(): void
  onRevise(input: { reason: string; persona?: string; skillGrants?: string[]; capabilityGrants?: string[]; modelPolicy: { modelProfileId?: string } }): Promise<void>
  onUpdateProfile(input: { displayName: string; avatarIndex: number }): Promise<void>
  onArchive(): Promise<void>
}

export function EmployeeManagementDialog({ employee, profile, currentRevision, models, avatarIndex, saving, onClose, onRevise, onUpdateProfile, onArchive }: EmployeeManagementDialogProps) {
  const [displayName, setDisplayName] = useState(employee.displayName)
  const [selectedAvatar, setSelectedAvatar] = useState(avatarIndex)
  const [reason, setReason] = useState('更新岗位配置')
  const [persona, setPersona] = useState('')
  const [skills, setSkills] = useState(currentRevision?.skillGrants.join(', ') ?? '')
  const [capabilities, setCapabilities] = useState(currentRevision?.capabilityGrants.join(', ') ?? '')
  const configuredModelId = currentRevision?.modelPolicy.modelProfileId
  const [modelProfileId, setModelProfileId] = useState(typeof configuredModelId === 'string' ? configuredModelId : '')
  const [confirmArchive, setConfirmArchive] = useState(false)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="employee-management-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-management-title">
        <header className="dialog-header">
          <div><h2 id="employee-management-title">管理 {employee.displayName}</h2><p>{employee.role} · 当前版本 r{employee.currentRevision}</p></div>
          <button className="icon-button" type="button" aria-label="关闭员工管理" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="employee-management-content">
          <section className="employee-identity-editor">
            <div className="settings-section__heading"><h3><IdentificationCard size={17} />员工名片与形象</h3><p>姓名和头像会同步到通讯录、@ 列表、档案和世界；保存后写入本地员工档案。</p></div>
            <div className="identity-editor-layout">
              <label className="dialog-field"><span>显示名称</span><input maxLength={48} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
              <div className="avatar-picker" role="radiogroup" aria-label="选择员工头像">
                {Array.from({ length: 8 }, (_, index) => (
                  <button key={index} type="button" role="radio" aria-checked={selectedAvatar === index} className={selectedAvatar === index ? 'is-active' : ''} onClick={() => setSelectedAvatar(index)}>
                    <Avatar index={index} size="md" label={`头像 ${index + 1}`} />
                  </button>
                ))}
              </div>
            </div>
            <div className="identity-editor-footer"><span>档案形象版本 p{(profile?.revision ?? 0) + 1}</span><button className="secondary-button" type="button" disabled={!displayName.trim() || saving} onClick={() => void onUpdateProfile({ displayName: displayName.trim(), avatarIndex: selectedAvatar })}>{saving ? '正在保存…' : '保存名片'}</button></div>
          </section>
          <section>
            <div className="settings-section__heading"><h3><GitBranch size={17} />创建角色新版本</h3><p>修改会生成不可变的新修订；旧版本与会话记录继续保留。</p></div>
            <label className="dialog-field"><span>变更原因</span><input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            <label className="dialog-field"><span>Persona 覆盖（留空则沿用当前版本）</span><textarea rows={5} value={persona} onChange={(event) => setPersona(event.target.value)} /></label>
            <div className="dialog-field-grid">
              <label className="dialog-field"><span>Skill Grants（逗号分隔）</span><input value={skills} onChange={(event) => setSkills(event.target.value)} /></label>
              <label className="dialog-field"><span>Capability Grants（逗号分隔）</span><input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /></label>
            </div>
            <label className="dialog-field employee-model-field">
              <span><Cpu size={15} />运行模型</span>
              <select value={modelProfileId} onChange={(event) => setModelProfileId(event.target.value)}>
                <option value="">跟随工作区默认模型</option>
                {models.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.modelId}</option>)}
              </select>
              <small>
                {modelProfileId
                  ? '此员工的新版本将固定使用所选模型配置；密钥仍只从本机环境变量读取。'
                  : `当前跟随默认模型：${models.find((model) => model.isDefault)?.displayName ?? 'DSH 默认路由'}`}
              </small>
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={!reason.trim() || saving}
              onClick={() => void onRevise({
                reason: reason.trim(),
                ...(persona.trim() ? { persona: persona.trim() } : {}),
                skillGrants: splitList(skills),
                capabilityGrants: splitList(capabilities),
                modelPolicy: modelProfileId ? { modelProfileId } : {},
              })}
            >
              {saving ? '正在保存…' : `创建 r${employee.currentRevision + 1}`}
            </button>
          </section>
          <section className="archive-section">
            <div><Archive size={18} /><div><strong>归档员工</strong><p>员工将从当前世界和 @ 列表移除，但会话、交付物和审计记录不会删除。</p></div></div>
            {confirmArchive ? (
              <div className="archive-confirm"><ShieldWarning size={17} /><span>确认归档 {employee.displayName}？</span><button type="button" disabled={saving} onClick={() => void onArchive()}>确认归档</button><button type="button" onClick={() => setConfirmArchive(false)}>取消</button></div>
            ) : <button className="danger-button" type="button" onClick={() => setConfirmArchive(true)}>归档员工</button>}
          </section>
        </div>
      </section>
    </div>
  )
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))]
}
