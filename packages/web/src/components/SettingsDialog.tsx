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
  Sparkle,
  Star,
  Sun,
  Trash,
  WifiHigh,
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
import { ModelPicker } from '../features/models/ModelPicker.js'
import { loadDiscoveredModelsCache, saveDiscoveredModelsToCache } from '../features/models/discovered-models-storage.js'
import type { ApplicationAccessSummary } from './ApplicationLockGate.js'
import './SettingsDialog.css'

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

export interface ModelProfileSaveDraft {
  id?: string
  displayName: string
  providerKind: ModelProviderKind
  baseUrl: string
  modelId: string
  api: ModelApiKind
  apiKey?: string
  credentialEnvName?: string
  clearCredential?: boolean
  isDefault: boolean
  settings: ModelProfile['settings']
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
  displayName?: string | undefined
}

const SETTINGS_GROUPS = [
  {
    labelKey: 'settings.group.common',
    label: '常用设置',
    items: [
      ['appearance', '外观与布局', Palette, '颜色、背景和界面语言'],
      ['models', 'AI 模型', Cpu, '连接模型并设置使用范围'],
      ['integrations', '外部连接', Plug, '管理受信任的外部服务'],
      ['privacy', '隐私与锁屏', LockKey, '保护整个本地工作台'],
    ],
  },
  {
    labelKey: 'settings.group.data',
    label: '数据与记录',
    items: [
      ['data', '数据与备份', Database, '备份或导出本机数据'],
      ['logs', '使用记录', ListMagnifyingGlass, '查看模型调用与错误'],
    ],
  },
  {
    labelKey: 'settings.group.advanced',
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
  popularModels?: readonly string[]
  badge?: string
}

type ModelCredentialMode = 'api-key' | 'environment' | 'none'
type Translate = ReturnType<typeof useI18n>['t']

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
  { id: 'deepseek', label: 'DeepSeek', providerKind: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', credentialEnvName: 'DEEPSEEK_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'deepseek-chat', webSearchBaseUrl: 'https://api.deepseek.com/anthropic/v1', popularModels: ['deepseek-chat', 'deepseek-reasoner'], badge: '官方' },
  { id: 'siliconflow', label: 'SiliconFlow', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://api.siliconflow.cn/v1', credentialEnvName: 'SILICONFLOW_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'deepseek-ai/DeepSeek-V3', popularModels: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'], badge: '聚合' },
  { id: 'zhipu', label: 'Zhipu AI (GLM)', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', credentialEnvName: 'ZHIPU_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'glm-4-flash', popularModels: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'], badge: '国内' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', credentialEnvName: 'MOONSHOT_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'moonshot-v1-8k', popularModels: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
  { id: 'openai', label: 'OpenAI', providerKind: 'openai-compatible-remote', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credentialEnvName: 'OPENAI_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'gpt-4o', popularModels: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'] },
  { id: 'anthropic', label: 'Anthropic (Claude)', providerKind: 'openai-compatible-remote', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', credentialEnvName: 'ANTHROPIC_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'claude-3-7-sonnet-latest', popularModels: ['claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'] },
  { id: 'gemini', label: 'Google Gemini', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', credentialEnvName: 'GEMINI_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'gemini-2.5-pro', popularModels: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'openrouter', label: 'OpenRouter', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', credentialEnvName: 'OPENROUTER_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'deepseek/deepseek-chat', popularModels: ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet'] },
  { id: 'ollama', label: 'Ollama', providerKind: 'openai-compatible-local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1', credentialEnvName: '', credentialMode: 'none', modelPlaceholder: 'qwen2.5:7b', popularModels: ['qwen2.5:7b', 'deepseek-r1:8b', 'llama3.1:8b'], badge: '本地免密' },
  { id: 'lm-studio', label: 'LM Studio', providerKind: 'openai-compatible-local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1234/v1', credentialEnvName: '', credentialMode: 'none', modelPlaceholder: 'local-model', badge: '本地免密' },
  { id: 'custom-local', label: 'Custom (LAN/Sub2API)', providerKind: 'openai-compatible-local', api: 'openai-completions', baseUrl: '', credentialEnvName: 'SUB2API_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'qwen3.5' },
  { id: 'custom-remote', label: 'Custom (HTTPS-compatible)', providerKind: 'openai-compatible-remote', api: 'openai-completions', baseUrl: '', credentialEnvName: 'CUSTOM_API_KEY', credentialMode: 'api-key', modelPlaceholder: 'model-id' },
] as const

function providerPresetLabel(preset: ModelProviderPreset, t: Translate): string {
  return t(`settings.model.providerName.${preset.id}`, preset.label)
}

function modelDraftForPreset(preset: ModelProviderPreset, isDefault = false, displayName = preset.label): ModelDraft {
  return {
    providerId: preset.id,
    displayName,
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
          <nav className="settings-nav" aria-label={t('settings.tabNavigation', '设置栏目')}>
            {SETTINGS_GROUPS.map((group) => (
              <div className="settings-nav__group" key={group.labelKey}>
                <span className="settings-nav__label">{t(group.labelKey, group.label)}</span>
                {group.items.map(([id, label, Icon, description]) => (
                  <button
                    key={id}
                    type="button"
                    className={section === id ? 'is-active' : ''}
                    aria-current={section === id ? 'page' : undefined}
                    onClick={() => setSection(id)}
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span>
                      <strong>{t(`settings.${id}`, label)}</strong>
                      <small>{t(`settings.${id}Description`, description)}</small>
                    </span>
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
          <span>{section === 'appearance' ? (saving ? t('appearance.status.saving', '正在保存…') : changed ? t('appearance.status.unsaved', '有未保存的外观更改') : t('appearance.status.saved', '外观设置已保存')) : t(`settings.${section}Description`, '')}</span>
          <div>
            <button className="text-button" type="button" onClick={close}>{section === 'appearance' ? t('appearance.action.cancel', '取消') : t('common.close', '关闭')}</button>
            {section === 'appearance' ? <button className="primary-button" type="button" disabled={!changed || saving} onClick={() => void onSavePreferences(draft)}>{t('appearance.action.save', '保存外观设置')}</button> : null}
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
      <div className="settings-section__heading"><h3>{t('appearance.title', '外观与布局')}</h3><p>{t('appearance.description', '调整颜色模式、背景和工作区布局。皮肤请前往扩展市场选择。')}</p></div>
      <fieldset className="setting-group locale-setting">
        <legend>{t('appearance.language.title', '语言与地区')}</legend>
        <p>{t('appearance.language.description', '选择界面语言。更改会立即预览，并在保存后同步到当前工作区。')}</p>
        <label><span>{t('appearance.language.label', '界面语言')}</span><select value={value.locale} onChange={(event) => { const locale = event.target.value as WorkspacePreferences['locale']; setUiLocale(locale); onChange({ ...value, locale }) }}>{UI_LOCALES.map((locale) => <option key={locale.id} value={locale.id}>{locale.nativeName}</option>)}</select><small>{t('appearance.language.hint', '日期、数字、状态和产品文案会使用同一语言；技术标识保持原样。')}</small></label>
      </fieldset>
      <fieldset className="setting-group">
        <legend>{t('appearance.colorScheme.title', '颜色模式')}</legend>
        <div className="segmented-control">
          {([['system', 'appearance.colorScheme.system', '跟随系统', Desktop], ['light', 'appearance.colorScheme.light', '白天', Sun], ['dark', 'appearance.colorScheme.dark', '黑夜', Moon]] as const).map(([id, key, fallback, Icon]) => (
            <button key={id} type="button" className={value.colorScheme === id ? 'is-active' : ''} onClick={() => onChange({ ...value, colorScheme: id })}>
              <Icon size={17} /><span>{t(key, fallback)}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <details className="settings-disclosure appearance-advanced">
        <summary><span><strong>{t('appearance.more.title', '更多外观选项')}</strong><small>{t('appearance.more.description', '自定义背景、动效、信息密度和面板宽度')}</small></span><CaretDown size={16} /></summary>
        <div className="settings-disclosure__content appearance-advanced__content">
          <fieldset className="setting-group">
            <legend>{t('appearance.background.title', '自定义背景')}</legend>
            <label className="background-upload">
              <ImageSquare size={24} />
              <span><strong>{uploading ? t('appearance.background.uploading', '正在保存到本地…') : t('appearance.background.upload', '上传 PNG、JPEG 或 WebP')}</strong><small>{t('appearance.background.description', '最多 5 MiB。文件只保存在本机，并作为当前世界的场景底图。')}</small></span>
              <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUpload(file) }} />
            </label>
            <div className="setting-grid">
              <label><span>{t('appearance.background.fit', '适配方式')}</span><select value={value.backgroundFit} onChange={(event) => onChange({ ...value, backgroundFit: event.target.value as WorkspacePreferences['backgroundFit'] })}><option value="cover">{t('appearance.background.fit.cover', '铺满')}</option><option value="contain">{t('appearance.background.fit.contain', '完整显示')}</option><option value="tile">{t('appearance.background.fit.tile', '平铺')}</option></select></label>
              <label><span>{t('appearance.background.opacity', '背景透明度')}</span><input type="range" min="0" max="0.6" step="0.02" value={value.backgroundOpacity} onChange={(event) => onChange({ ...value, backgroundOpacity: Number(event.target.value) })} /></label>
              <label><span>{t('appearance.motion.title', '动效')}</span><select value={value.motion} onChange={(event) => onChange({ ...value, motion: event.target.value as WorkspacePreferences['motion'] })}><option value="system">{t('appearance.motion.system', '跟随系统')}</option><option value="reduced">{t('appearance.motion.reduced', '减少')}</option><option value="full">{t('appearance.motion.full', '完整')}</option></select></label>
            </div>
          </fieldset>
          <fieldset className="setting-group">
            <legend>{t('appearance.layout.title', '工作台布局')}</legend>
            <div className="setting-grid">
              <label><span>{t('appearance.layout.density', '界面密度')}</span><select value={value.interfaceDensity} onChange={(event) => onChange({ ...value, interfaceDensity: event.target.value as WorkspacePreferences['interfaceDensity'] })}><option value="compact">{t('appearance.layout.density.compact', '紧凑')}</option><option value="comfortable">{t('appearance.layout.density.comfortable', '舒适')}</option></select></label>
              <label><span>{t('appearance.layout.leftPane', '左栏 {width}px', { width: value.leftPaneWidth })}</span><input type="range" min={WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.minimum} max={WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.maximum} value={value.leftPaneWidth} onChange={(event) => onChange({ ...value, leftPaneWidth: Number(event.target.value) })} /></label>
              <label><span>{t('appearance.layout.rightPane', '右栏 {width}px', { width: value.rightPaneWidth })}</span><input type="range" min={WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.minimum} max={WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.maximum} value={value.rightPaneWidth} onChange={(event) => onChange({ ...value, rightPaneWidth: Number(event.target.value) })} /></label>
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
  const { t } = useI18n()
  const [draft, setDraft] = useState<ModelDraft>(() => {
    if (models[0]) return modelDraftForProfile(models[0])
    const preset = MODEL_PRESETS.find((item) => item.id === 'deepseek') ?? MODEL_PRESETS[0]!
    return modelDraftForPreset(preset, true, providerPresetLabel(preset, t))
  })
  const [editorOpen, setEditorOpen] = useState(models.length === 0)
  const [savingModel, setSavingModel] = useState(false)
  const [deletingModelId, setDeletingModelId] = useState<string>()
  const [modelError, setModelError] = useState<string>()
  const [modelNotice, setModelNotice] = useState<string>()
  const [showApiKey, setShowApiKey] = useState(false)
  const [discoveringModels, setDiscoveringModels] = useState(false)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([])
  const [manualModelId, setManualModelId] = useState(true)
  const [testState, setTestState] = useState<{ status: 'idle' | 'testing' | 'success' | 'failed'; message?: string; count?: number; latencyMs?: number }>({ status: 'idle' })

  const currentPreset = useMemo(() => MODEL_PRESETS.find((p) => p.id === draft.providerId), [draft.providerId])

  const assignmentValue = (scope: ModelAssignment['scope'], scopeId: string) =>
    assignments.find((item) => item.scope === scope && item.scopeId === scopeId)?.modelProfileId ?? ''
  const assign = (scope: ModelAssignment['scope'], scopeId: string, modelProfileId: string) =>
    onAssign({ scope, scopeId, ...(modelProfileId ? { modelProfileId } : {}) })

  const editModel = (profile: ModelProfile) => {
    setDraft(modelDraftForProfile(profile))
    setEditorOpen(true)
    setShowApiKey(false)
    setTestState({ status: 'idle' })
    const cache = loadDiscoveredModelsCache()
    const cached = cache[profile.id] ?? cache[profile.baseUrl.trim()]
    if (cached && Array.isArray(cached.models) && cached.models.length > 0) {
      setDiscoveredModels(cached.models)
      setManualModelId(false)
    } else {
      setDiscoveredModels([])
      setManualModelId(true)
    }
    setModelError(undefined)
    setModelNotice(undefined)
  }

  const startNewModel = () => {
    const defaultPreset = MODEL_PRESETS.find((preset) => preset.id === 'deepseek') ?? MODEL_PRESETS[0]!
    setDraft(modelDraftForPreset(defaultPreset, models.length === 0, providerPresetLabel(defaultPreset, t)))
    setEditorOpen(true)
    setShowApiKey(false)
    setDiscoveredModels([])
    setManualModelId(true)
    setTestState({ status: 'idle' })
    setModelError(undefined)
    setModelNotice(undefined)
  }

  const selectProviderPreset = (preset: ModelProviderPreset) => {
    const localizedPresetLabel = providerPresetLabel(preset, t)
    const updated = modelDraftForPreset(preset, draft.isDefault, localizedPresetLabel)
    setDraft({
      ...updated,
      ...(draft.id ? { id: draft.id } : {}),
      displayName: draft.displayName.trim() && draft.displayName !== (currentPreset === undefined ? undefined : providerPresetLabel(currentPreset, t))
        ? draft.displayName
        : preset.label,
    })
    setDiscoveredModels([])
    setManualModelId(true)
    setTestState({ status: 'idle' })
    setModelError(undefined)
    setModelNotice(undefined)
  }

  const makeDefault = async (profile: ModelProfile) => {
    try {
      await onSave({
        id: profile.id,
        displayName: profile.displayName,
        providerKind: profile.providerKind,
        baseUrl: profile.baseUrl,
        modelId: profile.modelId,
        api: profile.api,
        isDefault: true,
        settings: profile.settings,
      })
      if (draft.id === profile.id) {
        setDraft((current) => ({ ...current, isDefault: true }))
      }
      setModelNotice(t('settings.model.defaultSaved', '已将“{name}”设为工作区默认模型。', { name: profile.displayName }))
      setModelError(undefined)
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : t('settings.model.defaultError', '设置默认模型失败'))
      setModelNotice(undefined)
    }
  }

  const discoverModels = async () => {
    const validationError = validateModelConnection(draft, t)
    if (validationError !== undefined) {
      setModelError(validationError)
      setModelNotice(undefined)
      setTestState({ status: 'failed', message: validationError })
      return
    }
    setDiscoveringModels(true)
    setTestState({ status: 'testing' })
    setModelError(undefined)
    setModelNotice(undefined)
    const startTime = performance.now()
    try {
      const items = await onDiscover({
        baseUrl: draft.baseUrl.trim(),
        api: draft.api,
        ...(draft.id && draft.hasStoredApiKey && !draft.apiKey.trim() ? { profileId: draft.id } : {}),
        ...(draft.credentialMode === 'api-key' && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft.credentialMode === 'environment' ? { credentialEnvName: draft.credentialEnvName.trim() } : {}),
      })
      const latencyMs = Math.round(performance.now() - startTime)
      setDiscoveredModels(items)
      setTestState({
        status: 'success',
        latencyMs,
        count: items.length,
        message: t('settings.model.testSuccess', '连接成功，耗时 {latency}ms，获取到 {count} 个模型。', { latency: latencyMs, count: items.length }),
      })
      if (draft.id || draft.baseUrl.trim()) {
        const cachePayload = {
          models: items,
          baseUrl: draft.baseUrl.trim(),
          providerKind: draft.providerKind,
          providerName: draft.displayName.trim() || undefined,
          updatedAt: Date.now(),
        }
        if (draft.id) saveDiscoveredModelsToCache(draft.id, cachePayload)
        if (draft.baseUrl.trim()) saveDiscoveredModelsToCache(draft.baseUrl.trim(), cachePayload)
      }
      if (items[0]) {
        const selected = items.some((item) => item.id === draft.modelId.trim())
          ? draft.modelId.trim()
          : items[0].id
        setDraft((current) => ({ ...current, modelId: selected }))
        setManualModelId(false)
      }
      setModelNotice(t('settings.model.discoverSuccess', '已成功连接并获取 {count} 个模型。', { count: items.length }))
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : t('settings.model.discoverError', '模型目录获取失败，请检查接口地址或 API 密钥。')
      setTestState({ status: 'failed', message: msg })
      setModelError(msg)
    } finally {
      setDiscoveringModels(false)
    }
  }

  const saveDraft = async () => {
    const validationError = validateModelDraft(draft, t)
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
      setEditorOpen(true)
      setShowApiKey(false)
      setModelNotice(draft.id ? t('settings.model.updated', '模型连接已更新。') : t('settings.model.savedNotice', '模型连接已保存。'))
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : t('settings.model.saveError', '模型配置保存失败'))
    } finally {
      setSavingModel(false)
    }
  }

  const deleteProfile = async (profile: ModelProfile) => {
    if (!window.confirm(t('settings.model.deleteConfirm', '确定删除“{name}”吗？相关模型路由会自动恢复为继承上级。', { name: profile.displayName }))) return
    setDeletingModelId(profile.id)
    setModelError(undefined)
    setModelNotice(undefined)
    try {
      await onDelete(profile.id)
      if (draft.id === profile.id) {
        const remaining = models.filter((item) => item.id !== profile.id)
        if (remaining[0]) setDraft(modelDraftForProfile(remaining[0]))
        else {
          const preset = MODEL_PRESETS.find((item) => item.id === 'deepseek') ?? MODEL_PRESETS[0]!
          setDraft(modelDraftForPreset(preset, true, providerPresetLabel(preset, t)))
        }
        setEditorOpen(remaining.length === 0)
      }
      setModelNotice(t('settings.model.deleted', '模型连接已删除。'))
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : t('settings.model.deleteError', '模型配置删除失败'))
    } finally {
      setDeletingModelId(undefined)
    }
  }

  return (
    <div className="settings-section settings-section--models">
      <div className="settings-section__heading">
        <h3>{t('settings.models', 'AI 模型')}</h3>
        <p>{t('settings.modelsDescription', '连接模型并设置使用范围')}</p>
      </div>

      <div className="model-config-layout">
        {/* 左侧：已连接模型列表面板 */}
        <section className={`model-profile-panel${editorOpen ? ' is-collapsed' : ''}`} aria-label={t('settings.model.savedAria', '已保存的模型配置')}>
          <header>
            <div>
              <h4>{t('settings.model.saved', '已连接模型')}</h4>
              <span>{models.length === 0 ? t('settings.model.notConfigured', '尚未配置') : t('settings.model.count', '共 {count} 个连接', { count: models.length })}</span>
            </div>
            <button className="primary-button model-btn-add" type="button" onClick={startNewModel}>
              <Plus size={14} />
              {t('settings.model.add', '添加服务')}
            </button>
          </header>

          <div className="model-list">
            {models.length === 0 ? (
              <div className="model-list__empty">
                <Cpu size={26} />
                <strong>{t('settings.model.emptyTitle', '尚未添加模型连接')}</strong>
                <span>{t('settings.model.emptyDescription', '连接常用云端服务、聚合网关或本地模型服务。')}</span>
                <button className="secondary-button" type="button" onClick={startNewModel}>
                  {t('settings.model.emptyAction', '连接第一个模型')}
                </button>
              </div>
            ) : null}

            {models.map((model) => {
              const isSelected = editorOpen && draft.id === model.id
              return (
                <article
                  key={model.id}
                  className={`model-card-item${isSelected ? ' is-active' : ''}`}
                >
                  <button className="model-card-item__select" type="button" aria-pressed={isSelected} onClick={() => editModel(model)}>
                    <div className="model-card-item__body">
                    <div className="model-card-item__top">
                      <strong>{model.displayName}</strong>
                      {model.isDefault ? (
                        <span className="model-default-tag">
                          <Star size={11} weight="fill" />
                          {t('settings.model.default', '默认')}
                        </span>
                      ) : null}
                    </div>
                    <div className="model-card-item__model-id">
                      <code>{model.modelId}</code>
                    </div>
                    <div className="model-card-item__meta">
                      <span>{providerLabel(model, t)}</span>
                      <span>·</span>
                      <span>{credentialSummary(model, t)}</span>
                    </div>
                  </div>
                  </button>

                  <div className="model-card-item__actions">
                    {!model.isDefault ? (
                      <button
                        type="button"
                        className="model-action-btn model-action-btn--default"
                        title={t('settings.model.makeDefault', '设为全局默认模型')}
                        onClick={() => void makeDefault(model)}
                      >
                        <Star size={13} />
                        {t('settings.model.makeDefaultShort', '设为默认')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="model-action-btn"
                      aria-label={t('settings.model.editAria', '编辑 {name}', { name: model.displayName })}
                      onClick={() => editModel(model)}
                    >
                      <PencilSimple size={13} />
                    </button>
                    <button
                      type="button"
                      className="model-action-btn is-danger"
                      aria-label={t('settings.model.deleteAria', '删除 {name}', { name: model.displayName })}
                      disabled={deletingModelId === model.id}
                      onClick={() => void deleteProfile(model)}
                    >
                      <Trash size={13} />
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        {/* 右侧：模型连接配置表单面板 */}
        {editorOpen ? <form
          className="model-editor-panel"
          aria-label={t('settings.model.editorAria', '模型连接编辑器')}
          onSubmit={(event) => {
            event.preventDefault()
            void saveDraft()
          }}
        >
          <header className="model-editor-header">
            <div>
              <h4>{draft.id ? t('settings.model.editTitle', '编辑模型：{name}', { name: draft.displayName }) : t('settings.model.newTitle', '添加新模型服务')}</h4>
              <p>{t('settings.model.editorDescription', '依次完成服务信息、连接测试和模型选择。')}</p>
            </div>
            {draft.id ? (
              <button className="text-button" type="button" onClick={startNewModel}>
                + {t('settings.model.newService', '新建服务')}
              </button>
            ) : null}
          </header>

          {/* 表单可滚动内容区 */}
          <div className="model-editor-scroll">
            {/* 测试结果 / 状态徽章 */}
            {testState.status === 'testing' ? (
              <div className="model-test-badge model-test-badge--loading">
                <WifiHigh size={16} className="is-spinning" />
                <span>{t('settings.model.testing', '正在测试连接并拉取可用模型…')}</span>
              </div>
            ) : null}

            {testState.status === 'success' ? (
              <div className="model-test-badge model-test-badge--success">
                <CheckCircle size={16} />
                <span>{testState.message}</span>
              </div>
            ) : null}

            {modelError ? (
              <p className="model-form-message model-form-message--error" role="alert">
                {modelError}
              </p>
            ) : null}

            {modelNotice && testState.status !== 'success' ? (
              <p className="model-form-message model-form-message--success" role="status">
                <CheckCircle size={16} />
                {modelNotice}
              </p>
            ) : null}

            {/* 核心设置表单字段 */}
            <div className="model-form-fields">
              <div className="setting-grid model-setting-grid">
                <label>
                  <span>{t('settings.model.displayName', '连接显示名称')}</span>
                  <input
                    value={draft.displayName}
                    placeholder={t('settings.model.displayNamePlaceholder', '例如：工作室 DeepSeek')}
                    onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
                  />
                </label>

                <label>
                  <span>{t('settings.model.provider', '模型服务商')}</span>
                  <select
                    value={draft.providerId}
                    onChange={(event) => {
                      const preset = MODEL_PRESETS.find((item) => item.id === event.target.value)
                      if (preset) selectProviderPreset(preset)
                    }}
                  >
                    {MODEL_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {providerPresetLabel(preset, t)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="setting-grid__wide">
                  <span>{t('settings.model.baseUrl', '服务接口地址（Base URL）')}</span>
                  <input
                    inputMode="url"
                    value={draft.baseUrl}
                    placeholder={
                      draft.providerKind === 'openai-compatible-local'
                        ? 'http://127.0.0.1:11434/v1'
                        : 'https://api.example.com/v1'
                    }
                    onChange={(event) => {
                      setDraft({ ...draft, baseUrl: event.target.value })
                      setDiscoveredModels([])
                      setManualModelId(true)
                      setTestState({ status: 'idle' })
                    }}
                  />
                  <small>{t('settings.model.baseUrlHint', '公网接口须使用 HTTPS；本机和局域网服务可以使用 HTTP。')}</small>
                </label>

                {draft.credentialMode === 'api-key' ? (
                  <label className="setting-grid__wide">
                    <span>{t('settings.model.apiKey', 'API 密钥')}</span>
                    <div className="model-secret-input">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        autoComplete="new-password"
                        spellCheck={false}
                        value={draft.apiKey}
                        placeholder={
                          draft.hasStoredApiKey
                            ? t('settings.model.apiKeyStoredPlaceholder', '已加密保存；留空保持原密钥')
                            : t('settings.model.apiKeyPlaceholder', '输入服务商提供的密钥')
                        }
                        onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                      />
                      <button
                        type="button"
                        aria-label={showApiKey ? t('settings.model.hideKey', '隐藏 API 密钥') : t('settings.model.showKey', '显示 API 密钥')}
                        onClick={() => setShowApiKey((current) => !current)}
                      >
                        {showApiKey ? <EyeSlash size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    <small>
                      {draft.hasStoredApiKey && !draft.apiKey
                        ? t('settings.model.apiKeyStoredHint', '密钥已加密保存。输入新密钥才会替换，留空不会改变。')
                        : t('settings.model.apiKeyHint', '密钥只写入本机凭据库，不进入模型配置、日志或对话。')}
                    </small>
                  </label>
                ) : null}

                {/* 测试连接快捷操作条 */}
                <div className="model-test-action-bar setting-grid__wide">
                  <button
                    type="button"
                    className="secondary-button model-btn-test-connect"
                    disabled={discoveringModels}
                    onClick={() => void discoverModels()}
                  >
                    <WifiHigh size={16} />
                    {discoveringModels ? t('settings.model.testingShort', '正在测试连接…') : t('settings.model.test', '测试连接并获取模型')}
                  </button>
                  <span className="model-test-hint">
                    {discoveredModels.length > 0
                      ? t('settings.model.discoveredCount', '已获取 {count} 个模型', { count: discoveredModels.length })
                      : t('settings.model.testHint', '验证端点后会显示服务端返回的真实模型目录。')}
                  </span>
                </div>

                {/* 模型选择与常用模型药丸 */}
                <div className="model-field setting-grid__wide">
                  <div className="model-field-header">
                    <span>{t('settings.model.modelId', '模型（Model ID）')}</span>
                    {discoveredModels.length > 0 ? (
                      <button
                        className="model-catalog-mode-link"
                        type="button"
                        onClick={() => {
                          if (manualModelId && discoveredModels[0]) {
                            setDraft((current) => ({
                              ...current,
                              modelId: discoveredModels.some((item) => item.id === current.modelId)
                                ? current.modelId
                                : discoveredModels[0]!.id,
                            }))
                          }
                          setManualModelId((current) => !current)
                        }}
                      >
                        {manualModelId ? t('settings.model.chooseCatalog', '从已获取列表选择') : t('settings.model.manual', '切换为手动输入')}
                      </button>
                    ) : null}
                  </div>

                  <div className="model-catalog-input">
                    {discoveredModels.length > 0 && !manualModelId ? (
                      <SearchableModelPicker
                        models={discoveredModels}
                        value={draft.modelId}
                        onChange={(modelId) => setDraft({ ...draft, modelId })}
                      />
                    ) : (
                      <input
                        aria-label={t('settings.model.modelIdAria', '模型 ID')}
                        value={draft.modelId}
                        placeholder={
                          currentPreset?.modelPlaceholder ?? '输入模型 ID，例如：deepseek-chat'
                        }
                        onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
                      />
                    )}
                  </div>
                </div>

                {/* 高级连接设置 */}
                <details className="settings-disclosure setting-grid__wide">
                  <summary>
                    <span>
                      <strong>{t('settings.model.advanced', '高级配置')}</strong>
                      <small>{t('settings.model.advancedHint', '接口协议、上下文容量与密钥来源')}</small>
                    </span>
                    <CaretDown size={16} />
                  </summary>
                  <div className="setting-grid settings-disclosure__content">
                    <label>
                      <span>{t('settings.model.protocol', '接口协议')}</span>
                      <select
                        value={draft.api}
                        onChange={(event) => {
                          setDraft({ ...draft, api: event.target.value as ModelApiKind })
                          setDiscoveredModels([])
                          setManualModelId(true)
                        }}
                      >
                        <option value="openai-completions">OpenAI 对话补全 (标准)</option>
                        <option value="openai-responses">OpenAI Responses</option>
                        <option value="anthropic-messages">Anthropic 消息协议</option>
                      </select>
                    </label>

                    <label>
                      <span>{t('settings.model.credentialMode', '密钥来源')}</span>
                      <select
                        value={draft.credentialMode}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            credentialMode: event.target.value as ModelCredentialMode,
                            apiKey: '',
                          })
                        }
                      >
                        <option value="api-key">{t('settings.model.credentialDirect', '直接输入 API 密钥')}</option>
                        <option value="environment">{t('settings.model.credentialEnv', '从系统环境变量读取')}</option>
                        <option value="none">{t('settings.model.credentialNone', '无需凭据')}</option>
                      </select>
                    </label>

                    {draft.credentialMode === 'environment' ? (
                      <label className="setting-grid__wide">
                        <span>{t('settings.model.envName', '环境变量名称')}</span>
                        <input
                          value={draft.credentialEnvName}
                          placeholder="例如：DEEPSEEK_API_KEY"
                          onChange={(event) =>
                            setDraft({ ...draft, credentialEnvName: event.target.value })
                          }
                        />
                      </label>
                    ) : null}

                    <label>
                      <span>{t('settings.model.contextWindow', '上下文窗口')}</span>
                      <input
                        type="number"
                        min="1024"
                        step="1024"
                        value={draft.contextWindow}
                        onChange={(event) =>
                          setDraft({ ...draft, contextWindow: Number(event.target.value) })
                        }
                      />
                    </label>

                    <label>
                      <span>{t('settings.model.maxTokens', '最大输出 Token')}</span>
                      <input
                        type="number"
                        min="256"
                        step="256"
                        value={draft.maxTokens}
                        onChange={(event) =>
                          setDraft({ ...draft, maxTokens: Number(event.target.value) })
                        }
                      />
                    </label>
                  </div>
                </details>
              </div>

              {/* 联网搜索与默认模型控制 */}
              <div className="model-toggles-section">
                <label className="model-default-control">
                  <input
                    type="checkbox"
                    checked={draft.webSearchEnabled}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        webSearchEnabled: event.target.checked,
                        webSearchBaseUrl:
                          event.target.checked && !draft.webSearchBaseUrl
                            ? (currentPreset?.webSearchBaseUrl ?? '')
                            : draft.webSearchBaseUrl,
                      })
                    }
                  />
                  <span>
                    <strong>{t('settings.model.webSearch', '启用兼容联网搜索')}</strong>
                    <small>
                      {t('settings.model.webSearchHint', '仅对明确兼容 Anthropic 搜索端点的服务启用。')}
                    </small>
                  </span>
                </label>

                {draft.webSearchEnabled ? (
                  <div className="setting-grid model-setting-grid model-web-search-settings">
                    <label className="setting-grid__wide">
                      <span>{t('settings.model.webSearchUrl', '搜索服务地址')}</span>
                      <input
                        inputMode="url"
                        value={draft.webSearchBaseUrl}
                        placeholder="https://api.deepseek.com/anthropic/v1"
                        onChange={(event) =>
                          setDraft({ ...draft, webSearchBaseUrl: event.target.value })
                        }
                      />
                    </label>
                  </div>
                ) : null}

                <label className="model-default-control">
                  <input
                    type="checkbox"
                    checked={draft.isDefault || models.length === 0}
                    disabled={models.length === 0}
                    onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })}
                  />
                  <span>
                    <strong>{t('settings.model.setDefault', '设为工作区默认模型')}</strong>
                    <small>{t('settings.model.setDefaultHint', '未单独指派模型的世界和角色会继承此连接。')}</small>
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* 绝对吸底固定的 Footer 操作栏，绝不截断 */}
          <footer className="model-editor-footer">
            <div className="model-editor-footer__status">
              <Sparkle size={15} />
              <span>{draft.id ? t('settings.model.editingStatus', '正在编辑已保存连接') : t('settings.model.newStatus', '保存后立即可用于模型路由')}</span>
            </div>
            <div className="model-editor-footer__actions">
              <button className="text-button" type="button" onClick={() => setEditorOpen(false)}>{t('common.cancel', '取消')}</button>
              <button className="primary-button" type="submit" disabled={savingModel}>
                {savingModel ? t('settings.model.saving', '正在保存…') : draft.id ? t('settings.model.saveChanges', '保存修改') : t('settings.model.saveConnection', '保存连接')}
              </button>
            </div>
          </footer>
        </form> : null}
      </div>

      {/* 模型路由分配区 */}
      <details className="settings-disclosure settings-disclosure--routing">
        <summary>
          <span>
            <strong>{t('settings.model.routing', '模型使用范围')}</strong>
            <small>{t('settings.model.routingHint', '默认继承工作区模型，只在确有需要时覆盖世界或角色。')}</small>
          </span>
          <CaretDown size={16} />
        </summary>
        <div className="model-routing-list settings-disclosure__content">
          <ModelRouteRow
            label={t('settings.model.workspaceDefault', '工作区默认')}
            detail={workspace.name}
            value={assignmentValue('workspace', workspace.id)}
            models={models}
            onChange={(value) => void assign('workspace', workspace.id, value)}
          />
          {worlds.map((world) => (
            <ModelRouteRow
              key={world.id}
              label={t('settings.model.world', '世界')}
              detail={world.name}
              value={assignmentValue('world', world.id)}
              models={models}
              onChange={(value) => void assign('world', world.id, value)}
            />
          ))}
          {employees.map((employee) => (
            <ModelRouteRow
              key={employee.id}
              label={t('settings.model.role', '角色')}
              detail={`${employee.displayName} · ${employee.role}`}
              value={assignmentValue('employee', employee.id)}
              models={models}
              onChange={(value) => void assign('employee', employee.id, value)}
            />
          ))}
        </div>
      </details>
    </div>
  )
}

function SearchableModelPicker({ models, value, onChange }: { models: DiscoveredModel[]; value: string; onChange(value: string): void }) {
  const { t } = useI18n()
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
      aria-label={t('settings.model.searchAria', '搜索并选择可用模型')}
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
      {filtered.length === 0 ? <span>{t('settings.model.noMatches', '没有匹配的模型')}</span> : filtered.map((model, index) => <button key={model.id} type="button" role="option" aria-selected={model.id === value} className={index === activeIndex ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(model)}><strong>{model.displayName ?? model.id}</strong>{model.displayName && model.displayName !== model.id ? <small>{model.id}</small> : null}</button>)}
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

function validateModelDraft(draft: ModelDraft, t: Translate): string | undefined {
  if (!draft.displayName.trim()) return t('settings.model.validationName', '请输入模型配置名称。')
  const connectionError = validateModelConnection(draft, t)
  if (connectionError !== undefined) return connectionError
  if (!draft.modelId.trim()) return t('settings.model.validationModel', '请输入模型 ID。')
  if (!Number.isInteger(draft.contextWindow) || draft.contextWindow < 1_024) return t('settings.model.validationContext', '上下文窗口必须是不小于 1024 的整数。')
  if (!Number.isInteger(draft.maxTokens) || draft.maxTokens < 256) return t('settings.model.validationTokens', '最大输出 Token 必须是不小于 256 的整数。')
  if (draft.webSearchEnabled) {
    if (!draft.webSearchBaseUrl.trim()) return t('settings.model.validationSearchUrl', '启用联网搜索后，请填写搜索服务地址。')
    try {
      const searchUrl = new URL(draft.webSearchBaseUrl.trim())
      if (searchUrl.protocol !== 'https:') return t('settings.model.validationSearchHttps', '联网搜索服务必须使用 HTTPS 地址。')
    } catch {
      return t('settings.model.validationSearchFormat', '联网搜索服务地址格式不正确。')
    }
    if (draft.credentialMode === 'none') return t('settings.model.validationSearchCredential', '联网搜索需要 API 密钥或凭据环境变量。')
  }
  return undefined
}

function validateModelConnection(draft: ModelDraft, t: Translate): string | undefined {
  if (!draft.baseUrl.trim()) return t('settings.model.validationBaseUrl', '请输入模型接口地址。')
  try {
    new URL(draft.baseUrl.trim())
  } catch {
    return t('settings.model.validationBaseUrlFormat', '模型接口地址格式不正确。')
  }
  if (draft.credentialMode === 'api-key' && !draft.apiKey.trim() && !draft.hasStoredApiKey) return t('settings.model.validationApiKey', '请输入 API 密钥，或将凭据方式改为“无需凭据”。')
  if (draft.credentialMode === 'environment' && !/^[A-Z_][A-Z0-9_]*$/.test(draft.credentialEnvName.trim())) return t('settings.model.validationEnv', '凭据环境变量名只能使用大写字母、数字和下划线，且不能以数字开头。')
  return undefined
}

function ModelRouteRow({ label, detail, value, models, onChange }: { label: string; detail: string; value: string; models: ModelProfile[]; onChange(value: string): void }) {
  const { t } = useI18n()
  return <label className="model-route-row"><span><strong>{label}</strong><small>{detail}</small></span><ModelPicker models={models} value={value || undefined} ariaLabel={t('settings.model.routeAria', '{label}模型', { label })} inheritLabel={t('settings.model.inherit', '继承上级 / 默认模型')} onChange={(modelId) => onChange(modelId ?? '')} /></label>
}

function providerLabel(model: ModelProfile, t: Translate): string {
  const providerId = typeof model.settings.providerId === 'string' ? model.settings.providerId : model.providerKind
  const preset = MODEL_PRESETS.find((item) => item.id === providerId)
  return preset === undefined ? providerId : providerPresetLabel(preset, t)
}

function credentialSummary(model: ModelProfile, t: Translate): string {
  if (isManagedCredentialName(model.credentialEnvName)) return t('settings.model.credentialSaved', 'API 密钥已保存')
  if (model.credentialEnvName) return t('settings.model.credentialEnvSummary', '环境变量：{name}', { name: model.credentialEnvName })
  return t('settings.model.credentialNoneSummary', '无需凭据')
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
