import {
  ArrowsClockwise,
  Cpu,
  Database,
  Desktop,
  ImageSquare,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  X,
} from '@phosphor-icons/react'
import { useMemo, useState, type ReactNode } from 'react'
import type {
  EmployeeInstance,
  ModelApiKind,
  ModelAssignment,
  ModelProfile,
  ModelProviderKind,
  RuntimeUpdateTransaction,
  Workspace,
  WorkspacePreferences,
  World,
} from '@dsh-cyber/contracts'

export type SettingsSection = 'appearance' | 'models' | 'runtime' | 'data' | 'updates'
export type SystemAction = 'status' | 'doctor' | 'backup' | 'export' | 'list-updates' | 'verify-update' | 'contract-update' | 'canary-update' | 'activate-update' | 'rollback-update'

export interface SystemActionInput {
  candidateRoot?: string
  transactionId?: string
  modelProfileId?: string
  approved?: boolean
}

export interface SystemActionResult {
  ok: boolean
  checkedAt?: string
  createdAt?: string
  kind?: string
  output?: string
  stateRoot?: string
  version?: string
  supported?: boolean
  contractId?: string
  database?: { schemaVersion?: number; integrity?: string[]; errors?: string[]; counts?: Record<string, number> }
  compatibility?: { expectedVersion?: string; errors?: string[] }
  checks?: Record<string, boolean>
  errors?: string[]
  transaction?: RuntimeUpdateTransaction
  items?: RuntimeUpdateTransaction[]
  activeRuntime?: { transactionId: string; candidateRoot: string; version: string }
  restartRequired?: boolean
}

interface SettingsDialogProps {
  preferences: WorkspacePreferences
  models: ModelProfile[]
  assignments: ModelAssignment[]
  workspace: Workspace
  worlds: World[]
  employees: EmployeeInstance[]
  initialSection?: SettingsSection
  saving: boolean
  onClose(): void
  onSavePreferences(preferences: WorkspacePreferences): Promise<void>
  onUploadBackground(file: File): Promise<string>
  onSaveModel(profile: Omit<ModelProfile, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>): Promise<void>
  onAssignModel(input: { scope: ModelAssignment['scope']; scopeId: string; modelProfileId?: string }): Promise<void>
  onSystemAction(action: SystemAction, input?: SystemActionInput): Promise<SystemActionResult>
}

const sections = [
  ['appearance', '外观与个性化', Palette],
  ['models', '模型', Cpu],
  ['runtime', '运行时', ShieldCheck],
  ['data', '本地数据', Database],
  ['updates', '更新', ArrowsClockwise],
] as const

interface ModelProviderPreset {
  id: string
  label: string
  providerKind: ModelProviderKind
  api: ModelApiKind
  baseUrl: string
  credentialEnvName: string
  modelPlaceholder: string
}

interface ModelDraft {
  providerId: string
  displayName: string
  providerKind: ModelProviderKind
  baseUrl: string
  modelId: string
  api: ModelApiKind
  credentialEnvName: string
  contextWindow: number
  maxTokens: number
  temperature: number
}

