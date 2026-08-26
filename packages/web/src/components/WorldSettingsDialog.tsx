import { CheckCircle, LockKey, Palette, ShieldCheck, SlidersHorizontal, UserCircle, WarningCircle, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { AgentPermissionMode, EmployeeInstance, ModelProfile, ReasoningEffort, World, WorldCharacterAuthority, WorldSettings } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { useDialogFocusTrap } from './useDialogFocusTrap.js'

interface WorldSettingsDialogProps {
  world: World
  value: WorldSettings
  models: ModelProfile[]
  employees: EmployeeInstance[]
  authorities?: WorldCharacterAuthority[]
  saving: boolean
  onClose(): void
  onSave(value: WorldSettings): Promise<void>
  onManageAdministrators?(): void
  onManageEmployee?(employeeId: string): void
}

export function WorldSettingsDialog({ world, value, models, employees, authorities, saving, onClose, onSave, onManageAdministrators, onManageEmployee }: WorldSettingsDialogProps) {
  const [draft, setDraft] = useState(normalizeWorldSettings(value))
  const [notice, setNotice] = useState<string | undefined>()
  const [error, setError] = useState<string>()
  const savedRef = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)

  const close = () => {
    applyWorldPreview(value)
    onClose()
  }

  useDialogFocusTrap(dialogRef, close)

  useEffect(() => {
    setDraft(normalizeWorldSettings(value))
    applyWorldPreview(value)
  }, [value])

  useEffect(() => {
    applyWorldPreview(draft)
  }, [draft])

  useEffect(() => () => {
    if (!savedRef.current) applyWorldPreview(value)
  }, [value])

  const administratorIds = authorities === undefined
    ? (world.administratorEmployeeId === undefined ? [] : [world.administratorEmployeeId])
    : authorities.filter((authority) => authority.role === 'administrator').map((authority) => authority.employeeId)
  const administrators = administratorIds
    .map((employeeId) => employees.find((employee) => employee.id === employeeId))
    .filter((employee): employee is EmployeeInstance => employee !== undefined && employee.status !== 'archived')

  const save = async () => {
    setError(undefined)
    setNotice(undefined)
    try {
      await onSave(draft)
      savedRef.current = true
      setNotice('世界设置已保存')
      window.setTimeout(onClose, 450)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界设置保存失败')
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={dialogRef} className="world-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="world-settings-title">
        <header className="dialog-header">
          <div><h2 id="world-settings-title">世界设置 · {world.name}</h2><p>设定、管理员和视觉只属于当前世界。修改视觉会立即预览，取消不会保存。</p></div>
          <button data-dialog-initial-focus className="icon-button" onClick={close} aria-label="关闭"><X size={18}/></button>
        </header>

        {notice ? <div className="world-settings-feedback is-success" role="status"><CheckCircle size={16}/>{notice}</div> : null}
        {error ? <div className="world-settings-feedback is-error" role="alert"><WarningCircle size={16}/>{error}</div> : null}

        <div className="world-settings-grid">
          <fieldset>
            <legend><SlidersHorizontal size={16}/> 世界观</legend>
            <label>世界设定<textarea rows={6} value={draft.lore} onChange={(event)=>setDraft({...draft,lore:event.target.value})} placeholder="例如：这是一个雨夜魔法学院。我是院长，角色都了解学院规则和自己的身份。"/></label>
            <label>当前场景<textarea rows={3} value={draft.scenario} onChange={(event)=>setDraft({...draft,scenario:event.target.value})} placeholder="例如：深夜的图书馆，窗外正在下雨。"/></label>
          </fieldset>

          <fieldset>
            <legend><UserCircle size={16}/> 你与角色</legend>
            <div className="world-admin-overview" aria-labelledby="world-admin-overview-title">
              <div className="world-admin-overview__heading">
                <div><strong id="world-admin-overview-title">世界管理员</strong><small>共 {administrators.length} 名管理员</small></div>
                <button className="secondary-button" type="button" onClick={onManageAdministrators}>管理角色</button>
              </div>
              {administrators.length === 0 ? <p className="world-admin-overview__empty">当前世界还没有管理员。请在角色设置中授予管理员身份。</p> : (
                <ul className="world-admin-list">
                  {administrators.map((employee) => {
                    const cyberEmployee = employee as CyberEmployee
                    return (
                      <li key={employee.id}>
                        <button type="button" className="world-admin-list__item" onClick={() => onManageEmployee?.(employee.id)} aria-label={`管理${employee.displayName}的世界权限`}>
                          <Avatar index={cyberEmployee.avatarIndex ?? 0} size="sm" label={employee.displayName} authorityRole="administrator" />
                          <span><strong>{employee.displayName}<AuthorityBadge role="administrator" /></strong><small>{employee.role}</small></span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="setting-help">管理员身份和具体世界权限请在角色设置中管理。</p>
            </div>
            <label>你的名字<input value={draft.userIdentity.displayName} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,displayName:event.target.value}})} placeholder="你希望角色怎么识别你"/></label>
            <label>你在这个世界的身份<input value={draft.userIdentity.worldRole} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,worldRole:event.target.value}})} placeholder="主人 / 院长 / 旅人 / 负责人"/></label>
            <label>角色默认如何称呼你<input value={draft.userIdentity.addressAs} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,addressAs:event.target.value}})} placeholder="主人 / 院长 / 名字"/></label>
            <p className="setting-help">这里是世界默认值。某个角色有特殊关系时，应在该角色设置里单独覆盖。</p>
          </fieldset>

          <fieldset className="world-visual-settings">
            <legend><Palette size={16}/> 视觉</legend>
            <p className="setting-help">选择统一设计的完整配色，不需要逐个调整颜色值。</p>
            <div className="world-theme-presets">{WORLD_APPEARANCE_PRESETS.map((preset)=><button key={preset.id} type="button" className={appearanceMatches(draft.appearance,preset.appearance)?'is-active':''} onClick={()=>setDraft({...draft,appearance:{...draft.appearance,...preset.appearance}})}><span style={{background:preset.appearance.pageBackground,borderColor:preset.appearance.accentColor}}><i style={{background:preset.appearance.ownerBubbleColor}}/><i style={{background:preset.appearance.characterBubbleColor}}/></span><div><strong>{preset.label}</strong><small>{preset.description}</small></div></button>)}</div>
            <div className="world-chat-preview" aria-label="聊天视觉预览">
              <span className="is-character">角色：欢迎来到这个世界。</span>
              <span className="is-owner">你：这里的样式会跟着设置实时变化。</span>
            </div>
          </fieldset>

          <fieldset>
            <legend><SlidersHorizontal size={16}/> 模型与运行</legend>
            <label>世界默认模型<select value={draft.model.defaultModelProfileId ?? ''} onChange={(event)=>setDraft({...draft,model:event.target.value ? {...draft.model,defaultModelProfileId:event.target.value} : {reasoningEffort:draft.model.reasoningEffort}})}><option value="">继承全局或角色设置</option>{models.map((model)=><option key={model.id} value={model.id}>{model.displayName} · {model.modelId}</option>)}</select></label>
            <label>默认推理<select value={draft.model.reasoningEffort} onChange={(event)=>setDraft({...draft,model:{...draft.model,reasoningEffort:event.target.value as ReasoningEffort}})}>{reasoningOptions.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
          </fieldset>

          <fieldset className="world-permission-layers">
            <legend><ShieldCheck size={16}/> 技能与工具</legend>
            <p className="setting-help">浏览器、外部连接和命令属于角色能力，请在角色档案的“技能与工具”中管理。</p>
            <span className="host-access-unavailable">请在角色设置的“技能与工具”中管理已启用能力。</span>
          </fieldset>

          <fieldset className="world-settings-advanced">
            <legend><SlidersHorizontal size={16}/> 高级术语</legend>
            <details>
              <summary>自定义这个世界里“角色 / 群聊 / 任务”等名称</summary>
              <div className="advanced-terminology-grid">
                <label>单个角色的类型名称<input value={draft.terminology.characterSingular} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,characterSingular:event.target.value}})} placeholder="角色 / 宠物 / 居民 / 学生"/></label>
                <label>多个角色的类型名称<input value={draft.terminology.characterPlural} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,characterPlural:event.target.value}})}/></label>
                <label>添加角色动作<input value={draft.terminology.addCharacterVerb} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,addCharacterVerb:event.target.value}})}/></label>
                <label>多人会话名称<input value={draft.terminology.groupConversation} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,groupConversation:event.target.value}})}/></label>
                <label>任务名称<input value={draft.terminology.assignment} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,assignment:event.target.value}})}/></label>
              </div>
            </details>
          </fieldset>
        </div>

        <footer className="settings-dialog__footer"><span>{saving ? '正在保存…' : notice ?? '视觉修改正在实时预览，只有保存后才会持久化'}</span><div><button className="text-button" onClick={close}>取消</button><button className="primary-button" disabled={saving} onClick={()=>void save()}>{saving ? '正在保存…' : '保存世界设置'}</button></div></footer>
      </section>
    </div>
  )
}

