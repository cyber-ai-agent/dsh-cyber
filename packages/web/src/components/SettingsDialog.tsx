import {
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  CheckCircle,
  Cpu,
  Database,
  Desktop,
  Eye,
  EyeSlash,
  ImageSquare,
  ListMagnifyingGlass,
  Moon,
  Palette,
  PencilSimple,
  Plus,
  ShieldCheck,
  Sun,
  Trash,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  EmployeeInstance,
  ModelApiKind,
  ModelAssignment,
  ModelInteractionLog,
  ModelInteractionLogFilter,
  ModelInteractionLogPage,
  ModelProfile,
  ModelProviderKind,
  RuntimeUpdateTransaction,
  Workspace,
  WorkspacePreferences,
  World,
} from '@dsh-cyber/contracts'

export type SettingsSection = 'appearance' | 'models' | 'runtime' | 'data' | 'updates' | 'logs'
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
  onSaveModel(profile: ModelProfileSaveDraft): Promise<ModelProfile>
  onDiscoverModels(input: ModelDiscoveryDraft): Promise<DiscoveredModel[]>
  onDeleteModel(modelProfileId: string): Promise<void>
  onAssignModel(input: { scope: ModelAssignment['scope']; scopeId: string; modelProfileId?: string }): Promise<void>
  onSystemAction(action: SystemAction, input?: SystemActionInput): Promise<SystemActionResult>
  onLoadModelLogs(filter: ModelInteractionLogFilter): Promise<ModelInteractionLogPage>
  onClearModelLogs(): Promise<number>
}

export type ModelProfileSaveDraft = Omit<ModelProfile, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'> & {
  id?: string
  apiKey?: string
  clearCredential?: boolean
}

export interface ModelDiscoveryDraft {
  baseUrl: string
  api: ModelApiKind
  profileId?: string
  apiKey?: string
  credentialEnvName?: string
}

export interface DiscoveredModel {
  id: string
  displayName?: string
}

const sections = [
  ['appearance', '外观与个性化', Palette],
  ['models', '模型', Cpu],
  ['logs', '日志记录', ListMagnifyingGlass],
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
  credentialMode: ModelCredentialMode
  modelPlaceholder: string
}

type ModelCredentialMode = 'api-key' | 'environment' | 'none'

interface ModelDraft {
  id?: string
  providerId: string
  displayName: string
  providerKind: ModelProviderKind
  baseUrl: string
  modelId: string
  api: ModelApiKind
  apiKey: string
  credentialMode: ModelCredentialMode
  credentialEnvName: string
  hasStoredApiKey: boolean
  contextWindow: number
  maxTokens: number
  isDefault: boolean
  settings: ModelProfile['settings']
}

