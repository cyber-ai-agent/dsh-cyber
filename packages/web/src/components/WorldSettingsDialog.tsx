import { CheckCircle, Cpu, Palette, ShieldCheck, SlidersHorizontal, UserCircle, WarningCircle, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { AgentPermissionMode, EmployeeInstance, ModelProfile, ReasoningEffort, World, WorldCharacterAuthority, WorldSettings } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { useDialogFocusTrap } from './useDialogFocusTrap.js'
import { applyWorldTheme, readWorldTheme, saveWorldTheme, themeRegistry } from '../features/world/world-themes.js'

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

  const [selectedThemeId, setSelectedThemeId] = useState<string>(() => readWorldTheme(world))
  const initialThemeIdRef = useRef<string>(readWorldTheme(world))

  const close = () => {
    applyWorldPreview(value)
    applyWorldTheme(initialThemeIdRef.current)
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

  const administratorIds = authorities === undefined
    ? (world.administratorEmployeeId === undefined ? [] : [world.administratorEmployeeId])
    : authorities.filter((authority) => authority.role === 'administrator').map((authority) => authority.employeeId)
  const administrators = administratorIds
    .map((employeeId) => employees.find((employee) => employee.id === employeeId))
    .filter((employee): employee is EmployeeInstance => employee !== undefined && employee.status !== 'archived')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setNotice(undefined)
    try {
      saveWorldTheme(world.id, selectedThemeId)
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
          <section className="world-settings-card">
            <header className="world-settings-card__header">
              <span className="card-icon"><SlidersHorizontal size={17}/></span>
              <div>
                <h4>世界观设定</h4>
                <small>定义当前世界的背景故事、世界规则与当前沉浸场景</small>
              </div>
            </header>
            <div className="world-settings-card__body">
              <div className="dialog-field">
                <span>世界设定背景</span>
                <textarea rows={4} value={draft.lore} onChange={(event)=>setDraft({...draft,lore:event.target.value})} placeholder="例如：这是一个雨夜魔法学院。我是院长，角色都了解学院规则和自己的身份。"/>
              </div>
              <div className="dialog-field">
                <span>当前场景</span>
                <textarea rows={2} value={draft.scenario} onChange={(event)=>setDraft({...draft,scenario:event.target.value})} placeholder="例如：深夜的图书馆，窗外正在下雨。"/>
              </div>
            </div>
          </section>

          <section className="world-settings-card">
            <header className="world-settings-card__header">
              <span className="card-icon"><UserCircle size={17}/></span>
              <div>
                <h4>你与角色身份</h4>
                <small>设定你在当前世界的身份定位，以及角色对你的称呼</small>
              </div>
            </header>
            <div className="world-settings-card__body">
              <div className="dialog-field-grid">
                <div className="dialog-field">
                  <span>你的名字</span>
                  <input type="text" value={draft.userIdentity.displayName} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,displayName:event.target.value}})} placeholder="例如：指挥官 / 玩家名"/>
                </div>
                <div className="dialog-field">
                  <span>你在本世界的身份</span>
                  <input type="text" value={draft.userIdentity.worldRole} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,worldRole:event.target.value}})} placeholder="主人 / 院长 / 旅人 / 负责人"/>
                </div>
              </div>
              <div className="dialog-field">
                <span>角色默认如何称呼你</span>
                <input type="text" value={draft.userIdentity.addressAs} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,addressAs:event.target.value}})} placeholder="主人 / 院长 / 您的称谓"/>
              </div>
              <div className="setting-help">这里是世界默认值。某个角色有特殊关系时，应在该角色设置里单独覆盖。</div>
            </div>
          </section>

          <section className="world-settings-card world-visual-settings">
            <header className="world-settings-card__header">
              <span className="card-icon"><Palette size={17}/></span>
              <div>
                <h4>世界专属主题</h4>
                <small>为【{world.name}】选择空间视觉风格，世界之间完全独立隔离</small>
              </div>
            </header>
            <div className="world-settings-card__body">
              <div className="world-theme-presets">
                {themeRegistry.list().map((theme) => {
                  const active = selectedThemeId === theme.id
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      className={active ? 'is-active' : ''}
                      onClick={() => {
                        setSelectedThemeId(theme.id)
                        applyWorldTheme(theme.id)
                      }}
                    >
                      <span style={{ background: theme.tokens.pageBackground, borderColor: theme.tokens.accentColor }}>
                        <i style={{ background: theme.tokens.accentColor }} />
                      </span>
                      <div>
                        <strong>{theme.displayName}</strong>
                        <small>{theme.description}</small>
                      </div>
                    </button>
                  )
                })}
              </div>
              <div className="world-chat-preview" aria-label="聊天视觉预览">
                <span className="is-character">角色：欢迎来到这个世界。</span>
                <span className="is-owner">你：这里的样式会跟着设置实时变化。</span>
              </div>
            </div>
          </section>

          <section className="world-settings-card">
            <header className="world-settings-card__header">
              <span className="card-icon"><Cpu size={17}/></span>
              <div>
                <h4>模型与运行</h4>
                <small>配置当前世界的默认大语言模型及推理策略</small>
              </div>
            </header>
            <div className="world-settings-card__body">
              <div className="dialog-field">
                <span>世界默认模型</span>
                <select value={draft.model.defaultModelProfileId ?? ''} onChange={(event)=>setDraft({...draft,model:event.target.value ? {...draft.model,defaultModelProfileId:event.target.value} : {reasoningEffort:draft.model.reasoningEffort,responseLanguage:draft.model.responseLanguage}})}>
                  <option value="">继承全局或角色设置</option>
                  {models.map((model)=><option key={model.id} value={model.id}>{model.displayName} · {model.modelId}</option>)}
                </select>
              </div>
              <div className="dialog-field-grid">
                <div className="dialog-field">
                  <span>默认推理强度</span>
                  <select value={draft.model.reasoningEffort} onChange={(event)=>setDraft({...draft,model:{...draft.model,reasoningEffort:event.target.value as ReasoningEffort}})}>
                    {reasoningOptions.map(([id,label])=><option key={id} value={id}>{label}</option>)}
                  </select>
                </div>
                <div className="dialog-field">
                  <span>回复偏好语言</span>
                  <select value={draft.model.responseLanguage} onChange={(event)=>setDraft({...draft,model:{...draft.model,responseLanguage:event.target.value as WorldSettings['model']['responseLanguage']}})}>
                    <option value="zh-CN">简体中文（默认）</option>
                    <option value="auto">跟随用户消息</option>
                    <option value="en-US">English</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          <section className="world-settings-card">
            <header className="world-settings-card__header">
              <span className="card-icon"><ShieldCheck size={17}/></span>
              <div>
                <h4>技能与权限</h4>
                <small>管理当前世界中角色能够调用的外部工具与系统权限</small>
              </div>
            </header>
            <div className="world-settings-card__body">
              <div className="setting-help">浏览器、外部连接和命令属于角色能力，请在角色档案的“技能与工具”中管理。</div>
            </div>
          </section>

          <section className="world-settings-card world-settings-advanced">
            <header className="world-settings-card__header">
              <span className="card-icon"><SlidersHorizontal size={17}/></span>
              <div>
                <h4>高级术语定制</h4>
                <small>自定义这个世界里的“角色 / 群聊 / 任务”等显示称谓</small>
              </div>
            </header>
            <div className="world-settings-card__body">
              <div className="dialog-field-grid">
                <div className="dialog-field">
                  <span>单个角色的类型名称</span>
                  <input type="text" value={draft.terminology.characterSingular} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,characterSingular:event.target.value}})} placeholder="角色 / 宠物 / 居民 / 学生"/>
                </div>
                <div className="dialog-field">
                  <span>多个角色的类型名称</span>
                  <input type="text" value={draft.terminology.characterPlural} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,characterPlural:event.target.value}})}/>
                </div>
              </div>
              <div className="dialog-field-grid">
                <div className="dialog-field">
                  <span>添加角色动作动词</span>
                  <input type="text" value={draft.terminology.addCharacterVerb} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,addCharacterVerb:event.target.value}})}/>
                </div>
                <div className="dialog-field">
                  <span>多人会话名称</span>
                  <input type="text" value={draft.terminology.groupConversation} onChange={(event)=>setDraft({...draft,terminology:{...draft.terminology,groupConversation:event.target.value}})}/>
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer className="world-settings-dialog__footer">
          <small>{saving ? '正在保存…' : notice ?? '视觉修改正在实时预览，只有保存后才会持久化'}</small>
          <div>
            <button type="button" className="secondary-button" onClick={close}>取消</button>
            <button type="button" className="primary-button" disabled={saving} onClick={(e)=>void submit(e)}>
              {saving ? '正在保存…' : '保存世界设置'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

const WORLD_APPEARANCE_PRESETS = [
  { id:'graphite', label:'石墨金', description:'深色中性表面与克制琥珀强调', appearance:{accentColor:'#d7a52a',pageBackground:'#080d10',panelBackground:'#0d1419',ownerBubbleColor:'#18283a',characterBubbleColor:'#141c22',textColor:'#edf2f4',mutedTextColor:'#84919a'}},
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
