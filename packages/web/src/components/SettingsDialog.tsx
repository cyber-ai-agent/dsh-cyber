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
  LockKey,
  Moon,
  Palette,
  PencilSimple,
  Plug,
  Plus,
  ShieldCheck,
  Sun,
  Trash,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { WORKSPACE_PREFERENCES_LIMITS } from '@dsh-cyber/contracts'
import type {
  EmployeeInstance,
  IntegrationConnection,
  IntegrationDescriptor,
  IntegrationHealth,
  JsonObject,
  ModelApiKind,
  ModelAssignment,
  ModelInteractionLog,
  ModelInteractionLogFilter,
  ModelInteractionLogPage,
  ModelProfile,
  ModelProviderKind,
  Workspace,
  WorkspacePreferences,
  World,
} from '@dsh-cyber/contracts'
import { api } from '../api.js'
import { setUiLocale, UI_LOCALES, useI18n } from '../i18n/runtime.js'
import { formatDateTime, formatDuration as localeFormatDuration, formatNumber } from '../i18n/format.js'
import type { ApplicationAccessSummary } from './ApplicationLockGate.js'

interface ApplicationAccessMutation extends ApplicationAccessSummary { recoveryCode?: string }

export type SettingsSection = 'appearance' | 'models' | 'integrations' | 'privacy' | 'data' | 'logs' | 'maintenance'
export type SystemAction = 'status' | 'doctor' | 'backup' | 'export' | 'check-application-update' | 'apply-application-update'

export interface SystemActionInput {
  approved?: boolean
}

