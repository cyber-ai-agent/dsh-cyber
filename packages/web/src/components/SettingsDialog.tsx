import {
  ArrowsClockwise,
  ArrowSquareOut,
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
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { useDialogFocusTrap } from './useDialogFocusTrap.js'
import './SettingsDialog.css'

const ModelHubDialog = lazy(async () => ({ default: (await import('../features/model-hub/ModelHubDialog.js')).ModelHubDialog }))

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
  workspace: Workspace
  worlds: World[]
  employees: EmployeeInstance[]
  initialSection?: SettingsSection
  saving: boolean
  onClose(): void
  onSavePreferences(preferences: WorkspacePreferences): Promise<void>
  onUploadBackground(file: File): Promise<string>
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
  /** Context window reported by the server's own metadata, when known. */
  contextLength?: number | undefined
}

const SETTINGS_GROUPS = [
  {
    labelKey: 'settings.group.common',
    label: '常用设置',
    items: [
      ['appearance', '外观与布局', Palette, '颜色、背景和界面语言'],
      ['models', 'AI 模型', Cpu, '统一管理已移至模型中心'],
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

export function SettingsDialog({
  preferences,
  workspace,
  worlds,
  employees,
  initialSection = 'appearance',
  saving,
  onClose,
  onSavePreferences,
  onUploadBackground,
  onSystemAction,
  onLoadModelLogs,
  onClearModelLogs,
}: SettingsDialogProps) {
  const { t } = useI18n()
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [draft, setDraft] = useState(preferences)
  const [uploading, setUploading] = useState(false)
  const [hubOpen, setHubOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<SystemAction>()
  const [actionResult, setActionResult] = useState<SystemActionResult>()
  const [actionError, setActionError] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(preferences), [draft, preferences])
  const close = () => { setUiLocale(preferences.locale); onClose() }
  useDialogFocusTrap(dialogRef, close)
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
      <section ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-dialog__header">
          <div><h2 id="settings-title">{t('settings.title', '设置')}</h2><p>{t('settings.intro', '管理界面、AI 模型、数据备份与应用维护。')}</p></div>
          <button className="icon-button" type="button" data-dialog-initial-focus aria-label={t('settings.close', '关闭设置')} onClick={close}><X size={18} /></button>
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
            <div className="settings-hub-gate">
              <div className="model-hub-entry">
                <span><strong>{t('settings.model.hubTitle', '新的 AI 模型管理中心')}</strong><small>{t('settings.model.hubCopy', '服务商、模型池与角色分配已在此统一管理：一个服务商一份密钥，模型测试后勾选导入，再按世界与角色分配。')}</small></span>
                <button type="button" className="primary-button" onClick={() => setHubOpen(true)}>{t('settings.model.hubOpen', '打开模型中心')}</button>
              </div>
              <p className="settings-hub-gate__note">{t('settings.model.gateNote', '本节不再单独管理模型；旧配置已在首次启动时自动迁移为服务商。')}</p>
            </div>
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
        {hubOpen ? <Suspense fallback={null}><ModelHubDialog workspaceId={workspace.id} worlds={worlds} employees={employees} onClose={() => setHubOpen(false)} /></Suspense> : null}
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
