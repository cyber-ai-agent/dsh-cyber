import { useCallback, useEffect, useState } from 'react'
import { ArrowClockwise, CheckCircle, PlugsConnected, SpinnerGap, WarningCircle, X } from '@phosphor-icons/react'
import type { IntegrationConnection, World } from '@dsh-cyber/contracts'

import { api, jsonBody } from '../../api.js'
import { useI18n } from '../../i18n/runtime.js'

interface Resource {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

interface Preview {
  uri: string
  title: string
  text: string
  byteLength: number
  contentHash: string
  truncated: boolean
}

type Busy = 'connections' | 'resources' | 'preview' | 'import' | undefined

/** A user-controlled bridge from an enabled MCP connection into local knowledge. */
export function McpResourceImportPanel({ world, onImported, onClose }: {
  world: World
  onImported(): Promise<void>
  onClose(): void
}) {
  const { t } = useI18n()
  const [connections, setConnections] = useState<IntegrationConnection[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [resources, setResources] = useState<Resource[]>([])
  const [loadedResources, setLoadedResources] = useState(false)
  const [selectedUri, setSelectedUri] = useState('')
  const [preview, setPreview] = useState<Preview>()
  const [busy, setBusy] = useState<Busy>('connections')
  const [error, setError] = useState<string>()
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    let active = true
    setBusy('connections')
    setConnections([])
    setConnectionId('')
    setResources([])
    setLoadedResources(false)
    setPreview(undefined)
    void api<{ items: IntegrationConnection[] }>(`/api/workspaces/${encodeURIComponent(world.workspaceId)}/integrations`)
      .then((result) => {
        if (!active) return
        const available = result.items.filter((item) => item.integrationId === 'builtin.mcp' && item.enabled)
        setConnections(available)
        setConnectionId(available[0]?.id ?? '')
      })
      .catch((cause: unknown) => { if (active) setError(messageOf(cause)) })
      .finally(() => { if (active) setBusy(undefined) })
    return () => { active = false }
  }, [world.id, world.workspaceId])

  const endpoint = useCallback((suffix = '') => `/api/worlds/${encodeURIComponent(world.id)}/knowledge/mcp-resources/${encodeURIComponent(connectionId)}${suffix}`, [world.id, connectionId])

  const loadResources = async () => {
    if (!connectionId) return
    setBusy('resources')
    setError(undefined)
    setSuccess(false)
    setResources([])
    setLoadedResources(false)
    setSelectedUri('')
    setPreview(undefined)
    try {
      const result = await api<{ items: Resource[] }>(endpoint())
      setResources(result.items)
      setLoadedResources(true)
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(undefined) }
  }

  const loadPreview = async (resource: Resource) => {
    setSelectedUri(resource.uri)
    setPreview(undefined)
    setBusy('preview')
    setError(undefined)
    setSuccess(false)
    try {
      const result = await api<{ preview: Preview }>(endpoint('/preview'), jsonBody({ uri: resource.uri }))
      if (result.preview.uri === resource.uri) setPreview(result.preview)
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(undefined) }
  }

  const importResource = async () => {
    if (!connectionId || !selectedUri || preview?.uri !== selectedUri) return
    setBusy('import')
    setError(undefined)
    try {
      await api(endpoint('/import'), jsonBody({ uri: selectedUri, expectedHash: preview.contentHash }))
      await onImported()
      setSuccess(true)
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(undefined) }
  }

