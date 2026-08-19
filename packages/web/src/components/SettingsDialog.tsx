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
import { useMemo, useState } from 'react'
import type { ModelProfile, WorkspacePreferences } from '@dsh-cyber/contracts'

type SettingsSection = 'appearance' | 'models' | 'runtime' | 'data' | 'updates'

interface SettingsDialogProps {
  preferences: WorkspacePreferences
  models: ModelProfile[]
  saving: boolean
  onClose(): void
  onSavePreferences(preferences: WorkspacePreferences): Promise<void>
  onUploadBackground(file: File): Promise<string>
  onSaveModel(profile: Omit<ModelProfile, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>): Promise<void>
}

const sections = [
  ['appearance', '外观与个性化', Palette],
  ['models', '模型', Cpu],
  ['runtime', '运行时', ShieldCheck],
  ['data', '本地数据', Database],
  ['updates', '更新', ArrowsClockwise],
] as const

export function SettingsDialog({
  preferences,
  models,
  saving,
  onClose,
  onSavePreferences,
  onUploadBackground,
  onSaveModel,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>('appearance')
  const [draft, setDraft] = useState(preferences)
  const [uploading, setUploading] = useState(false)
  const [modelDraft, setModelDraft] = useState({
    displayName: '本地模型',
    providerKind: 'openai-compatible-local' as const,
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: '',
    api: 'openai-completions' as const,
    credentialEnvName: '',
  })
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(preferences), [draft, preferences])

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
                draft={modelDraft}
                onChange={setModelDraft}
                onSave={() => onSaveModel({
                  displayName: modelDraft.displayName,
                  providerKind: modelDraft.providerKind,
                  baseUrl: modelDraft.baseUrl,
                  modelId: modelDraft.modelId,
                  api: modelDraft.api,
                  ...(modelDraft.credentialEnvName ? { credentialEnvName: modelDraft.credentialEnvName } : {}),
                  isDefault: models.length === 0,
                  settings: {},
                })}
              />
            ) : null}
            {section === 'runtime' ? <RuntimeSettings /> : null}
            {section === 'data' ? <DataSettings /> : null}
            {section === 'updates' ? <UpdateSettings /> : null}
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
          <span><strong>{uploading ? '正在保存到本地…' : '上传 PNG、JPEG 或 WebP'}</strong><small>最大 5 MiB。文件保存在本机，数据库仅记录校验值和引用。</small></span>
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

function ModelSettings({ models, draft, onChange, onSave }: { models: ModelProfile[]; draft: { displayName: string; providerKind: 'openai-compatible-local'; baseUrl: string; modelId: string; api: 'openai-completions'; credentialEnvName: string }; onChange(value: typeof draft): void; onSave(): Promise<void> }) {
  return (
    <div className="settings-section">
      <div className="settings-section__heading"><h3>模型</h3><p>配置默认模型与本地兼容接口。密钥只读取环境变量。</p></div>
      <div className="model-list">{models.map((model) => <article key={model.id}><Cpu size={20} /><div><strong>{model.displayName}</strong><span>{model.modelId} · {model.providerKind}</span></div><span>{model.isDefault ? '默认' : '可用'}</span></article>)}</div>
      <fieldset className="setting-group"><legend>添加 OpenAI 兼容的本地模型</legend><div className="setting-grid">
        <label><span>名称</span><input value={draft.displayName} onChange={(event) => onChange({ ...draft, displayName: event.target.value })} /></label>
        <label><span>模型 ID</span><input value={draft.modelId} placeholder="qwen3:14b" onChange={(event) => onChange({ ...draft, modelId: event.target.value })} /></label>
        <label className="setting-grid__wide"><span>Base URL</span><input value={draft.baseUrl} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} /></label>
        <label className="setting-grid__wide"><span>凭据环境变量名（可选）</span><input value={draft.credentialEnvName} placeholder="LOCAL_MODEL_API_KEY" onChange={(event) => onChange({ ...draft, credentialEnvName: event.target.value })} /></label>
      </div><button className="secondary-button" type="button" disabled={!draft.modelId.trim()} onClick={() => void onSave()}>保存模型配置</button></fieldset>
    </div>
  )
}

function RuntimeSettings() { return <InfoSettings title="运行时" copy="独立 DSH profile 仅绑定环回地址。每名员工拥有稳定且独立的 Harness 会话。" rows={['DeepSeek Harness 兼容性检查', '最小权限与工具能力', '员工模型策略覆盖']} /> }
function DataSettings() { return <InfoSettings title="本地数据" copy="SQLite 是本地权威数据源。可执行备份、导出、诊断与损坏只读恢复。" rows={['数据库健康检查', '创建本地备份', '导出可移植 JSON']} /> }
function UpdateSettings() { return <InfoSettings title="更新" copy="底层 DSH 先进入候选 profile，通过协议与回归测试后再原子切换。" rows={['检查 DSH 兼容版本', '运行候选环境验证', '查看更新与回滚记录']} /> }

function InfoSettings({ title, copy, rows }: { title: string; copy: string; rows: string[] }) {
  return <div className="settings-section"><div className="settings-section__heading"><h3>{title}</h3><p>{copy}</p></div><div className="settings-action-list">{rows.map((row) => <button key={row} type="button"><span>{row}</span><span>查看</span></button>)}</div></div>
}
