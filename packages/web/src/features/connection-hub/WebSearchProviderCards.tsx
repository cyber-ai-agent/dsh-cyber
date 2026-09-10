import { useEffect, useState } from 'react'
import type { IntegrationConnection, WebSearchProviderCatalog, WebSearchProviderDescriptor } from '@dsh-cyber/contracts'

import { api } from '../../api.js'

export interface WebSearchProviderCardsProps {
  workspaceId: string
  /** Every integration connection of the workspace (including the legacy Firecrawl one the cards took over). */
  connections: IntegrationConnection[]
  /** The 联网搜索 integration type id (from the selected descriptor). */
  typeId: string
  initialSkillId?: string
  onSaved(): Promise<void> | void
}

/**
 * 联网搜索 working area. Providers are fixed cards from the checked-in
 * catalog/web-search-providers.json — never a free dropdown: each card shows
 * its service address, description and key-acquisition link, and editing only
 * sets the API key and the default marker. The Firecrawl card edits the
 * legacy `builtin.firecrawl` connection (skills/knowledge keep one credential
 * home); other cards own one 联网搜索 connection per provider.
 */
export function WebSearchProviderCards({ workspaceId, connections, typeId, initialSkillId, onSaved }: WebSearchProviderCardsProps) {
  const [catalog, setCatalog] = useState<WebSearchProviderCatalog>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    api<{ catalog: WebSearchProviderCatalog }>('/api/integrations/web-search/providers')
      .then((result) => { if (!cancelled) setCatalog(result.catalog) })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '搜索服务商目录加载失败') })
    return () => { cancelled = true }
  }, [workspaceId])

  if (error !== undefined) return <p className="model-form-message model-form-message--error" role="alert">{error}</p>
  if (catalog === undefined) return <p className="dialog-loading">加载搜索服务商目录…</p>
  const initialCard = initialSkillId === 'web.search.firecrawl' ? catalog.providers.find((provider) => provider.backend === 'firecrawl')?.id : undefined
  return <div className="web-search-cards" role="list" aria-label="搜索服务商" data-initial-card={initialCard ?? ''}>
    {catalog.providers.map((provider) => (
      <WebSearchProviderCard
        key={provider.id}
        provider={provider}
        webSearchTypeId={typeId}
        workspaceId={workspaceId}
        connections={connections}
        onSaved={onSaved}
      />
    ))}
  </div>
}

interface CardProps {
  provider: WebSearchProviderDescriptor
  webSearchTypeId: string
  workspaceId: string
  connections: IntegrationConnection[]
  onSaved(): Promise<void> | void
}

function WebSearchProviderCard({ provider, webSearchTypeId, workspaceId, connections, onSaved }: CardProps) {
  const legacy = provider.integrationId !== undefined && provider.integrationId !== webSearchTypeId
  const connection = connections.find((item) => legacy
    ? item.integrationId === provider.integrationId
    : item.integrationId === webSearchTypeId && String(item.config.provider ?? '') === provider.id)
  const keyConfigured = connection?.credentialConfigured === true
  const isDefault = connection?.config.isDefault === true
  const enabled = connection?.enabled !== false

  const [editing, setEditing] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [defaultChecked, setDefaultChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>()

  const openEditor = (): void => {
    setKeyInput('')
    setDefaultChecked(isDefault)
    setFormError(undefined)
    setEditing(true)
  }

  const targetUrl = (appendConnection: boolean): string => {
    const target = legacy ? provider.integrationId! : webSearchTypeId
    const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(target)}`
    return appendConnection && connection !== undefined ? `${base}/connections/${encodeURIComponent(connection.id)}` : base
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setFormError(undefined)
    const key = keyInput.trim()
    const body: Record<string, unknown> = { enabled: true }
    if (legacy) {
      // Keep any custom base URL; blank falls back to the provider default.
      body.config = {
        ...(connection?.config.baseUrl === undefined ? {} : { baseUrl: String(connection.config.baseUrl) }),
        isDefault: defaultChecked,
      }
    } else {
      body.config = { provider: provider.id, isDefault: defaultChecked }
      if (connection === undefined) body.displayName = provider.name
    }
    if (key !== '') body.secrets = { apiKey: key }
    try {
      await api(targetUrl(connection === undefined), { method: 'PUT', body: JSON.stringify(body) })
      await onSaved()
      setEditing(false)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    if (connection === undefined) return
    setBusy(true)
    setFormError(undefined)
    const body: Record<string, unknown> = { enabled: true, clearCredential: true }
    if (legacy) body.config = { ...(connection.config.baseUrl === undefined ? {} : { baseUrl: String(connection.config.baseUrl) }), isDefault }
    else body.config = { provider: provider.id, isDefault }
    try {
      await api(targetUrl(true), { method: 'PUT', body: JSON.stringify(body) })
      await onSaved()
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '清除密钥失败')
    } finally {
      setBusy(false)
    }
  }

  return <article className="web-search-card" role="listitem" data-provider-id={provider.id}>
    <header className="web-search-card__header">
      <strong>{provider.name}</strong>
      {isDefault ? <span className="web-search-card__badge">默认</span> : null}
      <span className={`web-search-card__status${keyConfigured ? '' : ' is-missing'}`}>{connection === undefined || !keyConfigured ? '未设置密钥' : enabled ? '密钥已配置' : '已停用'}</span>
    </header>
    <div className="web-search-card__meta">
      <span>服务地址：<code>{provider.endpoint}</code></span>
      <span>{provider.description}</span>
      <span>获取途径：<a href={provider.obtain.url} target="_blank" rel="noreferrer">{provider.obtain.text}</a></span>
    </div>
    {editing ? <div className="web-search-card__edit">
      <label className="dialog-field">
        <span>API 密钥{keyConfigured ? '（留空保持不变）' : ''}</span>
        <input
          type="password"
          value={keyInput}
          placeholder={keyConfigured ? '已加密保存；留空保持不变' : '请输入 API 密钥'}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(event) => setKeyInput(event.target.value)}
        />
      </label>
      <label className="dialog-field dialog-field--checkbox">
        <input type="checkbox" checked={defaultChecked} onChange={(event) => setDefaultChecked(event.target.checked)} />
        <span>设为默认搜索服务商</span>
        <small>勾选后，对话中的联网搜索优先使用这家服务商。</small>
      </label>
      {formError !== undefined ? <p className="model-form-message model-form-message--error" role="alert">{formError}</p> : null}
      <div className="web-search-card__actions">
        <button className="primary-button" type="button" disabled={busy} onClick={() => void save()}>{busy ? '处理中…' : '保存'}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button>
      </div>
    </div> : <div className="web-search-card__actions">
      <button className="primary-button" type="button" onClick={openEditor}>{keyConfigured ? '编辑' : '设置'}</button>
      {keyConfigured ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void clearKey()}>清除密钥</button> : null}
      {formError !== undefined ? <span className="model-form-message model-form-message--error">{formError}</span> : null}
    </div>}
  </article>
}