export interface ApplicationUpdateStatus {
  supported: boolean
  channel: 'main'
  branch?: string
  currentRevision?: string
  targetRevision?: string
  commitsBehind?: number
  updateAvailable?: boolean
  reason?: string
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
  applicationUpdate?: ApplicationUpdateStatus
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

const sectionGroups = [
  {
    label: '常用设置',
    items: [
      ['appearance', '外观与布局', Palette, '颜色、背景和面板宽度'],
      ['models', 'AI 模型', Cpu, '连接模型并设置使用范围'],
      ['integrations', '外部连接', Plug, '管理角色可使用的受信任服务'],
      ['privacy', '隐私与锁屏', LockKey, '保护整个本地工作台'],
    ],
  },
  {
    label: '数据与记录',
    items: [
      ['data', '数据与备份', Database, '备份或导出本机数据'],
      ['logs', '使用记录', ListMagnifyingGlass, '查看模型调用与错误'],
    ],
  },
  {
    label: '高级',
    items: [
      ['maintenance', '应用更新', ShieldCheck, '安全检查并安装新版本'],
    ],
  },
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
  webSearchBaseUrl?: string
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
  webSearchEnabled: boolean
  webSearchBaseUrl: string
  isDefault: boolean
  settings: ModelProfile['settings']
}

const MODEL_PRESETS: readonly ModelProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', providerKind: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', credentialEnvName: 'DEEPSEEK_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'deepseek-chat', webSearchBaseUrl: 'https://api.deepseek.com/anthropic/v1' },
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
    webSearchEnabled: preset.webSearchBaseUrl !== undefined,
    webSearchBaseUrl: preset.webSearchBaseUrl ?? '',
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
    webSearchEnabled: profile.settings.webSearchEnabled === true,
    webSearchBaseUrl: typeof profile.settings.webSearchBaseUrl === 'string'
      ? profile.settings.webSearchBaseUrl
      : '',
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
  const { t } = useI18n()
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [draft, setDraft] = useState(preferences)
  const [uploading, setUploading] = useState(false)
  const [pendingAction, setPendingAction] = useState<SystemAction>()
  const [actionResult, setActionResult] = useState<SystemActionResult>()
  const [actionError, setActionError] = useState<string>()
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(preferences), [draft, preferences])
  const close = () => { setUiLocale(preferences.locale); onClose() }
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
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-dialog__header">
          <div><h2 id="settings-title">{t('settings.title', '设置')}</h2><p>{t('settings.intro', '管理界面、AI 模型、数据备份与应用维护。')}</p></div>
          <button className="icon-button" type="button" aria-label={t('settings.close', '关闭设置')} onClick={close}><X size={18} /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置栏目">
            {sectionGroups.map((group, groupIndex) => (
              <div className="settings-nav__group" key={group.label}>
                <span className="settings-nav__label">{t((['settings.group.common', 'settings.group.data', 'settings.group.advanced'] as const)[groupIndex]!, group.label)}</span>
                {group.items.map(([id, label, Icon, description]) => (
                  <button key={id} type="button" className={section === id ? 'is-active' : ''} onClick={() => setSection(id)}>
                    <Icon size={18} />
                    <span><strong>{t(`settings.${id}`, label)}</strong><small>{t(`settings.${id}Description`, description)}</small></span>
                  </button>
                ))}
              </div>
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
            {section === 'integrations' ? <IntegrationSettings workspaceId={workspace.id} /> : null}
            {section === 'privacy' ? <PrivacySettings /> : null}
            {section === 'logs' ? (
              <ModelInteractionLogSettings
                onLoad={onLoadModelLogs}
                onClear={onClearModelLogs}
              />
            ) : null}
            {section === 'data' ? <DataSettings pending={pendingAction} result={actionResult} error={actionError} onRun={runSystemAction} /> : null}
            {section === 'maintenance' ? <MaintenanceSettings pending={pendingAction} result={actionResult} error={actionError} onRun={runSystemAction} /> : null}
          </div>
        </div>
        <footer className="settings-dialog__footer">
          <span>{section === 'appearance' ? (saving ? t('settings.saving', '正在保存…') : changed ? t('settings.unsaved', '有未保存的外观更改') : t('settings.saved', '外观设置已保存')) : t(`settings.${section}Description`, '')}</span>
          <div>
            <button className="text-button" type="button" onClick={close}>{section === 'appearance' ? t('common.cancel', '取消') : t('common.close', '关闭')}</button>
            {section === 'appearance' ? <button className="primary-button" type="button" disabled={!changed || saving} onClick={() => void onSavePreferences(draft)}>{t('settings.saveAppearance', '保存外观设置')}</button> : null}
          </div>
        </footer>
      </section>
    </div>
  )
}

function IntegrationSettings({ workspaceId }: { workspaceId: string }) {
  const [descriptors, setDescriptors] = useState<IntegrationDescriptor[]>([])
  const [connections, setConnections] = useState<IntegrationConnection[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [config, setConfig] = useState<JsonObject>({})
  const [credential, setCredential] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [health, setHealth] = useState<IntegrationHealth>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = async () => {
    const result = await api<{ descriptors: IntegrationDescriptor[]; items: IntegrationConnection[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/integrations`)
    setDescriptors(result.descriptors)
    setConnections(result.items)
    setSelectedId((current) => current ?? result.descriptors[0]?.id)
  }

  useEffect(() => {
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '外部连接加载失败'))
    // load only changes local connection state for the selected workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  const descriptor = descriptors.find((item) => item.id === selectedId)
  const connection = connections.find((item) => item.integrationId === selectedId)
  useEffect(() => {
    setConfig(Object.fromEntries((descriptor?.configFields ?? []).map((field) => [
      field.id,
      connection?.config[field.id] ?? (field.kind === 'boolean' ? false : field.kind === 'number' ? 0 : field.placeholder ?? ''),
    ])) as JsonObject)
    setEnabled(connection?.enabled ?? true)
    setCredential('')
    setHealth(undefined)
  }, [connection?.id, descriptor?.id])

  const save = async () => {
    if (descriptor === undefined) return
    setBusy(true); setError(undefined); setHealth(undefined)
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ config, enabled, ...(credential.trim() ? { credential: credential.trim() } : {}) }),
      })
      await load()
      setCredential('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接保存失败')
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (descriptor === undefined) return
    setBusy(true); setError(undefined)
    try {
      const result = await api<{ health: IntegrationHealth }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}/test`, { method: 'POST', body: '{}' })
      setHealth(result.health)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接测试失败')
    } finally {
      setBusy(false)
    }
  }

  const requiredConfigMissing = descriptor?.configFields.some((field) => field.required && String(config[field.id] ?? '').trim() === '') ?? true

  return <div className="settings-section settings-section--integrations">
    <div className="settings-section__heading"><h3>外部连接</h3><p>统一管理受信任服务。安装 Skill 只声明能力，角色获得授权后仍需经过审批策略才能发送数据。</p></div>
    <div className="integration-provider-list" role="list">
      {descriptors.map((item) => <button key={item.id} type="button" className={item.id === selectedId ? 'is-active' : ''} onClick={() => setSelectedId(item.id)}><strong>{item.displayName}</strong><small>{item.summary}</small></button>)}
    </div>
    {descriptor === undefined ? <div className="dialog-empty">当前没有可配置的外部连接。</div> : <section className="integration-editor">
      <header><div><h4>{descriptor.displayName}</h4><p>{descriptor.summary}</p></div><label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用连接</label></header>
      {descriptor.configFields.map((field) => field.kind === 'boolean' ? (
        <label className="dialog-field dialog-field--checkbox" key={field.id}><input type="checkbox" checked={config[field.id] === true} onChange={(event) => setConfig((current) => ({ ...current, [field.id]: event.target.checked }))} /><span>{field.displayName}</span><small>{field.description}</small></label>
      ) : (
        <label className="dialog-field" key={field.id}><span>{field.displayName}</span><input type={field.kind === 'number' ? 'number' : 'text'} value={String(config[field.id] ?? '')} placeholder={field.placeholder} onChange={(event) => setConfig((current) => ({ ...current, [field.id]: field.kind === 'number' ? Number(event.target.value) : event.target.value }))} /><small>{field.description}</small></label>
      ))}
      {descriptor.secretFields.map((field) => <label className="dialog-field" key={field.id}><span>{field.displayName}</span><input type="password" autoComplete="new-password" value={credential} placeholder={connection?.credentialConfigured ? '已加密保存；留空保持不变' : field.required ? '请输入连接凭据' : '可选'} onChange={(event) => setCredential(event.target.value)} /><small>{field.description}</small></label>)}
      <div className="integration-egress"><strong>会发送到外部服务</strong><span>{descriptor.dataEgress.join('、') || '无'}</span></div>
      {error ? <p className="model-form-message model-form-message--error" role="alert">{error}</p> : null}
      {health ? <p className={health.status === 'ready' ? 'model-form-message model-form-message--success' : 'model-form-message model-form-message--error'} role="status">{health.detail} · {health.latencyMs} ms</p> : null}
      <footer><button className="secondary-button" type="button" disabled={busy || connection === undefined} onClick={() => void test()}>测试连接</button><button className="primary-button" type="button" disabled={busy || requiredConfigMissing} onClick={() => void save()}>{busy ? '处理中…' : '保存连接'}</button></footer>
    </section>}
  </div>
}

function PrivacySettings() {
  const [access, setAccess] = useState<ApplicationAccessSummary>()
  const [recoveryCode, setRecoveryCode] = useState<string>()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    void api<{ access: ApplicationAccessSummary }>('/api/application-access')
      .then((result) => setAccess(result.access))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '锁屏状态读取失败'))
  }, [])

  const savePassword = async () => {
    if (password.length < 6) { setError('密码至少需要 6 个字符'); return }
    if (password !== confirmation) { setError('两次输入的密码不一致'); return }
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await api<{ access: ApplicationAccessMutation }>('/api/application-access/password', { method: 'POST', body: JSON.stringify({ password }) })
      setAccess(result.access); setRecoveryCode(result.access.recoveryCode); setPassword(''); setConfirmation(''); setNotice('应用锁密码已保存，请保存新的恢复码')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '密码保存失败')
    } finally { setBusy(false) }
  }
  const removePassword = async () => {
    if (!window.confirm('确定关闭应用锁吗？之后启动时将直接进入工作台。')) return
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await api<{ access: ApplicationAccessSummary }>('/api/application-access/password', { method: 'DELETE' })
      setAccess(result.access); setRecoveryCode(undefined); setNotice('应用锁已关闭')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '应用锁关闭失败')
    } finally { setBusy(false) }
  }
  const lockNow = async () => {
    setBusy(true); setError(undefined)
    try {
      await api('/api/application-access/lock', { method: 'POST', body: '{}' })
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '锁定失败')
      setBusy(false)
    }
  }

  return <div className="settings-section settings-section--privacy">
    <div className="settings-section__heading"><h3>隐私与锁屏</h3><p>这里只有一个全局入口锁。锁定后会遮住整个工作台，切换世界不会额外要求密码。</p></div>
    <section className="privacy-lock-card">
      <header><span><LockKey size={22}/></span><div><strong>{access?.passwordEnabled ? '应用锁已启用' : '应用锁未启用'}</strong><small>{access?.passwordEnabled ? '每次服务启动和会话过期后都需要重新解锁。' : '设置后可从这里立即锁定整个 DSH Cyber。世界切换不会另设密码。'}</small></div></header>
      <div className="privacy-lock-fields">
        <label><span>{access?.passwordEnabled ? '新密码' : '密码'}</span><input type="password" autoComplete="new-password" value={password} placeholder="至少 6 个字符" onChange={(event) => setPassword(event.target.value)} /></label>
        <label><span>再次输入</span><input type="password" autoComplete="new-password" value={confirmation} placeholder="重复输入密码" onChange={(event) => setConfirmation(event.target.value)} /></label>
      </div>
      {access?.passwordEnabled ? <p className="privacy-recovery-status">{access.recoveryConfigured ? '恢复码已配置。忘记密码时可在入口锁屏使用；更改密码会生成新的恢复码。' : '这个入口锁来自旧版本。输入当前密码并保存一次即可生成恢复码。'}</p> : null}
      {recoveryCode ? <div className="privacy-recovery-code" role="status"><CheckCircle size={18}/><span><strong>请保存恢复码</strong><code>{recoveryCode}</code><small>忘记密码时使用。恢复码只在本次保存后显示，离开页面后无法再次查看。</small></span><button className="secondary-button" type="button" onClick={() => void navigator.clipboard?.writeText(recoveryCode)}>复制</button></div> : null}
      {access?.passwordEnabled && !access.recoveryConfigured ? <p className="model-form-message model-form-message--error" role="alert">这个应用锁来自旧版本，没有恢复码。请先输入当前密码并保存一次新密码，生成恢复码。</p> : null}
      {error ? <p className="model-form-message model-form-message--error" role="alert">{error}</p> : null}
      {notice ? <p className="model-form-message model-form-message--success" role="status"><CheckCircle size={16}/>{notice}</p> : null}
      <footer><div>{access?.passwordEnabled ? <button className="text-button is-danger" type="button" disabled={busy} onClick={() => void removePassword()}>关闭应用锁</button> : null}</div><div>{access?.passwordEnabled ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void lockNow()}>立即锁定</button> : null}<button className="primary-button" type="button" disabled={busy || password.length < 6 || confirmation.length < 6} onClick={() => void savePassword()}>{busy ? '处理中…' : access?.passwordEnabled ? '更改密码' : '启用应用锁'}</button></div></footer>
    </section>
  </div>
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
  const { t } = useI18n()
  return (
    <div className="settings-section">
      <div className="settings-section__heading"><h3>外观与布局</h3><p>调整颜色模式、背景和工作区布局。皮肤请前往扩展市场选择。</p></div>
      <fieldset className="setting-group locale-setting">
        <legend>{t('settings.language.title', '语言与地区')}</legend>
        <p>{t('settings.language.description', '选择界面语言。更改会立即预览，并在保存后同步到当前工作区。')}</p>
        <label><span>{t('settings.language.label', '界面语言')}</span><select value={value.locale} onChange={(event) => { const locale = event.target.value as WorkspacePreferences['locale']; setUiLocale(locale); onChange({ ...value, locale }) }}>{UI_LOCALES.map((locale) => <option key={locale.id} value={locale.id}>{locale.nativeName}</option>)}</select><small>{t('settings.language.hint', '日期、数字、状态和产品文案会使用同一语言；技术标识保持原样。')}</small></label>
      </fieldset>
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
      <details className="settings-disclosure appearance-advanced">
        <summary><span><strong>更多外观选项</strong><small>自定义背景、动效、信息密度和面板宽度</small></span><CaretDown size={16} /></summary>
        <div className="settings-disclosure__content appearance-advanced__content">
          <fieldset className="setting-group">
            <legend>自定义背景</legend>
            <label className="background-upload">
              <ImageSquare size={24} />
              <span><strong>{uploading ? '正在保存到本地…' : '上传 PNG、JPEG 或 WebP'}</strong><small>最大 5 MiB。文件只保存在本机，并作为当前世界的场景底图。</small></span>
              <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUpload(file) }} />
            </label>
            <div className="setting-grid">
              <label><span>适配方式</span><select value={value.backgroundFit} onChange={(event) => onChange({ ...value, backgroundFit: event.target.value as WorkspacePreferences['backgroundFit'] })}><option value="cover">铺满</option><option value="contain">完整显示</option><option value="tile">平铺</option></select></label>
              <label><span>背景透明度</span><input type="range" min="0" max="0.6" step="0.02" value={value.backgroundOpacity} onChange={(event) => onChange({ ...value, backgroundOpacity: Number(event.target.value) })} /></label>
              <label><span>动效</span><select value={value.motion} onChange={(event) => onChange({ ...value, motion: event.target.value as WorkspacePreferences['motion'] })}><option value="system">跟随系统</option><option value="reduced">减少</option><option value="full">完整</option></select></label>
            </div>
          </fieldset>
          <fieldset className="setting-group">
            <legend>工作台布局</legend>
            <div className="setting-grid">
              <label><span>界面密度</span><select value={value.interfaceDensity} onChange={(event) => onChange({ ...value, interfaceDensity: event.target.value as WorkspacePreferences['interfaceDensity'] })}><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></label>
              <label><span>左栏 {value.leftPaneWidth}px</span><input type="range" min={WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.minimum} max={WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.maximum} value={value.leftPaneWidth} onChange={(event) => onChange({ ...value, leftPaneWidth: Number(event.target.value) })} /></label>
              <label><span>右栏 {value.rightPaneWidth}px</span><input type="range" min={WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.minimum} max={WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.maximum} value={value.rightPaneWidth} onChange={(event) => onChange({ ...value, rightPaneWidth: Number(event.target.value) })} /></label>
            </div>
          </fieldset>
        </div>
      </details>
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
  const [manualModelId, setManualModelId] = useState(true)
  const assignmentValue = (scope: ModelAssignment['scope'], scopeId: string) =>
    assignments.find((item) => item.scope === scope && item.scopeId === scopeId)?.modelProfileId ?? ''
  const assign = (scope: ModelAssignment['scope'], scopeId: string, modelProfileId: string) =>
    onAssign({ scope, scopeId, ...(modelProfileId ? { modelProfileId } : {}) })
  const editModel = (profile: ModelProfile) => {
    setDraft(modelDraftForProfile(profile))
    setShowApiKey(false)
    setDiscoveredModels([])
    setManualModelId(true)
    setModelError(undefined)
    setModelNotice(undefined)
  }
  const startNewModel = () => {
    const custom = MODEL_PRESETS.find((preset) => preset.id === 'custom-local')!
    setDraft(modelDraftForPreset(custom, models.length === 0))
    setShowApiKey(false)
    setDiscoveredModels([])
    setManualModelId(true)
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
      if (items[0]) {
        const selected = items.some((item) => item.id === draft.modelId.trim())
          ? draft.modelId.trim()
          : items[0].id
        setDraft((current) => ({ ...current, modelId: selected }))
        setManualModelId(false)
      }
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
          webSearchEnabled: draft.webSearchEnabled,
          ...(draft.webSearchEnabled ? { webSearchBaseUrl: draft.webSearchBaseUrl.trim() } : {}),
        },
      })
      setDraft(modelDraftForProfile(saved))
      setShowApiKey(false)
      setModelNotice(draft.id ? '模型连接已更新。' : '模型已连接并保存。')
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
      setModelNotice('模型连接已删除。')
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : '模型配置删除失败')
    } finally {
      setDeletingModelId(undefined)
    }
  }
  return (
    <div className="settings-section settings-section--models">
      <div className="settings-section__heading"><h3>AI 模型</h3><p>连接你使用的模型服务。保存后可设为默认，也可单独分配给某个世界或角色；API 密钥只加密保存在当前设备。</p></div>
      <div className="model-config-layout">
        <section className="model-profile-panel" aria-label="已保存的模型配置">
          <header><div><h4>已连接的模型</h4><span>{models.length === 0 ? '还没有可用模型' : `共 ${models.length} 个`}</span></div><button className="secondary-button" type="button" onClick={startNewModel}><Plus size={16} />连接模型</button></header>
          <div className="model-list">
            {models.length === 0 ? <div className="model-list__empty"><Cpu size={22} /><strong>还没有连接模型</strong><span>连接云端服务、本机模型或局域网模型服务。</span><button className="secondary-button" type="button" onClick={startNewModel}>连接第一个模型</button></div> : null}
            {models.map((model) => (
              <article key={model.id} className={draft.id === model.id ? 'is-active' : ''}>
                <Cpu size={22} />
                <div><strong>{model.displayName}</strong><span>{model.modelId}</span><small>{providerLabel(model)} · {credentialSummary(model)} · {model.settings.webSearchEnabled === true ? '联网搜索已启用' : '未启用联网搜索'}</small></div>
                <div className="model-profile-actions">
                  {model.isDefault ? <span className="model-default-badge"><CheckCircle size={14} />默认</span> : null}
                  <button type="button" aria-label={`编辑${model.displayName}`} onClick={() => editModel(model)}><PencilSimple size={15} />编辑</button>
                  <button className="is-danger" type="button" aria-label={`删除${model.displayName}`} disabled={deletingModelId === model.id} onClick={() => void deleteProfile(model)}><Trash size={15} />{deletingModelId === model.id ? '删除中' : '删除'}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
        <form className="model-editor-panel" aria-label="模型连接编辑器" onSubmit={(event) => { event.preventDefault(); void saveDraft() }}>
          <header><div><h4>{draft.id ? '编辑模型连接' : '连接模型服务'}</h4><p>{draft.id ? '保存后直接更新这条连接，不会产生重复项。' : '选择服务商，填写地址和密钥，再选择要使用的模型。'}</p></div>{draft.id ? <button className="text-button" type="button" onClick={startNewModel}>退出编辑</button> : null}</header>
          {modelError ? <p className="model-form-message model-form-message--error" role="alert">{modelError}</p> : null}
          {modelNotice ? <p className="model-form-message model-form-message--success" role="status"><CheckCircle size={16} />{modelNotice}</p> : null}
          <div className="setting-grid model-setting-grid">
            <label><span>模型服务</span><select value={draft.providerId} onChange={(event) => { const preset = MODEL_PRESETS.find((item) => item.id === event.target.value); if (preset) { setDraft({ ...modelDraftForPreset(preset, draft.isDefault), ...(draft.id ? { id: draft.id } : {}) }); setDiscoveredModels([]); setManualModelId(true) } }}>{MODEL_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
            <label><span>连接名称</span><input value={draft.displayName} placeholder="例如：公司的 AI 服务" onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
            <label className="setting-grid__wide"><span>服务地址</span><input inputMode="url" value={draft.baseUrl} placeholder={draft.providerKind === 'openai-compatible-local' ? 'http://192.168.1.10:11434/v1' : 'https://api.example.com/v1'} onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }); setDiscoveredModels([]); setManualModelId(true) }} /><small>本机或局域网服务可以使用 HTTP，公网服务必须使用 HTTPS。</small></label>
            {draft.credentialMode === 'api-key' ? (
              <label className="setting-grid__wide"><span>API 密钥</span><div className="model-secret-input"><input type={showApiKey ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={draft.apiKey} placeholder={draft.hasStoredApiKey ? '已保存；留空保持原密钥' : '输入 sk-... 或服务商提供的密钥'} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><button type="button" aria-label={showApiKey ? '隐藏 API 密钥' : '显示 API 密钥'} onClick={() => setShowApiKey((current) => !current)}>{showApiKey ? <EyeSlash size={18} /> : <Eye size={18} />}</button></div><small>{draft.hasStoredApiKey && !draft.apiKey ? '密钥已加密保存。输入新密钥可替换，留空不会改变。' : '密钥仅发送到本机服务，并加密保存；保存后不再回显明文。'}</small></label>
            ) : null}
            <div className="model-field setting-grid__wide"><span>模型 ID</span><div className="model-catalog-input">{discoveredModels.length > 0 && !manualModelId ? <SearchableModelPicker models={discoveredModels} value={draft.modelId} onChange={(modelId) => setDraft({ ...draft, modelId })} /> : <input aria-label="模型 ID" value={draft.modelId} placeholder={MODEL_PRESETS.find((item) => item.id === draft.providerId)?.modelPlaceholder} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} />}<button type="button" disabled={discoveringModels} onClick={() => void discoverModels()}>{discoveringModels ? '正在获取…' : '获取可用模型'}</button></div>{discoveredModels.length > 0 ? <button className="model-catalog-mode" type="button" onClick={() => { if (manualModelId && discoveredModels[0]) setDraft((current) => ({ ...current, modelId: discoveredModels.some((item) => item.id === current.modelId) ? current.modelId : discoveredModels[0]!.id })); setManualModelId((current) => !current) }}>{manualModelId ? '从已获取列表选择' : '手动填写其他模型 ID'}</button> : null}<small>{discoveredModels.length > 0 ? `已获取 ${discoveredModels.length} 个模型，可按名称或 ID 搜索。` : draft.credentialMode === 'api-key' && !draft.apiKey.trim() && !draft.hasStoredApiKey ? '先填写 API 密钥，再获取模型列表。' : '获取服务提供的模型列表，或切换为手动填写。'}</small></div>
            <details className="settings-disclosure setting-grid__wide">
              <summary><span><strong>高级连接设置</strong><small>接口兼容方式、环境变量和模型容量</small></span><CaretDown size={16} /></summary>
              <div className="setting-grid settings-disclosure__content">
                <label><span>接口兼容方式</span><select value={draft.api} onChange={(event) => { setDraft({ ...draft, api: event.target.value as ModelApiKind }); setDiscoveredModels([]); setManualModelId(true) }}><option value="openai-completions">OpenAI 对话补全</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic 消息</option></select></label>
                <label><span>密钥来源</span><select value={draft.credentialMode} onChange={(event) => setDraft({ ...draft, credentialMode: event.target.value as ModelCredentialMode, apiKey: '' })}><option value="api-key">直接填写 API 密钥</option><option value="environment">从环境变量读取</option><option value="none">此服务无需密钥</option></select></label>
                {draft.credentialMode === 'environment' ? (
                  <label className="setting-grid__wide"><span>环境变量名称</span><input value={draft.credentialEnvName} placeholder="SUB2API_API_KEY" onChange={(event) => setDraft({ ...draft, credentialEnvName: event.target.value })} /><small>只保存变量名称；启动服务前需要自行设置对应环境变量。</small></label>
                ) : null}
                <label><span>上下文容量</span><input type="number" min="1024" step="1" value={draft.contextWindow} onChange={(event) => setDraft({ ...draft, contextWindow: Number(event.target.value) })} /><small>不确定时保持默认值。</small></label>
                <label><span>单次最大输出</span><input type="number" min="256" step="256" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })} /><small>不确定时保持默认值。</small></label>
              </div>
            </details>
          </div>
          <label className="model-default-control">
            <input type="checkbox" checked={draft.webSearchEnabled} onChange={(event) => setDraft({
              ...draft,
              webSearchEnabled: event.target.checked,
              webSearchBaseUrl: event.target.checked && !draft.webSearchBaseUrl
                ? (MODEL_PRESETS.find((preset) => preset.id === draft.providerId)?.webSearchBaseUrl ?? '')
                : draft.webSearchBaseUrl,
            })} />
            <span><strong>启用联网搜索</strong><small>通过 DSH 的网页搜索工具查询实时信息。只有兼容 DeepSeek Anthropic 搜索协议的服务才能启用。</small></span>
          </label>
          {draft.webSearchEnabled ? (
            <div className="setting-grid model-setting-grid model-web-search-settings">
              <label className="setting-grid__wide"><span>搜索服务地址</span><input inputMode="url" value={draft.webSearchBaseUrl} placeholder="https://api.deepseek.com/anthropic/v1" onChange={(event) => setDraft({ ...draft, webSearchBaseUrl: event.target.value })} /><small>搜索会复用上方已加密保存的 API 密钥；自定义网关请填写其 Anthropic 兼容搜索端点，不会自动把密钥发送给其他服务。</small></label>
            </div>
          ) : null}
          <label className="model-default-control"><input type="checkbox" checked={draft.isDefault || models.length === 0} disabled={models.length === 0} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} /><span><strong>设为全局默认模型</strong><small>未单独分配模型的世界和角色会使用此配置。</small></span></label>
          <footer><span>{draft.id ? '正在编辑已保存配置' : '新配置保存后立即可用于路由'}</span><button className="primary-button" type="submit" disabled={savingModel}>{savingModel ? '正在保存…' : draft.id ? '保存修改' : '添加并保存'}</button></footer>
        </form>
      </div>
      <details className="settings-disclosure settings-disclosure--routing">
        <summary><span><strong>按世界或角色指定模型</strong><small>可选。默认情况下，所有世界和角色都会使用全局默认模型。</small></span><CaretDown size={16} /></summary>
        <div className="model-routing-list settings-disclosure__content">
          <ModelRouteRow label="全局默认" detail={workspace.name} value={assignmentValue('workspace', workspace.id)} models={models} onChange={(value) => void assign('workspace', workspace.id, value)} />
          {worlds.map((world) => <ModelRouteRow key={world.id} label="世界" detail={world.name} value={assignmentValue('world', world.id)} models={models} onChange={(value) => void assign('world', world.id, value)} />)}
          {employees.map((employee) => <ModelRouteRow key={employee.id} label="角色" detail={`${employee.displayName} · ${employee.role}`} value={assignmentValue('employee', employee.id)} models={models} onChange={(value) => void assign('employee', employee.id, value)} />)}
        </div>
      </details>
    </div>
  )
}