const WORLD_APPEARANCE_PRESETS = [
  { id:'graphite', label:'石墨金', description:'深色中性表面与克制琥珀强调', appearance:{accentColor:'#d7a52a',pageBackground:'#080d10',panelBackground:'#0d1419',ownerBubbleColor:'#263629',characterBubbleColor:'#141c22',textColor:'#edf2f4',mutedTextColor:'#84919a'}},
  { id:'deep-ocean', label:'深海蓝', description:'冷灰背景与清晰蓝色状态提示', appearance:{accentColor:'#67a9c4',pageBackground:'#081017',panelBackground:'#101b22',ownerBubbleColor:'#18323d',characterBubbleColor:'#13232c',textColor:'#e7eef1',mutedTextColor:'#91a2ab'}},
  { id:'warm-paper', label:'暖灰日光', description:'低眩光浅色表面与深色正文', appearance:{accentColor:'#806321',pageBackground:'#e7e7e2',panelBackground:'#f1f0eb',ownerBubbleColor:'#ded6bd',characterBubbleColor:'#f7f6f2',textColor:'#252a27',mutedTextColor:'#626b65'}},
] as const

function appearanceMatches(appearance: WorldSettings['appearance'], candidate: typeof WORLD_APPEARANCE_PRESETS[number]['appearance']): boolean {
  return appearance.accentColor === candidate.accentColor && appearance.pageBackground === candidate.pageBackground && appearance.panelBackground === candidate.panelBackground
}

