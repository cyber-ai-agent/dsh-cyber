import { CheckCircle, LockKey, Palette, SlidersHorizontal, UserCircle, WarningCircle, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { AgentPermissionMode, ModelProfile, ReasoningEffort, World, WorldAccessSummary, WorldSettings } from '@dsh-cyber/contracts'

interface WorldSettingsDialogProps {
  world: World
  value: WorldSettings
  access: WorldAccessSummary
  models: ModelProfile[]
  saving: boolean
  onClose(): void
  onSave(value: WorldSettings): Promise<void>
  onSetPassword(password: string): Promise<void>
  onClearPassword(): Promise<void>
  onLock(): Promise<void>
}

export function WorldSettingsDialog({ world, value, access, models, saving, onClose, onSave, onSetPassword, onClearPassword, onLock }: WorldSettingsDialogProps) {
  const [draft, setDraft] = useState(value)
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const savedRef = useRef(false)

  useEffect(() => {
    setDraft(value)
    applyWorldPreview(value)
  }, [value])

  useEffect(() => {
    applyWorldPreview(draft)
  }, [draft])

  useEffect(() => () => {
    if (!savedRef.current) applyWorldPreview(value)
  }, [value])

  const close = () => {
    applyWorldPreview(value)
    onClose()
  }

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

  const setPasswordAction = async () => {
    setError(undefined)
    try {
      await onSetPassword(password)
      setPassword('')
      setNotice('访问密码已设置')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '密码设置失败')
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="world-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="world-settings-title">
        <header className="dialog-header">
          <div><h2 id="world-settings-title">世界设置 · {world.name}</h2><p>设定、视觉、模型与访问锁只属于当前世界。修改视觉会立即预览，取消不会保存。</p></div>
          <button className="icon-button" onClick={close} aria-label="关闭"><X size={18}/></button>
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
            <label>你的名字<input value={draft.userIdentity.displayName} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,displayName:event.target.value}})} placeholder="你希望角色怎么识别你"/></label>
            <label>你在这个世界的身份<input value={draft.userIdentity.worldRole} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,worldRole:event.target.value}})} placeholder="主人 / 院长 / 旅人 / 负责人"/></label>
            <label>角色默认如何称呼你<input value={draft.userIdentity.addressAs} onChange={(event)=>setDraft({...draft,userIdentity:{...draft.userIdentity,addressAs:event.target.value}})} placeholder="主人 / 院长 / 名字"/></label>
            <p className="setting-help">这里是世界默认值。某个角色有特殊关系时，应在该角色设置里单独覆盖。</p>
          </fieldset>

          <fieldset className="world-visual-settings">
            <legend><Palette size={16}/> 视觉</legend>
            <div className="color-setting-row">
              <ColorControl label="强调色" value={draft.appearance.accentColor} onChange={(value)=>setDraft({...draft,appearance:{...draft.appearance,accentColor:value}})} />
              <ColorControl label="背景" value={draft.appearance.pageBackground} onChange={(value)=>setDraft({...draft,appearance:{...draft.appearance,pageBackground:value}})} />
              <ColorControl label="角色气泡" value={draft.appearance.characterBubbleColor} onChange={(value)=>setDraft({...draft,appearance:{...draft.appearance,characterBubbleColor:value}})} />
              <ColorControl label="你的气泡" value={draft.appearance.ownerBubbleColor} onChange={(value)=>setDraft({...draft,appearance:{...draft.appearance,ownerBubbleColor:value}})} />
            </div>
            <label className="radius-setting"><span>对话框圆角 <strong>{draft.appearance.bubbleRadius}px</strong></span><input type="range" min="0" max="28" value={draft.appearance.bubbleRadius} onChange={(event)=>setDraft({...draft,appearance:{...draft.appearance,bubbleRadius:Number(event.target.value)}})}/></label>
            <div className="world-chat-preview" aria-label="聊天视觉预览">
              <span className="is-character">角色：欢迎来到这个世界。</span>
              <span className="is-owner">你：这里的样式会跟着设置实时变化。</span>
            </div>
          </fieldset>

          <fieldset>
            <legend><SlidersHorizontal size={16}/> 模型与运行</legend>
            <label>世界默认模型<select value={draft.model.defaultModelProfileId ?? ''} onChange={(event)=>setDraft({...draft,model:event.target.value ? {...draft.model,defaultModelProfileId:event.target.value} : {reasoningEffort:draft.model.reasoningEffort}})}><option value="">继承全局或角色设置</option>{models.map((model)=><option key={model.id} value={model.id}>{model.displayName} · {model.modelId}</option>)}</select></label>
            <label>默认推理<select value={draft.model.reasoningEffort} onChange={(event)=>setDraft({...draft,model:{...draft.model,reasoningEffort:event.target.value as ReasoningEffort}})}>{reasoningOptions.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
            <label>任务权限<select value={draft.runtime.permissionMode} onChange={(event)=>setDraft({...draft,runtime:{permissionMode:event.target.value as AgentPermissionMode}})}><option value="read-only">只读：允许查看和搜索文件</option><option value="workspace-write">执行：允许调用工具并修改当前世界文件</option></select></label>
            <p className="setting-help">权限只应用于当前世界。切换后，下次对话会使用新的运行环境。</p>
          </fieldset>

          <fieldset>
            <legend><LockKey size={16}/> 隐私</legend>
            <p>{access.passwordEnabled ? '当前世界已启用本地访问锁。密码不会明文保存。' : '可为当前世界单独设置访问密码。第一阶段是本机访问锁，不等同磁盘加密。'}</p>
            {access.passwordEnabled ? (
              <div className="settings-inline-actions"><button className="secondary-button" onClick={()=>void onLock()}>立即锁定</button><button className="text-button" onClick={()=>void onClearPassword()}>移除密码</button></div>
            ) : (
              <div className="settings-inline-actions"><input type="password" value={password} onChange={(event)=>setPassword(event.target.value)} placeholder="至少 4 位"/><button className="secondary-button" disabled={password.length<4} onClick={()=>void setPasswordAction()}>设置密码</button></div>
            )}
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

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'
  return (
    <label className="color-control">
      <span>{label}</span>
      <span className="color-control__input"><input type="color" value={normalized} onChange={(event)=>onChange(event.target.value)}/><code>{value.toUpperCase()}</code></span>
    </label>
  )
}

const reasoningOptions: Array<[ReasoningEffort, string]> = [
  ['auto','自动'], ['off','关闭'], ['minimal','极低'], ['low','低'], ['medium','中'], ['high','高'], ['xhigh','极高'], ['max','最大'],
]

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