  const loading = busy !== undefined
  return <section className="knowledge-mcp-import" aria-label={t('knowledge.mcpImportAction', '从 MCP 资源导入')} aria-busy={loading}>
    <header>
      <span className="knowledge-mcp-import__mark" aria-hidden="true"><PlugsConnected size={20} /></span>
      <div><strong>{t('knowledge.mcpImportAction', '从 MCP 资源导入')}</strong><p>{t('knowledge.mcpImportDesc', '读取已启用连接中的文本资源，确认后保存到当前世界。')}</p></div>
      <button type="button" className="knowledge-icon-button" onClick={onClose} disabled={busy === 'import'} aria-label={t('knowledge.mcpClose', '收起 MCP 导入')}><X size={18} /></button>
    </header>
    {connections.length === 0 && busy !== 'connections' ? <p className="knowledge-mcp-import__empty">{t('knowledge.mcpNoConnections', '当前工作区没有已启用的 MCP 连接。请先在顶部连接中心添加并启用。')}</p> : null}
    {connections.length > 0 ? <div className="knowledge-mcp-import__controls">
      <label htmlFor="knowledge-mcp-connection">{t('knowledge.mcpConnection', 'MCP 连接')}</label>
      <select id="knowledge-mcp-connection" value={connectionId} disabled={loading} onChange={(event) => {
        setConnectionId(event.target.value)
        setResources([])
        setLoadedResources(false)
        setSelectedUri('')
        setPreview(undefined)
        setSuccess(false)
      }}>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName}</option>)}</select>
      <button type="button" className="knowledge-button" disabled={loading || !connectionId} onClick={() => void loadResources()}>{busy === 'resources' ? <SpinnerGap size={16} className="knowledge-spin" /> : <ArrowClockwise size={16} />}{busy === 'resources' ? t('knowledge.mcpLoading', '正在读取…') : t('knowledge.mcpLoad', '读取资源目录')}</button>
    </div> : null}
    {resources.length > 0 ? <ul className="knowledge-mcp-import__resources" aria-label={t('knowledge.mcpPreview', '预览资源')}>{resources.map((resource) => {
      const textual = resource.mimeType === undefined || isTextMimeType(resource.mimeType)
      return <li key={resource.uri}><button type="button" className={selectedUri === resource.uri ? 'is-selected' : ''} onClick={() => void loadPreview(resource)} disabled={loading || !textual} aria-pressed={selectedUri === resource.uri}>
        <strong>{resource.title ?? resource.name}</strong><small>{resource.description ?? resource.mimeType ?? t('knowledge.mcpSource', 'MCP 资源')}</small>
        {!textual ? <em>{t('knowledge.mcpTextOnly', '目前只支持文本资源。')}</em> : null}
      </button></li>
    })}</ul> : null}
    {loadedResources && resources.length === 0 && busy === undefined && connectionId && !error ? <p className="knowledge-mcp-import__empty">{t('knowledge.mcpEmpty', '这个连接没有可列出的资源。')}</p> : null}
    {busy === 'preview' ? <p role="status"><SpinnerGap size={16} className="knowledge-spin" />{t('knowledge.mcpLoading', '正在读取…')}</p> : null}
    {preview !== undefined ? <div className="knowledge-mcp-import__preview"><div><strong>{preview.title}</strong><small>{preview.byteLength < 1024 ? `${preview.byteLength} B` : `${Math.ceil(preview.byteLength / 1024)} KiB`}</small></div><pre>{preview.text}</pre>{preview.truncated ? <p>{t('knowledge.mcpPreviewLimit', '这里只显示前 8000 个字符，导入时会读取完整文本（最多 1 MiB）。')}</p> : null}<button type="button" className="knowledge-button knowledge-button--primary" disabled={loading} onClick={() => void importResource()}>{busy === 'import' ? t('knowledge.mcpImporting', '正在导入…') : t('knowledge.mcpImport', '导入当前世界')}</button></div> : null}
    {error === undefined ? null : <p className="knowledge-notice knowledge-notice--error" role="alert"><WarningCircle size={16} />{error}</p>}
    {success ? <p className="knowledge-notice" role="status"><CheckCircle size={16} />{t('knowledge.mcpSuccess', '资源已保存到当前世界知识库。')}</p> : null}
  </section>
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'MCP 资源读取失败，请检查连接后重试。'
}

function isTextMimeType(value: string): boolean {
  const mimeType = value.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml' || mimeType === 'application/yaml'
}