const MODEL_PRESETS: readonly ModelProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', providerKind: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', credentialEnvName: 'DEEPSEEK_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', providerKind: 'openai-compatible-remote', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credentialEnvName: 'OPENAI_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'gpt-5' },
  { id: 'anthropic', label: 'Anthropic', providerKind: 'openai-compatible-remote', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', credentialEnvName: 'ANTHROPIC_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'claude-sonnet-4-5' },
  { id: 'gemini', label: 'Google Gemini', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', credentialEnvName: 'GEMINI_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'gemini-2.5-pro' },
  { id: 'openrouter', label: 'OpenRouter', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', credentialEnvName: 'OPENROUTER_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'deepseek/deepseek-chat' },
  { id: 'groq', label: 'Groq', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1', credentialEnvName: 'GROQ_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'llama-3.3-70b-versatile' },
  { id: 'mistral', label: 'Mistral', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://api.mistral.ai/v1', credentialEnvName: 'MISTRAL_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'mistral-large-latest' },
  { id: 'xai', label: 'xAI', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://api.x.ai/v1', credentialEnvName: 'XAI_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'grok-4' },
  { id: 'ollama', label: 'Ollama（本地）', providerKind: 'openai-compatible-local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1', credentialEnvName: '', credentialMode: 'none', modelPlaceholder: 'qwen3:14b' },
  { id: 'lm-studio', label: 'LM Studio（本地）', providerKind: 'openai-compatible-local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1234/v1', credentialEnvName: '', credentialMode: 'none', modelPlaceholder: 'local-model' },
  { id: 'custom-local', label: '自定义（本机或局域网）', providerKind: 'openai-compatible-local', api: 'openai-completions', baseUrl: '', credentialEnvName: 'SUB2API_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'qwen3.5' },
  { id: 'custom-remote', label: '自定义（HTTPS）', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: '', credentialEnvName: 'CUSTOM_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'model-id' },
] as const

function modelDraftForPreset(preset: ModelProviderPreset, isDefault = false): ModelDraft {
  return {
    providerId: preset.id,
    displayName: preset.label,
    providerKind: preset.providerKind,
    baseUrl: preset.baseUrl,
    modelId: '',
    api: preset.api,
    apiKey: '',
    credentialMode: preset.credentialMode,
    credentialEnvName: preset.credentialEnvName,
    hasStoredApiKey: false,
    contextWindow: 64_000,
    maxTokens: 8_192,
    isDefault,
    settings: {},
  }
}

function modelDraftForProfile(profile: ModelProfile): ModelDraft {
  const configuredProviderId = typeof profile.settings.providerId === 'string' ? profile.settings.providerId : undefined
  const fallbackProviderId = profile.providerKind === 'openai-compatible-local' ? 'custom-local' : 'custom-remote'
  const providerId = MODEL_PRESETS.some((preset) => preset.id === configuredProviderId)
    ? configuredProviderId!
    : fallbackProviderId
  const hasStoredApiKey = isManagedCredentialName(profile.credentialEnvName)
  return {
    id: profile.id,
    providerId,
    displayName: profile.displayName,
    providerKind: profile.providerKind,
    baseUrl: profile.baseUrl,
    modelId: profile.modelId,
    api: profile.api,
    apiKey: '',
    credentialMode: hasStoredApiKey ? 'api-key' : profile.credentialEnvName ? 'environment' : 'none',
    credentialEnvName: hasStoredApiKey ? '' : profile.credentialEnvName ?? '',
    hasStoredApiKey,
    contextWindow: modelSettingNumber(profile, 'contextWindow', 64_000),
    maxTokens: modelSettingNumber(profile, 'maxTokens', 8_192),
    isDefault: profile.isDefault,
    settings: profile.settings,
  }
}

function modelSettingNumber(profile: ModelProfile, key: string, fallback: number): number {
  const value = profile.settings[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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
  onDiscoverModels,
  onDeleteModel,
  onAssignModel,
  onSystemAction,
  onLoadModelLogs,
  onClearModelLogs,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [draft, setDraft] = useState(preferences)
  const [uploading, setUploading] = useState(false)
  const [pendingAction, setPendingAction] = useState<SystemAction>()
  const [actionResult, setActionResult] = useState<SystemActionResult>()
  const [actionError, setActionError] = useState<string>()
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
          <div><h2 id="settings-title">设置</h2><p>全局模型、数据和 DSH 运行时。当前世界的个性化请使用左下角“世界设置”。</p></div>
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
                onAssign={onAssignModel}
                onSave={onSaveModel}
                onDiscover={onDiscoverModels}
                onDelete={onDeleteModel}
              />
            ) : null}
            {section === 'logs' ? (
              <ModelInteractionLogSettings
                onLoad={onLoadModelLogs}
                onClear={onClearModelLogs}
              />
            ) : null}
            {section === 'runtime' ? <RuntimeSettings pending={pendingAction} result={actionResult} error={actionError} onRun={runSystemAction} /> : null}
            {section === 'data' ? <DataSettings pending={pendingAction} result={actionResult} error={actionError} onRun={runSystemAction} /> : null}
            {section === 'updates' ? <UpdateSettings models={models} pending={pendingAction} result={actionResult} error={actionError} onRun={runSystemAction} /> : null}
          </div>
        </div>
        <footer className="settings-dialog__footer">
          <span>{section === 'appearance' ? (saving ? '正在保存…' : changed ? '有未保存的外观更改' : '外观设置已同步到本地数据库') : section === 'models' ? '模型配置与路由在当前页面单独保存' : '本地设置与运行状态已同步'}</span>
          <div>
            <button className="text-button" type="button" onClick={onClose}>{section === 'appearance' ? '取消' : '关闭'}</button>
            {section === 'appearance' ? <button className="primary-button" type="button" disabled={!changed || saving} onClick={() => void onSavePreferences(draft)}>保存外观设置</button> : null}
          </div>
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
  onSave,
  onDiscover,
  onDelete,
  onAssign,
}: {
  models: ModelProfile[]
  assignments: ModelAssignment[]
  workspace: Workspace
  worlds: World[]
  employees: EmployeeInstance[]
  onSave(profile: ModelProfileSaveDraft): Promise<ModelProfile>
  onDiscover(input: ModelDiscoveryDraft): Promise<DiscoveredModel[]>
  onDelete(modelProfileId: string): Promise<void>
  onAssign(input: { scope: ModelAssignment['scope']; scopeId: string; modelProfileId?: string }): Promise<void>
}) {
  const [draft, setDraft] = useState<ModelDraft>(() => models[0] ? modelDraftForProfile(models[0]) : modelDraftForPreset(MODEL_PRESETS.find((preset) => preset.id === 'custom-local')!, true))
  const [savingModel, setSavingModel] = useState(false)
  const [deletingModelId, setDeletingModelId] = useState<string>()
  const [modelError, setModelError] = useState<string>()
  const [modelNotice, setModelNotice] = useState<string>()
  const [showApiKey, setShowApiKey] = useState(false)
  const [discoveringModels, setDiscoveringModels] = useState(false)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([])
  const assignmentValue = (scope: ModelAssignment['scope'], scopeId: string) =>
    assignments.find((item) => item.scope === scope && item.scopeId === scopeId)?.modelProfileId ?? ''
  const assign = (scope: ModelAssignment['scope'], scopeId: string, modelProfileId: string) =>
    onAssign({ scope, scopeId, ...(modelProfileId ? { modelProfileId } : {}) })
  const editModel = (profile: ModelProfile) => {
    setDraft(modelDraftForProfile(profile))
    setShowApiKey(false)
    setDiscoveredModels([])
    setModelError(undefined)
    setModelNotice(undefined)
  }
  const startNewModel = () => {
    const custom = MODEL_PRESETS.find((preset) => preset.id === 'custom-local')!
    setDraft(modelDraftForPreset(custom, models.length === 0))
    setShowApiKey(false)
    setDiscoveredModels([])
    setModelError(undefined)
    setModelNotice(undefined)
  }
  const discoverModels = async () => {
    const validationError = validateModelConnection(draft)
    if (validationError !== undefined) {
      setModelError(validationError)
      setModelNotice(undefined)
      return
    }
    setDiscoveringModels(true)
    setModelError(undefined)
    setModelNotice(undefined)
    try {
      const items = await onDiscover({
        baseUrl: draft.baseUrl.trim(),
        api: draft.api,
        ...(draft.id && draft.hasStoredApiKey && !draft.apiKey.trim() ? { profileId: draft.id } : {}),
        ...(draft.credentialMode === 'api-key' && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft.credentialMode === 'environment' ? { credentialEnvName: draft.credentialEnvName.trim() } : {}),
      })
      setDiscoveredModels(items)
      if (!draft.modelId.trim() && items[0]) setDraft((current) => ({ ...current, modelId: items[0]!.id }))
      setModelNotice(`已获取 ${items.length} 个可用模型。`)
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : '模型列表获取失败，请检查接口配置。')
    } finally {
      setDiscoveringModels(false)
    }
  }
  const saveDraft = async () => {
    const validationError = validateModelDraft(draft)
    if (validationError !== undefined) {
      setModelError(validationError)
      setModelNotice(undefined)
      return
    }
    setSavingModel(true)
    setModelError(undefined)
    setModelNotice(undefined)
    try {
      const settings = { ...draft.settings }
      delete settings.temperature
      const credential = draft.credentialMode === 'api-key'
        ? (draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
        : draft.credentialMode === 'environment'
          ? { credentialEnvName: draft.credentialEnvName.trim() }
          : { clearCredential: true }
      const saved = await onSave({
        ...(draft.id ? { id: draft.id } : {}),
        displayName: draft.displayName.trim(),
        providerKind: draft.providerKind,
        baseUrl: draft.baseUrl.trim(),
        modelId: draft.modelId.trim(),
        api: draft.api,
        ...credential,
        isDefault: draft.isDefault || models.length === 0,
        settings: {
          ...settings,
          providerId: draft.providerId,
          contextWindow: draft.contextWindow,
          maxTokens: draft.maxTokens,
        },
      })
      setDraft(modelDraftForProfile(saved))
      setShowApiKey(false)
      setModelNotice(draft.id ? '模型配置已更新并保存。' : '模型配置已添加并保存。')
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : '模型配置保存失败')
    } finally {
      setSavingModel(false)
    }
  }
  const deleteProfile = async (profile: ModelProfile) => {
    if (!window.confirm(`确定删除“${profile.displayName}”吗？相关模型路由会自动恢复为继承上级。`)) return
    setDeletingModelId(profile.id)
    setModelError(undefined)
    setModelNotice(undefined)
    try {
      await onDelete(profile.id)
      if (draft.id === profile.id) startNewModel()
      setModelNotice('模型配置已删除。')
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : '模型配置删除失败')
    } finally {
      setDeletingModelId(undefined)
    }
  }
  return (
    <div className="settings-section settings-section--models">
      <div className="settings-section__heading"><h3>模型与路由</h3><p>API 密钥保存在本机加密凭据库，不写入模型数据库或接口响应。路由按角色 → 世界 → 全局逐级继承。</p></div>
      <div className="model-config-layout">
        <section className="model-profile-panel" aria-label="已保存的模型配置">
          <header><div><h4>模型配置</h4><span>{models.length} 个已保存配置</span></div><button className="secondary-button" type="button" onClick={startNewModel}><Plus size={16} />添加配置</button></header>
          <div className="model-list">
            {models.length === 0 ? <div className="model-list__empty"><Cpu size={22} /><strong>还没有模型配置</strong><span>添加本地、局域网或 HTTPS 模型接口。</span></div> : null}
            {models.map((model) => (
              <article key={model.id} className={draft.id === model.id ? 'is-active' : ''}>
                <Cpu size={22} />
                <div><strong>{model.displayName}</strong><span>{model.modelId}</span><small>{providerLabel(model)} · {credentialSummary(model)}</small></div>
                <div className="model-profile-actions">
                  {model.isDefault ? <span className="model-default-badge"><CheckCircle size={14} />默认</span> : null}
                  <button type="button" aria-label={`编辑${model.displayName}`} onClick={() => editModel(model)}><PencilSimple size={15} />编辑</button>
                  <button className="is-danger" type="button" aria-label={`删除${model.displayName}`} disabled={deletingModelId === model.id} onClick={() => void deleteProfile(model)}><Trash size={15} />{deletingModelId === model.id ? '删除中' : '删除'}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
        <form className="model-editor-panel" aria-label="模型配置编辑器" onSubmit={(event) => { event.preventDefault(); void saveDraft() }}>
          <header><div><h4>{draft.id ? '编辑模型配置' : '添加模型配置'}</h4><p>{draft.id ? '修改后会覆盖当前配置，不会产生重复条目。' : '支持本机、局域网 sub2api 与 HTTPS 服务。'}</p></div>{draft.id ? <button className="text-button" type="button" onClick={startNewModel}>取消编辑</button> : null}</header>
          {modelError ? <p className="model-form-message model-form-message--error" role="alert">{modelError}</p> : null}
          {modelNotice ? <p className="model-form-message model-form-message--success" role="status"><CheckCircle size={16} />{modelNotice}</p> : null}
          <div className="setting-grid model-setting-grid">
            <label><span>提供商类型</span><select value={draft.providerId} onChange={(event) => { const preset = MODEL_PRESETS.find((item) => item.id === event.target.value); if (preset) setDraft({ ...modelDraftForPreset(preset, draft.isDefault), ...(draft.id ? { id: draft.id } : {}) }) }}>{MODEL_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
            <label><span>显示名称</span><input value={draft.displayName} placeholder="例如：公司内网 sub2api" onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
            <label className="setting-grid__wide"><span>接口地址</span><input inputMode="url" value={draft.baseUrl} placeholder={draft.providerKind === 'openai-compatible-local' ? 'http://192.168.1.10:11434/v1' : 'https://api.example.com/v1'} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /><small>本机或局域网可使用 HTTP；公网服务必须使用 HTTPS。</small></label>
            <label><span>接口协议</span><select value={draft.api} onChange={(event) => { setDraft({ ...draft, api: event.target.value as ModelApiKind }); setDiscoveredModels([]) }}><option value="openai-completions">OpenAI 对话补全</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic 消息</option></select></label>
            <label className="setting-grid__wide"><span>模型 ID</span><div className="model-catalog-input"><input list="available-model-options" value={draft.modelId} placeholder={MODEL_PRESETS.find((item) => item.id === draft.providerId)?.modelPlaceholder} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} /><button type="button" disabled={discoveringModels} onClick={() => void discoverModels()}>{discoveringModels ? '正在获取…' : '获取可用模型'}</button></div><datalist id="available-model-options">{discoveredModels.map((model) => <option key={model.id} value={model.id}>{model.displayName ?? model.id}</option>)}</datalist><small>{discoveredModels.length > 0 ? `已加载 ${discoveredModels.length} 个模型，可选择或继续手动填写。` : '可以从服务拉取模型列表，也可以直接手动填写模型 ID。'}</small></label>
            <label className="setting-grid__wide"><span>凭据方式</span><select value={draft.credentialMode} onChange={(event) => setDraft({ ...draft, credentialMode: event.target.value as ModelCredentialMode, apiKey: '' })}><option value="api-key">API 密钥</option><option value="environment">环境变量（高级）</option><option value="none">无需凭据</option></select></label>
            {draft.credentialMode === 'api-key' ? (
              <label className="setting-grid__wide"><span>API 密钥</span><div className="model-secret-input"><input type={showApiKey ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={draft.apiKey} placeholder={draft.hasStoredApiKey ? '已保存；留空保持原密钥' : '输入 sk-... 或服务商提供的密钥'} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><button type="button" aria-label={showApiKey ? '隐藏 API 密钥' : '显示 API 密钥'} onClick={() => setShowApiKey((current) => !current)}>{showApiKey ? <EyeSlash size={18} /> : <Eye size={18} />}</button></div><small>{draft.hasStoredApiKey && !draft.apiKey ? '密钥已加密保存。输入新密钥可替换，留空不会改变。' : '密钥仅发送到本机服务，并加密保存；保存后不再回显明文。'}</small></label>
            ) : null}
            {draft.credentialMode === 'environment' ? (
              <label className="setting-grid__wide"><span>凭据环境变量名</span><input value={draft.credentialEnvName} placeholder="SUB2API_API_KEY" onChange={(event) => setDraft({ ...draft, credentialEnvName: event.target.value })} /><small>高级用法：只保存变量名，运行服务前需要自行设置对应环境变量。</small></label>
            ) : null}
            <label><span>上下文窗口</span><input type="number" min="1024" step="1" value={draft.contextWindow} onChange={(event) => setDraft({ ...draft, contextWindow: Number(event.target.value) })} /></label>
            <label><span>最大输出 Token</span><input type="number" min="256" step="256" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })} /></label>
          </div>
          <label className="model-default-control"><input type="checkbox" checked={draft.isDefault || models.length === 0} disabled={models.length === 0} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} /><span><strong>设为全局默认模型</strong><small>未单独分配模型的世界和角色会使用此配置。</small></span></label>
          <footer><span>{draft.id ? '正在编辑已保存配置' : '新配置保存后立即可用于路由'}</span><button className="primary-button" type="submit" disabled={savingModel}>{savingModel ? '正在保存…' : draft.id ? '保存修改' : '添加并保存'}</button></footer>
        </form>
      </div>
      <fieldset className="setting-group"><legend>模型分配</legend>
        <div className="model-routing-list">
          <ModelRouteRow label="全局默认" detail={workspace.name} value={assignmentValue('workspace', workspace.id)} models={models} onChange={(value) => void assign('workspace', workspace.id, value)} />
          {worlds.map((world) => <ModelRouteRow key={world.id} label="世界" detail={world.name} value={assignmentValue('world', world.id)} models={models} onChange={(value) => void assign('world', world.id, value)} />)}
          {employees.map((employee) => <ModelRouteRow key={employee.id} label="角色" detail={`${employee.displayName} · ${employee.role}`} value={assignmentValue('employee', employee.id)} models={models} onChange={(value) => void assign('employee', employee.id, value)} />)}
        </div>
      </fieldset>
    </div>
  )
}

