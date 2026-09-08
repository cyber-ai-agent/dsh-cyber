import { useEffect, useMemo, useState } from 'react'
import type { EmployeeInstance, IntegrationConnection, IntegrationDescriptor } from '@dsh-cyber/contracts'

import { api } from '../api.js'
import './ConnectionGrantEditor.css'

interface ConnectionGrantEditorProps {
  employee: EmployeeInstance
  /** Connection-hub connection ids currently granted to this character. */
  value: string[]
  onChange(next: string[]): void
}

interface DeviceRow {
  id: string
  displayName: string
  host: string
  enabled: boolean
  credentialConfigured: boolean
}

/**
 * Second half of the skill+connection authorization pair. Where the role's
 * 技能与工具 tab grants which skills exist, this list grants which concrete
 * hub connections (SSH devices, future API endpoints) the character may
 * actually drive. Only connection types that declare
 * `allowsMultipleConnections` expose device-level grants; single-connection
 * types keep their own whole-connection flow.
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

  const deviceTypes = useMemo(
    () => descriptors.filter((descriptor) => descriptor.allowsMultipleConnections === true && descriptor.skillIds.length > 0),
    [descriptors],
  )
  const typeById = useMemo(() => new Map(descriptors.map((item) => [item.id, item])), [descriptors])
  const deviceIds = useMemo(() => new Set(items.filter((item) => typeById.get(item.integrationId)?.allowsMultipleConnections === true).map((item) => item.id)), [items, typeById])
  // Grants whose device was deleted from the hub stay visible so the user can
  // revoke them explicitly instead of leaving a silent dangling grant.
  const revoked = useMemo(() => value.filter((id) => !deviceIds.has(id)), [deviceIds, value])

  const groups = deviceTypes.map((descriptor) => {
    const rows: DeviceRow[] = items
      .filter((item) => item.integrationId === descriptor.id)
      .map((item) => ({
        id: item.id,
        displayName: item.displayName,
        host: String(item.config.host ?? item.config.endpoint ?? ''),
        enabled: item.enabled,
        credentialConfigured: item.credentialConfigured,
      }))
    return { descriptor, rows }
  })

  if (loading) return <div className="dialog-empty" role="status">正在读取本工作区的连接…</div>
  if (error !== undefined) return <div className="permission-notice permission-notice--warning" role="alert"><p>{error}</p><small>连接授权不会因此失效；请稍后重试或前往“连接中心”查看。</small></div>
  if (groups.length === 0 && revoked.length === 0) {
    return <div className="connection-grant-editor connection-grant-editor--empty"><header><div><h4>连接授权</h4><span>0 项</span></div></header><p>当前还没有可勾选的设备连接。请先在顶部“连接中心”添加 SSH 设备后，再回来勾选这台角色可以操作的设备。</p></div>
  }

  return <div className="connection-grant-editor">
    <section className="connection-grant-group" aria-labelledby="connection-grant-title">
      <header><div><h4 id="connection-grant-title">连接授权</h4><span>{value.filter((id) => deviceIds.has(id)).length} 项</span></div></header>
      <p className="connection-grant-editor__note">技能授权决定角色“能做什么”，这里的连接授权决定“能用哪台设备”。角色需要同时在“技能与工具”里拥有对应技能并在此勾选设备，设备操作才会被允许。</p>
      {groups.map(({ descriptor, rows }) => <div key={descriptor.id} className="connection-grant-type">
        <div className="connection-grant-type__title">{descriptor.displayName}{rows.length === 0 ? <em>暂无设备</em> : null}</div>
        {rows.length === 0 ? <p className="connection-grant-group__empty">这个类型还没有添加设备。</p> : rows.map((row) => <ConnectionGrantRow key={row.id} row={row} granted={value.includes(row.id)} onChange={(checked) => onGrantChange(row.id, checked, value, onChange)} />)}
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

function ConnectionGrantRow({ row, granted, onChange }: { row: DeviceRow; granted: boolean; onChange(checked: boolean): void }) {
  const usable = row.enabled && row.credentialConfigured
  const status = !row.enabled ? '已停用' : !row.credentialConfigured ? '缺少凭据' : granted ? '已授权' : '可授权'
  const statusClass = granted ? 'granted' : usable ? 'available' : 'disabled'
  return <label className={`connection-grant-row${granted ? ' is-granted' : ''}${usable ? '' : ' is-unusable'}`}>
    <input type="checkbox" checked={granted} onChange={(event) => onChange(event.target.checked)} />
    <span>
      <strong>{row.displayName}</strong>
      <small>{row.host || '未填写地址'}</small>
      <span className="connection-grant-row__meta"><em className={`connection-grant-row__status connection-grant-row__status--${statusClass}`}>{status}</em></span>
    </span>
  </label>
}

function onGrantChange(connectionId: string, checked: boolean, value: string[], onChange: (next: string[]) => void): void {
  onChange(checked ? [...new Set([...value, connectionId])] : value.filter((item) => item !== connectionId))
}