const MODEL_PRESETS: readonly ModelProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', providerKind: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', credentialEnvName: 'DEEPSEEK_API_KEY', modelPlaceholder: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', providerKind: 'openai-compatible-remote', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credentialEnvName: 'OPENAI_API_KEY', modelPlaceholder: 'gpt-5' },
  { id: 'anthropic', label: 'Anthropic', providerKind: 'openai-compatible-remote', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', credentialEnvName: 'ANTHROPIC_API_KEY', modelPlaceholder: 'claude-sonnet-4-5' },
  { id: 'gemini', label: 'Google Gemini', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', credentialEnvName: 'GEMINI_API_KEY', modelPlaceholder: 'gemini-2.5-pro' },
  { id: 'openrouter', label: 'OpenRouter', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', credentialEnvName: 'OPENROUTER_API_KEY', modelPlaceholder: 'deepseek/deepseek-chat' },
  { id: 'groq', label: 'Groq', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1', credentialEnvName: 'GROQ_API_KEY', modelPlaceholder: 'llama-3.3-70b-versatile' },
  { id: 'mistral', label: 'Mistral', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://api.mistral.ai/v1', credentialEnvName: 'MISTRAL_API_KEY', modelPlaceholder: 'mistral-large-latest' },
  { id: 'xai', label: 'xAI', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://api.x.ai/v1', credentialEnvName: 'XAI_API_KEY', modelPlaceholder: 'grok-4' },
  { id: 'ollama', label: 'Ollama（本地）', providerKind: 'openai-compatible-local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1', credentialEnvName: '', modelPlaceholder: 'qwen3:14b' },
  { id: 'lm-studio', label: 'LM Studio（本地）', providerKind: 'openai-compatible-local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1234/v1', credentialEnvName: '', modelPlaceholder: 'local-model' },
] as const

function modelDraftForPreset(preset: ModelProviderPreset): ModelDraft {
  return {
    providerId: preset.id,
    displayName: preset.label,
    providerKind: preset.providerKind,
    baseUrl: preset.baseUrl,
    modelId: '',
    api: preset.api,
    credentialEnvName: preset.credentialEnvName,
    contextWindow: 64_000,
    maxTokens: 8_192,
    temperature: 0.3,
  }
}

export function SettingsDialog({
  preferences,
  models,
  assignments,
  workspace,
  worlds,
  employees,
  initialSection = 'appearance',
  saving,
  onClose,
  onSavePreferences,
  onUploadBackground,
  onSaveModel,
  onAssignModel,
  onSystemAction,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [draft, setDraft] = useState(preferences)
  const [uploading, setUploading] = useState(false)
  const [pendingAction, setPendingAction] = useState<SystemAction>()
  const [actionResult, setActionResult] = useState<SystemActionResult>()
  const [actionError, setActionError] = useState<string>()
  const [modelDraft, setModelDraft] = useState<ModelDraft>(() => modelDraftForPreset(MODEL_PRESETS[0]!))
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(preferences), [draft, preferences])
  const runSystemAction = async (action: SystemAction, input?: SystemActionInput) => {
    setPendingAction(action)
    setActionResult(undefined)
    setActionError(undefined)
    try {
      setActionResult(await onSystemAction(action, input))
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '本地操作失败')
    } finally {
      setPendingAction(undefined)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-dialog__header">
          <div><h2 id="settings-title">设置</h2><p>管理界面、模型、数据和 DSH 运行时。</p></div>
          <button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置栏目">
            {sections.map(([id, label, Icon]) => (
              <button key={id} type="button" className={section === id ? 'is-active' : ''} onClick={() => setSection(id)}>
                <Icon size={17} /><span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {section === 'appearance' ? (
              <AppearanceSettings
                value={draft}
                uploading={uploading}
                onChange={setDraft}
                onUpload={async (file) => {
                  setUploading(true)
                  try {
                    const assetRef = await onUploadBackground(file)
                    setDraft((value) => ({ ...value, backgroundAssetRef: assetRef }))
                  } finally {
                    setUploading(false)
                  }
                }}
              />
            ) : null}
            {section === 'models' ? (
              <ModelSettings
                models={models}
                assignments={assignments}
                workspace={workspace}
                worlds={worlds}
                employees={employees}
                draft={modelDraft}
                onChange={setModelDraft}
                onAssign={onAssignModel}
                onSave={() => onSaveModel({
                  displayName: modelDraft.displayName,
                  providerKind: modelDraft.providerKind,
                  baseUrl: modelDraft.baseUrl,
                  modelId: modelDraft.modelId,
                  api: modelDraft.api,
                  ...(modelDraft.credentialEnvName ? { credentialEnvName: modelDraft.credentialEnvName } : {}),
                  isDefault: models.length === 0,
                  settings: {
                    providerId: modelDraft.providerId,
                    contextWindow: modelDraft.contextWindow,
                    maxTokens: modelDraft.maxTokens,
                    temperature: modelDraft.temperature,
                  },
                })}
              />
            ) : null}
            {section === 'runtime' ? <RuntimeSettings pending={pendingAction} result={actionResult} error={actionError} onRun={runSystemAction} /> : null}
            {section === 'data' ? <DataSettings pending={pendingAction} result={actionResult} error={actionError} onRun={runSystemAction} /> : null}
            {section === 'updates' ? <UpdateSettings models={models} pending={pendingAction} result={actionResult} error={actionError} onRun={runSystemAction} /> : null}
          </div>
        </div>
        <footer className="settings-dialog__footer">
          <span>{saving ? '正在保存…' : changed ? '有未保存的外观更改' : '设置已同步到本地数据库'}</span>
          <div><button className="text-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={!changed || saving} onClick={() => void onSavePreferences(draft)}>保存设置</button></div>
        </footer>
      </section>
    </div>
  )
}

function AppearanceSettings({
  value,
  uploading,
  onChange,
  onUpload,
}: {
  value: WorkspacePreferences
  uploading: boolean
  onChange(value: WorkspacePreferences | ((current: WorkspacePreferences) => WorkspacePreferences)): void
  onUpload(file: File): Promise<void>
}) {
  return (
    <div className="settings-section">
      <div className="settings-section__heading"><h3>外观与个性化</h3><p>设置全局明暗、皮肤、背景和工作台密度。</p></div>
      <fieldset className="setting-group">
        <legend>颜色模式</legend>
        <div className="segmented-control">
          {([['system', '跟随系统', Desktop], ['light', '白天', Sun], ['dark', '黑夜', Moon]] as const).map(([id, label, Icon]) => (
            <button key={id} type="button" className={value.colorScheme === id ? 'is-active' : ''} onClick={() => onChange({ ...value, colorScheme: id })}>
              <Icon size={17} /><span>{label}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="setting-group">
        <legend>界面皮肤</legend>
        <div className="skin-options">
          {([
            ['cyber-graphite', '赛博石墨', '#0d1114', '#e0a72f'],
            ['midnight-violet', '午夜紫', '#11101a', '#a98df0'],
            ['paper-daylight', '纸张日光', '#f2f0e9', '#996c18'],
          ] as const).map(([id, label, background, accent]) => (
            <button key={id} type="button" className={value.skinId === id ? 'is-active' : ''} onClick={() => onChange({ ...value, skinId: id })}>
              <span style={{ background, borderColor: accent }}><i style={{ background: accent }} /></span><strong>{label}</strong>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="setting-group">
        <legend>自定义背景</legend>
        <label className="background-upload">
          <ImageSquare size={24} />
          <span><strong>{uploading ? '正在保存到本地…' : '上传 PNG、JPEG 或 WebP'}</strong><small>最大 5 MiB。文件保存在本机，并同步作为当前世界场景底图；人物、灯光与状态层仍可交互。</small></span>
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUpload(file) }} />
        </label>
        <div className="setting-grid setting-grid--three">
          <label><span>适配方式</span><select value={value.backgroundFit} onChange={(event) => onChange({ ...value, backgroundFit: event.target.value as WorkspacePreferences['backgroundFit'] })}><option value="cover">铺满</option><option value="contain">完整显示</option><option value="tile">平铺</option></select></label>
          <label><span>背景透明度</span><input type="range" min="0" max="0.6" step="0.02" value={value.backgroundOpacity} onChange={(event) => onChange({ ...value, backgroundOpacity: Number(event.target.value) })} /></label>
          <label><span>动效</span><select value={value.motion} onChange={(event) => onChange({ ...value, motion: event.target.value as WorkspacePreferences['motion'] })}><option value="system">跟随系统</option><option value="reduced">减少</option><option value="full">完整</option></select></label>
        </div>
      </fieldset>
      <fieldset className="setting-group">
        <legend>工作台布局</legend>
        <div className="setting-grid">
          <label><span>界面密度</span><select value={value.interfaceDensity} onChange={(event) => onChange({ ...value, interfaceDensity: event.target.value as WorkspacePreferences['interfaceDensity'] })}><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></label>
          <label><span>左栏 {value.leftPaneWidth}px</span><input type="range" min="220" max="520" value={value.leftPaneWidth} onChange={(event) => onChange({ ...value, leftPaneWidth: Number(event.target.value) })} /></label>
          <label><span>右栏 {value.rightPaneWidth}px</span><input type="range" min="300" max="760" value={value.rightPaneWidth} onChange={(event) => onChange({ ...value, rightPaneWidth: Number(event.target.value) })} /></label>
        </div>
      </fieldset>
    </div>
  )
}

function ModelSettings({
  models,
  assignments,
  workspace,
  worlds,
  employees,
  draft,
  onChange,
  onSave,
  onAssign,
}: {
  models: ModelProfile[]
  assignments: ModelAssignment[]
  workspace: Workspace
  worlds: World[]
  employees: EmployeeInstance[]
  draft: ModelDraft
  onChange(value: ModelDraft): void
  onSave(): Promise<void>
  onAssign(input: { scope: ModelAssignment['scope']; scopeId: string; modelProfileId?: string }): Promise<void>
}) {
  const assignmentValue = (scope: ModelAssignment['scope'], scopeId: string) =>
    assignments.find((item) => item.scope === scope && item.scopeId === scopeId)?.modelProfileId ?? ''
  const assign = (scope: ModelAssignment['scope'], scopeId: string, modelProfileId: string) =>
    onAssign({ scope, scopeId, ...(modelProfileId ? { modelProfileId } : {}) })
  return (
    <div className="settings-section">
      <div className="settings-section__heading"><h3>模型与路由</h3><p>模型配置保存在本地；密钥只引用环境变量。路由按员工 → 世界 → 工作区逐级继承。</p></div>
      <div className="model-list">{models.map((model) => <article key={model.id}><Cpu size={20} /><div><strong>{model.displayName}</strong><span>{model.modelId} · {providerLabel(model)}</span></div><span>{model.isDefault ? '默认' : model.credentialEnvName ? model.credentialEnvName : '本地可用'}</span></article>)}</div>
      <fieldset className="setting-group"><legend>添加模型提供商</legend><div className="setting-grid">
        <label><span>提供商</span><select value={draft.providerId} onChange={(event) => { const preset = MODEL_PRESETS.find((item) => item.id === event.target.value); if (preset) onChange(modelDraftForPreset(preset)) }}>{MODEL_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
        <label><span>名称</span><input value={draft.displayName} onChange={(event) => onChange({ ...draft, displayName: event.target.value })} /></label>
        <label><span>模型 ID</span><input value={draft.modelId} placeholder={MODEL_PRESETS.find((item) => item.id === draft.providerId)?.modelPlaceholder} onChange={(event) => onChange({ ...draft, modelId: event.target.value })} /></label>
        <label><span>接口协议</span><select value={draft.api} onChange={(event) => onChange({ ...draft, api: event.target.value as ModelApiKind })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
        <label className="setting-grid__wide"><span>Base URL</span><input value={draft.baseUrl} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} /></label>
        <label className="setting-grid__wide"><span>凭据环境变量名（不保存密钥）</span><input value={draft.credentialEnvName} placeholder="PROVIDER_API_KEY" onChange={(event) => onChange({ ...draft, credentialEnvName: event.target.value })} /></label>
        <label><span>上下文窗口</span><input type="number" min="1024" step="1024" value={draft.contextWindow} onChange={(event) => onChange({ ...draft, contextWindow: Number(event.target.value) })} /></label>
        <label><span>最大输出 Token</span><input type="number" min="256" step="256" value={draft.maxTokens} onChange={(event) => onChange({ ...draft, maxTokens: Number(event.target.value) })} /></label>
        <label><span>温度 {draft.temperature.toFixed(1)}</span><input type="range" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => onChange({ ...draft, temperature: Number(event.target.value) })} /></label>
      </div><button className="secondary-button" type="button" disabled={!draft.modelId.trim()} onClick={() => void onSave()}>保存模型配置</button></fieldset>
      <fieldset className="setting-group"><legend>模型分配</legend>
        <div className="model-routing-list">
          <ModelRouteRow label="工作区默认" detail={workspace.name} value={assignmentValue('workspace', workspace.id)} models={models} onChange={(value) => void assign('workspace', workspace.id, value)} />
          {worlds.map((world) => <ModelRouteRow key={world.id} label="世界" detail={world.name} value={assignmentValue('world', world.id)} models={models} onChange={(value) => void assign('world', world.id, value)} />)}
          {employees.map((employee) => <ModelRouteRow key={employee.id} label="员工" detail={`${employee.displayName} · ${employee.role}`} value={assignmentValue('employee', employee.id)} models={models} onChange={(value) => void assign('employee', employee.id, value)} />)}
        </div>
      </fieldset>
    </div>
  )
}

function ModelRouteRow({ label, detail, value, models, onChange }: { label: string; detail: string; value: string; models: ModelProfile[]; onChange(value: string): void }) {
  return <label className="model-route-row"><span><strong>{label}</strong><small>{detail}</small></span><select value={value} disabled={models.length === 0} onChange={(event) => onChange(event.target.value)}><option value="">继承上级 / 默认模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.modelId}</option>)}</select></label>
}

function providerLabel(model: ModelProfile): string {
  const providerId = typeof model.settings.providerId === 'string' ? model.settings.providerId : model.providerKind
  return MODEL_PRESETS.find((preset) => preset.id === providerId)?.label ?? providerId
}

interface ActionSettingsProps {
  pending: SystemAction | undefined
  result: SystemActionResult | undefined
  error: string | undefined
  onRun(action: SystemAction, input?: SystemActionInput): Promise<void>
}

function RuntimeSettings({ pending, result, error, onRun }: ActionSettingsProps) {
  return (
    <ActionSettings title="运行时" copy="独立 DSH profile 仅绑定环回地址。检查会同时验证 Harness 版本、bundle 声明和本地 SQLite。" result={result} error={error}>
      <ActionButton label="检查运行时与数据库" action="status" pending={pending} onRun={onRun} />
    </ActionSettings>
  )
}

function DataSettings({ pending, result, error, onRun }: ActionSettingsProps) {
  return (
    <ActionSettings title="本地数据" copy="SQLite 是本地权威数据源。备份和导出写入当前 DSH Cyber 数据目录，不会覆盖已有文件。" result={result} error={error}>
      <ActionButton label="运行数据库健康检查" action="doctor" pending={pending} onRun={onRun} />
      <ActionButton label="创建时间戳 SQLite 备份" action="backup" pending={pending} onRun={onRun} />
      <ActionButton label="导出可移植 JSON" action="export" pending={pending} onRun={onRun} />
    </ActionSettings>
  )
}

function UpdateSettings({ models, pending, result, error, onRun }: ActionSettingsProps & { models: ModelProfile[] }) {
  const [candidateRoot, setCandidateRoot] = useState('')
  const [modelProfileId, setModelProfileId] = useState(models.find((item) => item.isDefault)?.id ?? models[0]?.id ?? '')
  const [approved, setApproved] = useState(false)
  const transaction = result?.transaction ?? result?.items?.[0]
  return (
    <ActionSettings title="安全更新" copy="候选 DSH 依次经过版本验证、协议测试、真实模型金丝雀和人工批准。启用前自动备份；即使新版本无法启动，也能用命令行恢复内置运行时。" result={result} error={error}>
      <button className="settings-action-button" type="button" disabled={pending !== undefined} onClick={() => void onRun('list-updates')}><span>读取更新记录与当前运行时</span><span>{pending === 'list-updates' ? '读取中…' : '刷新'}</span></button>
      <label className="dialog-field update-candidate-field"><span>候选 DSH 安装目录</span><input value={candidateRoot} placeholder="例如 F:\\runtime\\dsh-candidate" onChange={(event) => setCandidateRoot(event.target.value)} /></label>
      <button className="settings-action-button" type="button" disabled={!candidateRoot.trim() || pending !== undefined} onClick={() => void onRun('verify-update', { candidateRoot: candidateRoot.trim() })}><span>验证候选版本与隔离 profile</span><span>{pending === 'verify-update' ? '验证中…' : '开始验证'}</span></button>
      {transaction?.status === 'verified' ? <button className="settings-action-button" type="button" disabled={pending !== undefined} onClick={() => void onRun('contract-update', { transactionId: transaction.id })}><span>执行协议合同测试</span><span>{pending === 'contract-update' ? '测试中…' : '继续'}</span></button> : null}
      {transaction?.status === 'contract-tested' ? (
        <>
          <label className="dialog-field"><span>金丝雀使用的模型</span><select value={modelProfileId} onChange={(event) => setModelProfileId(event.target.value)}><option value="">请选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.modelId}</option>)}</select></label>
          <button className="settings-action-button" type="button" disabled={!modelProfileId || pending !== undefined} onClick={() => void onRun('canary-update', { transactionId: transaction.id, modelProfileId })}><span>运行两轮真实 Harness 金丝雀</span><span>{pending === 'canary-update' ? '运行中…' : '继续'}</span></button>
        </>
      ) : null}
      {transaction?.status === 'canary-passed' || transaction?.status === 'activated' ? <label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>我已审阅验证结果，并批准{transaction.status === 'activated' ? '回滚' : '启用'}该运行时。</span></label> : null}
      {transaction?.status === 'canary-passed' ? <button className="settings-action-button" type="button" disabled={!approved || pending !== undefined} onClick={() => void onRun('activate-update', { transactionId: transaction.id, approved: true })}><span>备份并启用候选运行时</span><span>{pending === 'activate-update' ? '启用中…' : '启用'}</span></button> : null}
      {transaction?.status === 'activated' ? <button className="settings-action-button" type="button" disabled={!approved || pending !== undefined} onClick={() => void onRun('rollback-update', { transactionId: transaction.id, approved: true })}><span>备份并回滚运行时</span><span>{pending === 'rollback-update' ? '回滚中…' : '回滚'}</span></button> : null}
    </ActionSettings>
  )
}

function ActionSettings({ title, copy, result, error, children }: { title: string; copy: string; result: SystemActionResult | undefined; error: string | undefined; children: ReactNode }) {
  return <div className="settings-section"><div className="settings-section__heading"><h3>{title}</h3><p>{copy}</p></div><div className="settings-action-list">{children}</div>{error === undefined && result === undefined ? null : <SystemResultCard {...(result === undefined ? {} : { result })} {...(error === undefined ? {} : { error })} />}</div>
}

function ActionButton({ label, action, pending, onRun }: { label: string; action: SystemAction; pending: SystemAction | undefined; onRun(action: SystemAction): Promise<void> }) {
  return <button className="settings-action-button" type="button" disabled={pending !== undefined} onClick={() => void onRun(action)}><span>{label}</span><span>{pending === action ? '执行中…' : '执行'}</span></button>
}

function SystemResultCard({ result, error }: { result?: SystemActionResult; error?: string }) {
  if (error !== undefined) return <div className="system-result system-result--error"><strong>操作失败</strong><p>{error}</p></div>
  if (result === undefined) return null
  const version = result.version ?? result.compatibility?.expectedVersion
  const database = result.database
  return (
    <div className={`system-result ${result.ok ? 'system-result--ok' : 'system-result--error'}`}>
      <strong>{result.ok ? '检查通过' : '需要处理'}</strong>
      {version === undefined ? null : <p>Harness 版本：{version}{result.contractId ? ` · ${result.contractId}` : ''}</p>}
      {database === undefined ? null : <p>SQLite schema v{database.schemaVersion ?? '?'} · 完整性 {(database.integrity ?? []).join(', ') || '未知'}</p>}
      {result.output === undefined ? null : <p className="system-result__path">已生成：{result.output}</p>}
      {result.transaction === undefined ? null : <p>更新状态：{result.transaction.status}{result.restartRequired ? ' · 重启后生效' : ''}</p>}
      {result.activeRuntime === undefined ? null : <p>当前候选运行时：{result.activeRuntime.version}</p>}
      {result.items === undefined ? null : <p>更新记录：{result.items.length} 条</p>}
      {(result.errors ?? result.compatibility?.errors ?? database?.errors ?? []).map((item) => <p key={item}>{item}</p>)}
    </div>
  )
}
