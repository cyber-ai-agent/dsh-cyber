import { useEffect, useMemo, useRef, useState } from 'react'
import type { EmployeeInstance, IntegrationConnection, IntegrationDescriptor } from '@dsh-cyber/contracts'

import { api } from '../api.js'
import './ConnectionGrantEditor.css'

interface ConnectionGrantEditorProps {
  employee: EmployeeInstance
  /** Connection-hub connection ids currently granted to this character. */
  value: string[]
  onChange(next: string[]): void
}

interface ConnectionRow {
  id: string
  displayName: string
  detail: string
  enabled: boolean
  credentialConfigured: boolean
  credentialRequired: boolean
}

interface ConnectionGroup {
  descriptor: IntegrationDescriptor
  rows: ConnectionRow[]
}

const WEB_SEARCH_TYPE_ID = 'builtin.web-search'
const LEGACY_FIRECRAWL_TYPE_ID = 'builtin.firecrawl'

/**
 * Second half of the skill+connection authorization pair. The role's 技能 tab
 * grants which skills exist; this list grants which concrete
 * hub connections the character may drive. Every provider category exposes a
 * parent checkbox and every concrete connection remains independently
 * selectable, including web-search providers and MCP services.
 */
export function ConnectionGrantEditor({ employee, value, onChange }: ConnectionGrantEditorProps) {
  const [descriptors, setDescriptors] = useState<IntegrationDescriptor[]>([])
  const [items, setItems] = useState<IntegrationConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api<{ descriptors: IntegrationDescriptor[]; items: IntegrationConnection[] }>(`/api/workspaces/${encodeURIComponent(employee.workspaceId)}/integrations`)
      .then((result) => {
        if (cancelled) return
        setDescriptors(result.descriptors)
        setItems(result.items)
        setError(undefined)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '连接列表加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [employee.workspaceId])

  const groups = useMemo<ConnectionGroup[]>(() => descriptors.map((descriptor) => ({
    descriptor,
    rows: items.filter((item) => item.integrationId === descriptor.id
      || (descriptor.id === WEB_SEARCH_TYPE_ID && item.integrationId === LEGACY_FIRECRAWL_TYPE_ID))
      .map((item) => toConnectionRow(item, descriptor)),
  })), [descriptors, items])
  const connectionIds = useMemo(() => new Set(groups.flatMap((group) => group.rows.map((row) => row.id))), [groups])
  const selectableIds = useMemo(() => [...connectionIds], [connectionIds])
  // Grants whose device was deleted from the hub stay visible so the user can
  // revoke them explicitly instead of leaving a silent dangling grant.
  const revoked = useMemo(() => value.filter((id) => !connectionIds.has(id)), [connectionIds, value])

  if (loading) return <div className="dialog-empty" role="status">正在读取本工作区的连接…</div>
  if (error !== undefined) return <div className="permission-notice permission-notice--warning" role="alert"><p>{error}</p><small>已保存的连接权限保持生效；请稍后重试或前往“连接中心”查看。</small></div>
  if (groups.length === 0 && revoked.length === 0) {
    return <div className="connection-grant-editor connection-grant-editor--empty"><header><div><h4>连接权限</h4><span>0 项</span></div></header><p>连接中心暂无可授权连接。请先配置搜索服务、设备或 MCP 服务。</p></div>
  }

  return <div className="connection-grant-editor">
    <section className="connection-grant-group" aria-labelledby="connection-grant-title">
      <header><div><h4 id="connection-grant-title">连接权限</h4><span>{value.filter((id) => connectionIds.has(id)).length} / {connectionIds.size} 项</span></div></header>
      <p className="connection-grant-editor__note">技能决定角色可以执行的工作，连接权限决定角色可以使用的搜索服务、设备与 MCP 服务。两项同时满足后，具体高风险动作仍会请求确认。</p>
      <GrantCheckbox label="全部连接" detail="一次选择连接中心当前列出的所有类目与子项。" ids={selectableIds} value={value} onChange={onChange} className="connection-grant-row--all" />
      {groups.map(({ descriptor, rows }) => <div key={descriptor.id} className="connection-grant-type">
        <GrantCheckbox label={descriptor.displayName} detail={descriptor.summary} ids={rows.map((row) => row.id)} value={value} onChange={onChange} className="connection-grant-type__title" disabled={rows.length === 0} />
        {rows.length === 0 ? <p className="connection-grant-group__empty">当前类目还没有连接子项。</p> : rows.map((row) => <ConnectionGrantRow key={row.id} row={row} granted={value.includes(row.id)} onChange={(checked) => onGrantChange(row.id, checked, value, onChange)} />)}
      </div>)}
    </section>
    {revoked.length > 0 ? <section className="connection-grant-group" aria-labelledby="connection-grant-revoked-title">
      <header><div><h4 id="connection-grant-revoked-title">已移除的连接</h4><span>{revoked.length} 项</span></div></header>
      <p className="connection-grant-group__empty">这些连接已从“连接中心”删除，保留的授权不会再生效。取消勾选即可清理历史授权。</p>
      {revoked.map((id) => {
        const row = items.find((item) => item.id === id)
        const label = row?.displayName ?? id
        return <label key={id} className={`connection-grant-row is-granted`}>
          <input type="checkbox" checked={value.includes(id)} onChange={(event) => onGrantChange(id, event.target.checked, value, onChange)} />
          <span><strong>{label}</strong><small>连接已被移除，当前授权无效。</small></span>
        </label>
      })}
    </section> : null}
  </div>
}

function ConnectionGrantRow({ row, granted, onChange }: { row: ConnectionRow; granted: boolean; onChange(checked: boolean): void }) {
  const usable = row.enabled && (!row.credentialRequired || row.credentialConfigured)
  const status = !row.enabled ? '已停用' : row.credentialRequired && !row.credentialConfigured ? '缺少凭据' : granted ? '已授权' : '可授权'
  const statusClass = granted ? 'granted' : usable ? 'available' : 'disabled'
  return <label className={`connection-grant-row${granted ? ' is-granted' : ''}${usable ? '' : ' is-unusable'}`}>
    <input type="checkbox" checked={granted} onChange={(event) => onChange(event.target.checked)} />
    <span>
      <strong>{row.displayName}</strong>
      <small>{row.detail}</small>
      <span className="connection-grant-row__meta"><em className={`connection-grant-row__status connection-grant-row__status--${statusClass}`}>{status}</em></span>
    </span>
  </label>
}

function GrantCheckbox({ label, detail, ids, value, onChange, className, disabled = false }: {
  label: string
  detail: string
  ids: string[]
  value: string[]
  onChange(next: string[]): void
  className?: string
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = ids.filter((id) => value.includes(id)).length
  const checked = ids.length > 0 && selected === ids.length
  useEffect(() => { if (inputRef.current !== null) inputRef.current.indeterminate = selected > 0 && !checked }, [checked, selected])
  return <label className={`connection-grant-row connection-grant-selector${checked ? ' is-granted' : ''}${className === undefined ? '' : ` ${className}`}`}>
    <input ref={inputRef} type="checkbox" checked={checked} disabled={disabled || ids.length === 0} onChange={(event) => onChange(toggleMany(ids, event.target.checked, value))} />
    <span><strong>{label}</strong><small>{detail}</small><span className="connection-grant-row__meta"><em>{selected} / {ids.length} 已选择</em></span></span>
  </label>
}

function toConnectionRow(item: IntegrationConnection, descriptor: IntegrationDescriptor): ConnectionRow {
  const endpoint = String(item.config.host ?? item.config.endpoint ?? item.config.baseUrl ?? item.config.provider ?? item.config.service ?? '')
  const credentialRequired = item.integrationId === 'builtin.ssh-device'
    || item.integrationId === LEGACY_FIRECRAWL_TYPE_ID
    || descriptor.secretFields.some((field) => field.required)
  return {
    id: item.id,
    displayName: item.displayName,
    detail: endpoint || '已配置连接',
    enabled: item.enabled,
    credentialConfigured: item.credentialConfigured,
    credentialRequired,
  }
}

function toggleMany(ids: string[], checked: boolean, value: string[]): string[] {
  const targets = new Set(ids)
  return checked ? [...new Set([...value, ...ids])] : value.filter((id) => !targets.has(id))
}

function onGrantChange(connectionId: string, checked: boolean, value: string[], onChange: (next: string[]) => void): void {
  onChange(checked ? [...new Set([...value, connectionId])] : value.filter((item) => item !== connectionId))
}