const reasoningOptions: Array<[ReasoningEffort, string]> = [
  ['auto','自动'], ['off','关闭'], ['minimal','极低'], ['low','低'], ['medium','中'], ['high','高'], ['xhigh','极高'], ['max','最大'],
]

function normalizeWorldSettings(settings: WorldSettings): WorldSettings {
  return settings.runtime.permissionMode === 'danger-full-access'
    ? { ...settings, runtime: { permissionMode: 'read-only' } }
    : settings
}

function applyWorldPreview(settings: WorldSettings): void {
  const root = document.documentElement
  const appearance = settings.appearance
  root.style.setProperty('--world-accent', appearance.accentColor)
  root.style.setProperty('--world-background', appearance.pageBackground)
  root.style.setProperty('--world-panel', appearance.panelBackground)
  root.style.setProperty('--world-owner-bubble', appearance.ownerBubbleColor)
  root.style.setProperty('--world-character-bubble', appearance.characterBubbleColor)
  root.style.setProperty('--world-text', appearance.textColor)
  root.style.setProperty('--world-muted', appearance.mutedTextColor)
  root.style.setProperty('--world-panel-radius', `${appearance.panelRadius}px`)
  root.style.setProperty('--world-bubble-radius', `${appearance.bubbleRadius}px`)
  root.style.setProperty('--world-button-radius', `${appearance.buttonRadius}px`)
  root.style.setProperty('--world-font-scale', String(appearance.fontScale))
}

export function WorldUnlockDialog({ worldName, onUnlock }: { worldName: string; onUnlock(password: string): Promise<void> }) {
  const [password,setPassword]=useState('')
  const [error,setError]=useState<string>()
  const [busy,setBusy]=useState(false)
  return <div className="modal-backdrop"><section className="world-unlock-dialog" role="dialog" aria-modal="true"><LockKey size={30}/><h2>{worldName} 已锁定</h2><p>输入当前世界的本地密码继续。</p><input autoFocus type="password" value={password} onChange={(event)=>setPassword(event.target.value)} onKeyDown={(event)=>{ if(event.key==='Enter' && password) void submit() }}/><button className="primary-button" disabled={!password||busy} onClick={()=>void submit()}>{busy?'正在解锁…':'解锁世界'}</button>{error?<p className="package-error">{error}</p>:null}</section></div>
  async function submit(){setBusy(true);setError(undefined);try{await onUnlock(password)}catch(cause){setError(cause instanceof Error?cause.message:'解锁失败')}finally{setBusy(false)}}
}
