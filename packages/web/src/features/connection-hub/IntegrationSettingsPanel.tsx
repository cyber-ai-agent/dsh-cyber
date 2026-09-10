import { useEffect, useMemo, useState } from 'react'
import { PlugsConnected, Trash } from '@phosphor-icons/react'
import type {
  IntegrationConnection,
  IntegrationDescriptor,
  IntegrationHealth,
  JsonObject,
} from '@dsh-cyber/contracts'
import { api } from '../../api.js'
import { MachineProfilePanel } from '../machine-profile/MachineProfilePanel.js'
import { WebSearchProviderCards } from './WebSearchProviderCards.js'

/** The 联网搜索 type: its working area is the catalog-driven provider cards. */
const WEB_SEARCH_TYPE_ID = 'builtin.web-search'

export interface IntegrationSettingsPanelProps {
  workspaceId: string
  /** Pre-select the provider type that provides this skill when the panel loads. */
  initialSkillId?: string
}

/**
 * Connection-center management shared by the top-bar hub dialog and legacy
 * callers. The hub is two columns: the LEFT rail lists connection categories
 * (providers); the RIGHT side is the working area of the selected category —
 * its connection list (multi-connection types such as SSH devices) plus the
 * editor for the selected connection or a fresh one.
 *
 * Credentials: providers may declare several secret fields (SSH 私钥+密码).
 * Each field is edited independently; an empty field keeps the stored value,
 * and a configured field can be cleared explicitly.
 */