function ModelInteractionLogSettings({
  onLoad,
  onClear,
}: {
  onLoad(filter: ModelInteractionLogFilter): Promise<ModelInteractionLogPage>
  onClear(): Promise<number>
}) {
  const [status, setStatus] = useState<'' | ModelInteractionLog['status']>('')
  const [modelId, setModelId] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [result, setResult] = useState<ModelInteractionLogPage>()
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string>()
  const [expandedId, setExpandedId] = useState<string>()
  const totalPages = result === undefined ? 0 : Math.max(1, Math.ceil(result.total / result.pageSize))

  const load = async (overrides?: { page?: number; status?: '' | ModelInteractionLog['status']; modelId?: string }) => {
    setLoading(true)
    setError(undefined)
    try {
      const nextStatus = overrides?.status === undefined ? status : overrides.status
      const nextModelId = overrides?.modelId === undefined ? modelId : overrides.modelId
      const nextPage = overrides?.page ?? page
      const data = await onLoad({
        page: nextPage,
        pageSize,
        ...(nextStatus === '' ? {} : { status: nextStatus }),
        ...(nextModelId === '' ? {} : { modelId: nextModelId }),
      })
      setResult(data)
      setPage(data.page)
      setStatus(nextStatus)
      setModelId(nextModelId)
      setExpandedId(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '日志加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // 仅在挂载时加载一次；后续筛选/翻页通过显式调用 load 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearLogs = async () => {
    if (!window.confirm('确定清空全部模型交互日志吗？此操作不可恢复。')) return
    setClearing(true)
    setError(undefined)
    try {
      const removed = await onClear()
      setResult(undefined)
      setExpandedId(undefined)
      if (removed > 0) await load({ page: 1 })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清空日志失败')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section__heading">
        <h3>模型交互日志</h3>
        <p>记录每次模型 API 交互的摘要统计：时间、模型、provider、请求摘要（消息数 / 字符数）、响应状态、耗时与 token 用量。为保护隐私，日志不保存 API 密钥、prompt 明文或响应明文。</p>
      </div>
      <div className="log-toolbar">
        <label className="log-filter"><span>状态</span><select value={status} onChange={(event) => void load({ status: event.target.value as '' | ModelInteractionLog['status'], page: 1 })}><option value="">全部</option><option value="success">成功</option><option value="failed">失败</option></select></label>
        <label className="log-filter"><span>模型</span><select value={modelId} disabled={(result?.modelIds ?? []).length === 0} onChange={(event) => void load({ modelId: event.target.value, page: 1 })}><option value="">全部模型</option>{(result?.modelIds ?? []).map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <div className="log-toolbar__actions">
          <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}><ArrowsClockwise size={16} />{loading ? '刷新中…' : '刷新'}</button>
          <button className="secondary-button is-danger" type="button" disabled={loading || clearing || (result?.total ?? 0) === 0} onClick={() => void clearLogs()}><Trash size={16} />{clearing ? '清空中…' : '清空日志'}</button>
        </div>
      </div>
      {error !== undefined ? <p className="model-form-message model-form-message--error" role="alert">{error}</p> : null}
      {result === undefined ? (
        loading ? <div className="log-empty">正在加载日志…</div> : (
          <div className="log-empty"><ListMagnifyingGlass size={24} /><strong>还没有模型交互日志</strong><span>发起一次对话，或在模型设置中获取可用模型列表后，这里会显示真实交互记录。</span></div>
        )
      ) : result.items.length === 0 ? (
        <div className="log-empty"><ListMagnifyingGlass size={24} /><strong>{result.total === 0 ? '还没有模型交互日志' : '没有符合条件的日志'}</strong><span>{result.total === 0 ? '发起一次对话，或在模型设置中获取可用模型列表后，这里会显示真实交互记录。' : '请调整状态或模型筛选条件。'}</span></div>
      ) : (
        <>
          <div className="log-list" aria-label="模型交互日志列表">
            {result.items.map((log) => {
              const expanded = expandedId === log.id
              return (
                <article key={log.id} className={`log-entry${expanded ? ' is-expanded' : ''}`}>
                  <button className="log-entry__row" type="button" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? undefined : log.id)}>
                    <span className="log-entry__time">{formatLogTime(log.createdAt)}</span>
                    <span className="log-entry__model"><strong>{log.modelId}</strong><small>{log.provider}</small></span>
                    <span className="log-entry__source">{log.source === 'turn' ? '对话回合' : '模型发现'}</span>
                    <span className={log.status === 'success' ? 'log-status log-status--success' : 'log-status log-status--failed'}>{log.status === 'success' ? '成功' : '失败'}</span>
                    <span className="log-entry__http">{log.httpStatus === undefined ? '' : `HTTP ${log.httpStatus}`}</span>
                    <span className="log-entry__duration">{formatDuration(log.durationMs)}</span>
                    <span className="log-entry__tokens">{tokensSummary(log)}</span>
                    <i className="log-entry__toggle">{expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}</i>
                  </button>
                  {expanded ? <LogDetail log={log} /> : null}
                </article>
              )
            })}
          </div>
          <footer className="log-pagination">
            <span>共 {result.total} 条 · 第 {result.page} / {totalPages} 页</span>
            <div>
              <button className="text-button" type="button" disabled={loading || result.page <= 1} onClick={() => void load({ page: result.page - 1 })}>上一页</button>
              <button className="text-button" type="button" disabled={loading || result.page >= totalPages} onClick={() => void load({ page: result.page + 1 })}>下一页</button>
            </div>
          </footer>
        </>
      )}
    </div>
  )
}

function LogDetail({ log }: { log: ModelInteractionLog }) {
  return (
    <div className="log-detail">
      <dl>
        <div><dt>模型</dt><dd>{log.modelId}</dd></div>
        <div><dt>提供商</dt><dd>{log.provider}</dd></div>
        <div><dt>交互类型</dt><dd>{log.source === 'turn' ? '对话回合（服务端整轮交互）' : '/models 模型发现'}</dd></div>
        <div><dt>状态</dt><dd>{log.status === 'success' ? '成功' : '失败'}{log.errorCode === undefined ? '' : ` · ${log.errorCode}`}</dd></div>
        <div><dt>HTTP 状态码</dt><dd>{log.httpStatus === undefined ? '—' : log.httpStatus}</dd></div>
        <div><dt>耗时</dt><dd>{log.durationMs} ms</dd></div>
        <div><dt>请求摘要</dt><dd>{log.promptMessageCount} 条消息 · {log.promptCharCount} 字符（不含原文）</dd></div>
        <div><dt>工具调用</dt><dd>{log.toolCallCount ?? 0} 次</dd></div>
        <div><dt>响应摘要</dt><dd>{log.responseCharCount === undefined ? '—' : `${log.responseCharCount} 字符（不含原文）`}</dd></div>
        <div><dt>Token 用量</dt><dd>{log.tokensPrompt === undefined ? '接口未返回' : `输入 ${log.tokensPrompt} · 输出 ${log.tokensCompletion ?? 0} · 合计 ${log.tokensTotal ?? 0}`}</dd></div>
        <div><dt>记录时间</dt><dd>{formatLogTime(log.createdAt, true)}</dd></div>
      </dl>
      {log.errorMessage !== undefined && log.errorMessage !== '' ? <p className="log-detail__error"><strong>错误信息</strong>{log.errorMessage}</p> : null}
    </div>
  )
}

function formatLogTime(value: string, full = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  if (full) return date.toLocaleString('zh-CN', { hour12: false })
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value} ms`
  return `${(value / 1_000).toFixed(1)} s`
}

function tokensSummary(log: ModelInteractionLog): string {
  if (log.tokensTotal === undefined) return '—'
  return `Token ${log.tokensTotal.toLocaleString('zh-CN')}`
}

function validateModelDraft(draft: ModelDraft): string | undefined {
  if (!draft.displayName.trim()) return '请输入模型配置名称。'
  const connectionError = validateModelConnection(draft)
  if (connectionError !== undefined) return connectionError
  if (!draft.modelId.trim()) return '请输入模型 ID。'
  if (!Number.isInteger(draft.contextWindow) || draft.contextWindow < 1_024) return '上下文窗口必须是不小于 1024 的整数。'
  if (!Number.isInteger(draft.maxTokens) || draft.maxTokens < 256) return '最大输出 Token 必须是不小于 256 的整数。'
  return undefined
}

function validateModelConnection(draft: ModelDraft): string | undefined {
  if (!draft.baseUrl.trim()) return '请输入模型接口地址。'
  try {
    new URL(draft.baseUrl.trim())
  } catch {
    return '模型接口地址格式不正确。'
  }
  if (draft.credentialMode === 'api-key' && !draft.apiKey.trim() && !draft.hasStoredApiKey) return '请输入 API 密钥，或将凭据方式改为“无需凭据”。'
  if (draft.credentialMode === 'environment' && !/^[A-Z_][A-Z0-9_]*$/.test(draft.credentialEnvName.trim())) return '凭据环境变量名只能使用大写字母、数字和下划线，且不能以数字开头。'
  return undefined
}

function ModelRouteRow({ label, detail, value, models, onChange }: { label: string; detail: string; value: string; models: ModelProfile[]; onChange(value: string): void }) {
  return <label className="model-route-row"><span><strong>{label}</strong><small>{detail}</small></span><select value={value} disabled={models.length === 0} onChange={(event) => onChange(event.target.value)}><option value="">继承上级 / 默认模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.modelId}</option>)}</select></label>
}

function providerLabel(model: ModelProfile): string {
  const providerId = typeof model.settings.providerId === 'string' ? model.settings.providerId : model.providerKind
  return MODEL_PRESETS.find((preset) => preset.id === providerId)?.label ?? providerId
}

function credentialSummary(model: ModelProfile): string {
  if (isManagedCredentialName(model.credentialEnvName)) return 'API 密钥已保存'
  if (model.credentialEnvName) return `环境变量：${model.credentialEnvName}`
  return '无需凭据'
}

function isManagedCredentialName(value: string | undefined): boolean {
  return value?.startsWith('DSH_CYBER_MODEL_KEY_') ?? false
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
    <ActionSettings title="本地数据" copy="SQLite 是本地权威数据源。备份会生成包含世界数据的本地 Bundle，导出写入当前 DSH Cyber 数据目录，不会覆盖已有文件。" result={result} error={error}>
      <ActionButton label="运行数据库健康检查" action="doctor" pending={pending} onRun={onRun} />
      <ActionButton label="创建本地数据备份 Bundle" action="backup" pending={pending} onRun={onRun} />
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