function SearchableModelPicker({ models, value, onChange }: { models: DiscoveredModel[]; value: string; onChange(value: string): void }) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (needle ? models.filter((model) => `${model.displayName ?? ''} ${model.id}`.toLocaleLowerCase().includes(needle)) : models).slice(0, 100)
  }, [models, query])
  useEffect(() => { setQuery(value) }, [value])
  useEffect(() => { setActiveIndex(0) }, [query])
  const choose = (model: DiscoveredModel) => { onChange(model.id); setQuery(model.displayName && model.displayName !== model.id ? `${model.displayName}（${model.id}）` : model.id); setOpen(false) }
  return <div className="model-search-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <input
      type="search"
      role="combobox"
      aria-label="搜索并选择可用模型"
      aria-expanded={open}
      aria-controls="model-search-listbox"
      aria-autocomplete="list"
      value={query}
      onFocus={() => setOpen(true)}
      onChange={(event) => { setQuery(event.target.value); setOpen(true) }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveIndex((current) => Math.min(current + 1, filtered.length - 1)) }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 1)) }
        if (event.key === 'Enter' && open && filtered[activeIndex]) { event.preventDefault(); choose(filtered[activeIndex]!) }
        if (event.key === 'Escape') setOpen(false)
      }}
    />
    {open ? <div className="model-search-picker__list" id="model-search-listbox" role="listbox">
      {filtered.length === 0 ? <span>没有匹配的模型</span> : filtered.map((model, index) => <button key={model.id} type="button" role="option" aria-selected={model.id === value} className={index === activeIndex ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(model)}><strong>{model.displayName ?? model.id}</strong>{model.displayName && model.displayName !== model.id ? <small>{model.id}</small> : null}</button>)}
    </div> : null}
  </div>
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
        <h3>使用记录</h3>
        <p>用于排查模型连接是否正常，包括调用时间、所用模型、耗时和错误原因。这里不会保存对话正文、模型回复或 API 密钥。</p>
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
          <div className="log-empty"><ListMagnifyingGlass size={24} /><strong>还没有使用记录</strong><span>完成一次模型连接测试或发起对话后，这里会显示调用状态。</span></div>
        )
      ) : result.items.length === 0 ? (
        <div className="log-empty"><ListMagnifyingGlass size={24} /><strong>{result.total === 0 ? '还没有使用记录' : '没有符合条件的记录'}</strong><span>{result.total === 0 ? '完成一次模型连接测试或发起对话后，这里会显示调用状态。' : '请调整状态或模型筛选条件。'}</span></div>
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
                    <span className="log-entry__source">{modelInteractionSourceLabel(log.source)}</span>
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
        <div><dt>交互类型</dt><dd>{modelInteractionSourceDetail(log.source)}</dd></div>
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
  if (full) return formatDateTime(date, { dateStyle: 'medium', timeStyle: 'medium', hour12: false })
  return formatDateTime(date, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function formatDuration(value: number): string {
  return localeFormatDuration(value)
}

function modelInteractionSourceLabel(source: ModelInteractionLog['source']): string {
  if (source === 'turn') return '对话回合'
  if (source === 'knowledge') return '知识整理'
  return '模型发现'
}

function modelInteractionSourceDetail(source: ModelInteractionLog['source']): string {
  if (source === 'turn') return '对话回合（服务端整轮交互）'
  if (source === 'knowledge') return '知识整理（后台语义提取）'
  return '模型目录发现'
}

function tokensSummary(log: ModelInteractionLog): string {
  if (log.tokensTotal === undefined) return '—'
  return `Token ${formatNumber(log.tokensTotal)}`
}

function validateModelDraft(draft: ModelDraft): string | undefined {
  if (!draft.displayName.trim()) return '请输入模型配置名称。'
  const connectionError = validateModelConnection(draft)
  if (connectionError !== undefined) return connectionError
  if (!draft.modelId.trim()) return '请输入模型 ID。'
  if (!Number.isInteger(draft.contextWindow) || draft.contextWindow < 1_024) return '上下文窗口必须是不小于 1024 的整数。'
  if (!Number.isInteger(draft.maxTokens) || draft.maxTokens < 256) return '最大输出 Token 必须是不小于 256 的整数。'
  if (draft.webSearchEnabled) {
    if (!draft.webSearchBaseUrl.trim()) return '启用联网搜索后，请填写搜索服务地址。'
    try {
      const searchUrl = new URL(draft.webSearchBaseUrl.trim())
      if (searchUrl.protocol !== 'https:') return '联网搜索服务必须使用 HTTPS 地址。'
    } catch {
      return '联网搜索服务地址格式不正确。'
    }
    if (draft.credentialMode === 'none') return '联网搜索需要 API 密钥或凭据环境变量。'
  }
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

function MaintenanceSettings({ pending, result, error, onRun }: ActionSettingsProps) {
  const [approved, setApproved] = useState(false)
  const update = result?.applicationUpdate
  return (
    <div className="settings-section settings-section--maintenance">
      <div className="settings-section__heading"><h3>应用更新</h3><p>检查 main 稳定通道。安装前会在隔离目录完成依赖安装和构建，并备份全部本地数据。</p></div>
      <section className="application-update-card">
        <div className="application-update-card__summary"><ShieldCheck size={24} /><span><strong>{update === undefined ? '尚未检查更新' : update.supported ? update.updateAvailable ? `发现 ${update.commitsBehind ?? 0} 个新提交` : '当前已是最新版本' : '当前不能自动更新'}</strong><small>{update?.reason ?? '自动更新只会执行可验证的 main 分支快进，不会覆盖本地改动。'}</small></span></div>
        {update?.currentRevision ? <dl><div><dt>当前版本</dt><dd>{shortRevision(update.currentRevision)}</dd></div><div><dt>目标版本</dt><dd>{shortRevision(update.targetRevision)}</dd></div><div><dt>更新通道</dt><dd>main</dd></div></dl> : null}
        {error ? <p className="model-form-message model-form-message--error" role="alert">{error}</p> : null}
        {update?.supported && update.updateAvailable ? <label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>我确认立即备份数据、验证新版本并安装更新。完成后需要重启应用。</span></label> : null}
        <footer>
          <button className="secondary-button" type="button" disabled={pending !== undefined} onClick={() => { setApproved(false); void onRun('check-application-update') }}>{pending === 'check-application-update' ? '正在检查…' : '检查更新'}</button>
          {update?.supported && update.updateAvailable ? <button className="primary-button" type="button" disabled={!approved || pending !== undefined} onClick={() => void onRun('apply-application-update', { approved: true })}>{pending === 'apply-application-update' ? '正在验证并安装…' : '安装更新'}</button> : null}
        </footer>
      </section>
      {result?.restartRequired ? <p className="model-form-message model-form-message--success" role="status"><CheckCircle size={16} />更新已安装。请重启 DSH Cyber 以使用新版本。</p> : null}
    </div>
  )
}

function DataSettings({ pending, result, error, onRun }: ActionSettingsProps) {
  return (
    <ActionSettings title="数据与备份" copy="你的世界、会话、角色和设置都保存在当前设备。建议在重要改动前创建备份；导出文件可用于迁移或留档。" result={result} error={error}>
      <ActionButton label="检查数据是否完整" action="doctor" pending={pending} onRun={onRun} />
      <ActionButton label="创建完整备份" action="backup" pending={pending} onRun={onRun} />
      <ActionButton label="导出通用 JSON 文件" action="export" pending={pending} onRun={onRun} />
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
      {version === undefined ? null : <p>AI 执行引擎版本：{version}</p>}
      {database === undefined ? null : <p>本机数据：{(database.integrity ?? []).includes('ok') && (database.errors ?? []).length === 0 ? '正常' : '需要检查'}</p>}
      {result.output === undefined ? null : <p className="system-result__path">已生成：{result.output}</p>}
      {(result.errors ?? result.compatibility?.errors ?? database?.errors ?? []).map((item) => <p key={item}>{item}</p>)}
    </div>
  )
}

function shortRevision(value: string | undefined): string {
  return value === undefined ? '—' : value.slice(0, 10)
}