export function IntegrationSettingsPanel({ workspaceId, initialSkillId }: IntegrationSettingsPanelProps) {
  const [descriptors, setDescriptors] = useState<IntegrationDescriptor[]>([])
  const [connections, setConnections] = useState<IntegrationConnection[]>([])
  const [selectedTypeId, setSelectedTypeId] = useState<string>()
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>()
  const [config, setConfig] = useState<JsonObject>({})
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({})
  const [clearedSecrets, setClearedSecrets] = useState<Record<string, boolean>>({})
  const [enabled, setEnabled] = useState(true)
  const [health, setHealth] = useState<IntegrationHealth>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = async () => {
    const result = await api<{ descriptors: IntegrationDescriptor[]; items: IntegrationConnection[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/integrations`)
    setDescriptors(result.descriptors)
    setConnections(result.items)
    setSelectedTypeId((current) => current ?? pickInitialType(result.descriptors, initialSkillId))
  }

  useEffect(() => {
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '连接中心加载失败'))
    // load only changes local connection state for the selected workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  const descriptor = descriptors.find((item) => item.id === selectedTypeId)
  const multiple = descriptor?.allowsMultipleConnections === true
  const typeConnections = useMemo(
    () => connections.filter((item) => item.integrationId === descriptor?.id),
    [connections, descriptor?.id],
  )
  // Single-connection types edit their one connection; multi-connection types
  // edit the selected device, or a fresh form when none is chosen yet.
  const connection = multiple
    ? typeConnections.find((item) => item.id === selectedConnectionId)
    : typeConnections[0]

  const isNew = multiple && connection === undefined

  useEffect(() => {
    setConfig(Object.fromEntries((descriptor?.configFields ?? []).map((field) => [
      field.id,
      connection?.config[field.id] ?? (field.kind === 'boolean' ? false : field.kind === 'number' ? '' : field.placeholder ?? ''),
    ])) as JsonObject)
    setEnabled(connection?.enabled ?? true)
    setSecretInputs({})
    setClearedSecrets({})
    setHealth(undefined)
    setError(undefined)
  }, [connection?.id, descriptor?.id])

  const secretConfiguredFor = (fieldId: string): boolean => {
    if (connection === undefined) return false
    if (connection.secretsConfigured !== undefined) return connection.secretsConfigured[fieldId] === true
    // Legacy single-secret connections expose only the whole-connection flag.
    return (descriptor?.secretFields ?? []).length <= 1 && connection.credentialConfigured
  }

  const save = async () => {
    if (descriptor === undefined) return
    setBusy(true); setError(undefined); setHealth(undefined)
    try {
      const secrets: Record<string, string> = {}
      for (const field of descriptor.secretFields) {
        const value = secretInputs[field.id]?.trim()
        if (value !== undefined && value !== '' && clearedSecrets[field.id] !== true) secrets[field.id] = value
      }
      const clearSecretFields = Object.keys(clearedSecrets).filter((field) => clearedSecrets[field] === true)
      const path = isNew
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}/connections/${encodeURIComponent(connection!.id)}`
      await api(path, {
        method: 'PUT',
        body: JSON.stringify({
          config,
          enabled,
          displayName: typeof config.displayName === 'string' && config.displayName.trim() ? config.displayName.trim() : descriptor.displayName,
          ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
          ...(clearSecretFields.length === 0 ? {} : { clearSecretFields }),
        }),
      })
      await load()
      setSecretInputs({})
      setClearedSecrets({})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接保存失败')
    } finally {
      setBusy(false)
    }
  }

  const addConnection = async () => {
    if (descriptor === undefined) return
    // Multi-connection types create a fresh row on every PUT without a
    // connectionId; begin editing a blank form then save persists it.
    setSelectedConnectionId(undefined)
    setConfig(Object.fromEntries((descriptor.configFields ?? []).map((field) => [
      field.id,
      field.kind === 'boolean' ? false : field.kind === 'number' ? '' : field.placeholder ?? '',
    ])) as JsonObject)
    setEnabled(true)
    setSecretInputs({})
    setClearedSecrets({})
    setHealth(undefined)
    setError(undefined)
  }

  const removeConnection = async () => {
    if (descriptor === undefined || connection === undefined) return
    if (!window.confirm('确定删除这个连接吗？删除后无法恢复。')) return
    setBusy(true); setError(undefined)
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' })
      setSelectedConnectionId(undefined)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接删除失败')
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (descriptor === undefined) return
    setBusy(true); setError(undefined); setHealth(undefined)
    try {
      // Test exactly what the form shows right now — no save required. The
      // server merges freshly typed secrets over the stored ones.
      const secrets: Record<string, string> = {}
      for (const field of descriptor.secretFields) {
        const value = secretInputs[field.id]?.trim()
        if (value !== undefined && value !== '' && clearedSecrets[field.id] !== true) secrets[field.id] = value
      }
      const query = connection === undefined ? '' : `?connectionId=${encodeURIComponent(connection.id)}`
      const result = await api<{ health: IntegrationHealth }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}/test${query}`, {
        method: 'POST',
        body: JSON.stringify({ config, ...(Object.keys(secrets).length === 0 ? {} : { secrets }) }),
      })
      setHealth(result.health)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接测试失败')
    } finally {
      setBusy(false)
    }
  }

  const secretMissing = (descriptor?.secretFields ?? []).some((field) => field.required && !secretConfiguredFor(field.id) && !(secretInputs[field.id]?.trim()))

  const renderBody = () => (descriptor === undefined
    ? <div className="dialog-empty">当前没有可配置的外部连接。</div>
    : descriptor.id === WEB_SEARCH_TYPE_ID
      ? <WebSearchProviderCards
        workspaceId={workspaceId}
        connections={connections}
        typeId={descriptor.id}
        {...(initialSkillId === undefined ? {} : { initialSkillId })}
        onSaved={load}
      />
      : <>
        {multiple ? <div className="integration-connection-list" role="list" aria-label={`${descriptor.displayName} 连接列表`}>
          <button type="button" className={isNew ? 'is-active is-new-connection' : 'is-new-connection'} onClick={() => void addConnection()}>
            <PlugsConnected size={15} /><strong>{isNew ? '添加设备' : '＋ 添加设备'}</strong><small>新建一个 {descriptor.displayName}</small>
          </button>
          {typeConnections.map((item) => <button key={item.id} type="button" className={item.id === selectedConnectionId ? 'is-active' : ''} onClick={() => setSelectedConnectionId(item.id)}>
            <strong>{item.displayName}</strong><small>{`${String(item.config.host ?? item.config.endpoint ?? '')}${item.enabled ? '' : ' · 已停用'}`}</small>
          </button>)}
        </div> : null}
        <section className="integration-editor">
          <header>
            <div><h4>{isNew ? `添加${descriptor.displayName}` : connection?.displayName ?? descriptor.displayName}</h4><p>{descriptor.summary}</p></div>
            <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用连接</label>
          </header>
          {descriptor.configFields.map((field) => field.kind === 'boolean' ? (
            <label className="dialog-field dialog-field--checkbox" key={field.id}><input type="checkbox" checked={config[field.id] === true} onChange={(event) => setConfig((current) => ({ ...current, [field.id]: event.target.checked }))} /><span>{field.displayName}</span><small>{field.description}</small></label>
          ) : field.id === 'displayName' ? (
            <label className="dialog-field" key={field.id}><span>{field.displayName}</span><input type="text" value={String(config[field.id] ?? '')} placeholder={field.placeholder} onChange={(event) => setConfig((current) => ({ ...current, [field.id]: event.target.value }))} /><small>{field.description}</small></label>
          ) : (
            <label className="dialog-field" key={field.id}><span>{field.displayName}</span><input type={field.kind === 'number' ? 'number' : 'text'} value={String(config[field.id] ?? '')} placeholder={field.placeholder} onChange={(event) => setConfig((current) => ({ ...current, [field.id]: field.kind === 'number' ? Number(event.target.value) : event.target.value }))} /><small>{field.description}</small></label>
          ))}
          {(descriptor.secretFields ?? []).map((field) => {
            const stored = secretConfiguredFor(field.id)
            const cleared = clearedSecrets[field.id] === true
            const value = cleared ? '' : (secretInputs[field.id] ?? '')
            return <label className="dialog-field" key={field.id}><span>{field.displayName}</span>
              {field.multiline === true
                ? <textarea rows={6} value={value} placeholder={stored && !cleared ? '已加密保存；留空保持不变' : (field.placeholder ?? (field.required ? '请输入连接凭据' : '可选'))} onChange={(event) => setSecretInputs((current) => ({ ...current, [field.id]: event.target.value }))} autoComplete="new-password" spellCheck={false} />
                : <input type="password" autoComplete="new-password" value={value} placeholder={stored && !cleared ? '已加密保存；留空保持不变' : (field.required ? '请输入连接凭据' : '可选')} onChange={(event) => setSecretInputs((current) => ({ ...current, [field.id]: event.target.value }))} />}
              <small>{stored && !cleared
                ? <><span>{field.description}</span> <button type="button" className="integration-secret-clear" onClick={() => setClearedSecrets((current) => ({ ...current, [field.id]: true }))}>清除已保存的{field.displayName}</button></>
                : field.description}</small>
            </label>
          })}
          <div className="integration-egress"><strong>会发送到外部服务</strong><span>{descriptor.dataEgress.join('、') || '无'}</span></div>
          {descriptor.id === 'builtin.ssh-device' && connection !== undefined ? (
            <MachineProfilePanel scope={{ workspaceId, integrationId: descriptor.id, connectionId: connection.id }} />
          ) : null}
          {error ? <p className="model-form-message model-form-message--error" role="alert">{error}</p> : null}
          {health ? <p className={health.status === 'ready' ? 'model-form-message model-form-message--success' : 'model-form-message model-form-message--error'} role="status">{health.detail}{typeof health.latencyMs === 'number' ? ` · ${health.latencyMs} ms` : ''}</p> : null}
          <footer>
            {!isNew && connection !== undefined ? <button className="text-button is-danger" type="button" disabled={busy} onClick={() => void removeConnection()}><Trash size={15} />删除连接</button> : null}
            <span className="integration-editor__actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void test()}>测试连接</button>
              <button className="primary-button" type="button" disabled={busy || secretMissing} onClick={() => void save()}>{busy ? '处理中…' : isNew ? '添加连接' : '保存连接'}</button>
            </span>
          </footer>
        </section>
      </>)

  return <div className="integration-hub-layout">
    <div className="integration-provider-list" role="list" aria-label="连接类型">
      {descriptors.map((item) => <button key={item.id} type="button" className={item.id === selectedTypeId ? 'is-active' : ''} onClick={() => { setSelectedTypeId(item.id); setSelectedConnectionId(undefined) }}><strong>{item.displayName}</strong><small>{item.summary}</small></button>)}
    </div>
    <div className="integration-hub-workspace">
      {renderBody()}
    </div>
  </div>
}

function pickInitialType(descriptors: IntegrationDescriptor[], initialSkillId: string | undefined): string | undefined {
  if (initialSkillId === undefined) return descriptors[0]?.id
  // The 联网搜索 cards took over the Firecrawl settings (and its skill's
  // config entry), so a Firecrawl skill request preselects that main item.
  if (initialSkillId === 'web.search.firecrawl') return WEB_SEARCH_TYPE_ID
  const match = descriptors.find((item) => item.skillIds.includes(initialSkillId))
  return match?.id ?? descriptors[0]?.id
}
