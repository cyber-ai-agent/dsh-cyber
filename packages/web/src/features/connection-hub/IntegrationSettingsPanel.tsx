import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Trash } from '@phosphor-icons/react'
import type {
  IntegrationConnection,
  IntegrationDescriptor,
  IntegrationHealth,
  JsonObject,
} from '@dsh-cyber/contracts'
import { api } from '../../api.js'

export interface IntegrationSettingsPanelProps {
  workspaceId: string
  /** When true the outer chrome (provider rail + section paddings) is rendered too. */
  standalone?: boolean
}

/**
 * Connection-center management shared by the settings section and the top-bar
 * hub dialog.
 *
 * Single-connection types keep their legacy one-form-per-type flow. Types that
 * declare `allowsMultipleConnections` (SSH devices) render a connection list
 * with an "add" action; the editor always targets the selected connection.
 */
export function IntegrationSettingsPanel({ workspaceId, standalone = false }: IntegrationSettingsPanelProps) {
  const [descriptors, setDescriptors] = useState<IntegrationDescriptor[]>([])
  const [connections, setConnections] = useState<IntegrationConnection[]>([])
  const [selectedTypeId, setSelectedTypeId] = useState<string>()
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>()
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
    setSelectedTypeId((current) => current ?? result.descriptors[0]?.id)
  }

  useEffect(() => {
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '外部连接加载失败'))
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

  useEffect(() => {
    setConfig(Object.fromEntries((descriptor?.configFields ?? []).map((field) => [
      field.id,
      connection?.config[field.id] ?? (field.kind === 'boolean' ? false : field.kind === 'number' ? '' : field.placeholder ?? ''),
    ])) as JsonObject)
    setEnabled(connection?.enabled ?? true)
    setCredential('')
    setHealth(undefined)
    setError(undefined)
  }, [connection?.id, descriptor?.id])

  const targetId = descriptor?.id
  const targetConnectionId = connection?.id

  const save = async () => {
    if (descriptor === undefined) return
    setBusy(true); setError(undefined); setHealth(undefined)
    try {
      const path = targetConnectionId === undefined
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}/connections/${encodeURIComponent(targetConnectionId)}`
      await api(path, {
        method: 'PUT',
        body: JSON.stringify({
          config,
          enabled,
          displayName: typeof config.displayName === 'string' ? config.displayName : descriptor.displayName,
          ...(credential.trim() ? { credential: credential.trim() } : {}),
          ...(connection?.credentialConfigured === true && !credential.trim() ? {} : {}),
        }),
      })
      await load()
      setCredential('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接保存失败')
    } finally {
      setBusy(false)
    }
  }

  const addConnection = async () => {
    if (descriptor === undefined) return
    setBusy(true); setError(undefined)
    try {
      // Multi-connection types create a fresh row on every PUT without a
      // connectionId; begin editing a blank form then save persists it.
      setSelectedConnectionId(undefined)
      setConfig(Object.fromEntries((descriptor.configFields ?? []).map((field) => [
        field.id,
        field.kind === 'boolean' ? false : field.kind === 'number' ? '' : field.placeholder ?? '',
      ])) as JsonObject)
      setEnabled(true)
      setCredential('')
      setHealth(undefined)
    } finally {
      setBusy(false)
    }
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
    setBusy(true); setError(undefined)
    try {
      const query = targetConnectionId === undefined ? '' : `?connectionId=${encodeURIComponent(targetConnectionId)}`
      const result = await api<{ health: IntegrationHealth }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(descriptor.id)}/test${query}`, { method: 'POST', body: '{}' })
      setHealth(result.health)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接测试失败')
    } finally {
      setBusy(false)
    }
  }

  const secretConfigured = connection?.credentialConfigured === true
  const requiredConfigMissing = descriptor?.configFields.some((field) => field.required && String(config[field.id] ?? '').trim() === '') ?? true
  const secretMissing = (descriptor?.secretFields ?? []).some((field) => field.required && !secretConfigured && credential.trim() === '')

  const renderBody = () => (descriptor === undefined
    ? <div className="dialog-empty">当前没有可配置的外部连接。</div>
    : <>
        {multiple ? <div className="integration-connection-list">
          <button type="button" className={connection === undefined ? 'is-active' : ''} onClick={() => { setSelectedConnectionId(undefined); setHealth(undefined) }}>
            <strong>{connection === undefined ? '新连接' : '未选择'}</strong><small>添加一台新设备或端点</small>
          </button>
          {typeConnections.map((item) => <button key={item.id} type="button" className={item.id === selectedConnectionId ? 'is-active' : ''} onClick={() => setSelectedConnectionId(item.id)}>
            <strong>{item.displayName}</strong><small>{`${String(item.config.host ?? item.config.endpoint ?? '')}${item.enabled ? '' : ' · 已停用'}`}</small>
          </button>)}
        </div> : null}
        <section className="integration-editor">
          <header>
            <div><h4>{connection?.displayName ?? descriptor.displayName}</h4><p>{descriptor.summary}</p></div>
            <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用连接</label>
          </header>
          {descriptor.configFields.map((field) => field.kind === 'boolean' ? (
            <label className="dialog-field dialog-field--checkbox" key={field.id}><input type="checkbox" checked={config[field.id] === true} onChange={(event) => setConfig((current) => ({ ...current, [field.id]: event.target.checked }))} /><span>{field.displayName}</span><small>{field.description}</small></label>
          ) : field.id === 'displayName' ? (
            <label className="dialog-field" key={field.id}><span>{field.displayName}</span><input type="text" value={String(config[field.id] ?? '')} placeholder={field.placeholder} onChange={(event) => setConfig((current) => ({ ...current, [field.id]: event.target.value }))} /><small>{field.description}</small></label>
          ) : (
            <label className="dialog-field" key={field.id}><span>{field.displayName}</span><input type={field.kind === 'number' ? 'number' : 'text'} value={String(config[field.id] ?? '')} placeholder={field.placeholder} onChange={(event) => setConfig((current) => ({ ...current, [field.id]: field.kind === 'number' ? Number(event.target.value) : event.target.value }))} /><small>{field.description}</small></label>
          ))}
          {descriptor.secretFields.map((field) => <label className="dialog-field" key={field.id}><span>{field.displayName}</span>
            {field.multiline === true
              ? <textarea rows={6} value={credential} placeholder={secretConfigured ? '已加密保存；留空保持不变' : (field.required ? '请输入连接凭据' : '可选')} onChange={(event) => setCredential(event.target.value)} autoComplete="new-password" spellCheck={false} />
              : <input type="password" autoComplete="new-password" value={credential} placeholder={secretConfigured ? '已加密保存；留空保持不变' : (field.required ? '请输入连接凭据' : '可选')} onChange={(event) => setCredential(event.target.value)} />}
            <small>{field.description}</small></label>)}
          <div className="integration-egress"><strong>会发送到外部服务</strong><span>{descriptor.dataEgress.join('、') || '无'}</span></div>
          {error ? <p className="model-form-message model-form-message--error" role="alert">{error}</p> : null}
          {health ? <p className={health.status === 'ready' ? 'model-form-message model-form-message--success' : 'model-form-message model-form-message--error'} role="status">{health.detail} · {health.latencyMs} ms</p> : null}
          <footer>
            {multiple && connection !== undefined ? <button className="text-button is-danger" type="button" disabled={busy} onClick={() => void removeConnection()}><Trash size={15} />删除连接</button> : null}
            <span className="integration-editor__actions">
              <button className="secondary-button" type="button" disabled={busy || connection === undefined} onClick={() => void test()}>测试连接</button>
              <button className="primary-button" type="button" disabled={busy || requiredConfigMissing || secretMissing} onClick={() => void save()}>{busy ? '处理中…' : targetConnectionId === undefined && multiple ? '添加连接' : '保存连接'}</button>
            </span>
          </footer>
        </section>
      </>)

  const chrome = (content: ReactNode) => standalone
    ? <div className="settings-section settings-section--integrations">
        <div className="settings-section__heading"><h3>连接中心</h3><p>统一管理受信任的连接。安装 Skill 只声明能力，角色获得授权后仍需经过审批策略才能执行命令或发送数据。</p></div>
        <div className="integration-hub-layout">
          <div className="integration-provider-list" role="list">
            {descriptors.map((item) => <button key={item.id} type="button" className={item.id === selectedTypeId ? 'is-active' : ''} onClick={() => { setSelectedTypeId(item.id); setSelectedConnectionId(undefined) }}><strong>{item.displayName}</strong><small>{item.summary}</small></button>)}
          </div>
          {content}
        </div>
      </div>
    : <div className="integration-hub-layout">
        <div className="integration-provider-list" role="list">
          {descriptors.map((item) => <button key={item.id} type="button" className={item.id === selectedTypeId ? 'is-active' : ''} onClick={() => { setSelectedTypeId(item.id); setSelectedConnectionId(undefined) }}><strong>{item.displayName}</strong><small>{item.summary}</small></button>)}
        </div>
        {content}
      </div>

  return chrome(renderBody())
}
