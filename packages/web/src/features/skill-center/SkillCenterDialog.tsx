import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, MagnifyingGlass, Package, PuzzlePiece, X } from '@phosphor-icons/react'
import type { EmployeeDossier, EmployeeInstance, World, WorldPackageInstance } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { normalizeSkillCatalog, type SkillCatalogEntry } from '../../components/skill-catalog.js'
import { useDialogFocusTrap } from '../../components/useDialogFocusTrap.js'
import './skill-center.css'

type Filter = 'all' | 'loaded' | 'loadable'

interface SkillCenterSnapshot {
  catalog: SkillCatalogEntry[]
  packages: WorldPackageInstance[]
  dossiers: EmployeeDossier[]
}

export function SkillCenterDialog({ world, employees, onClose, onOpenMarket }: { world: World; employees: EmployeeInstance[]; onClose(): void; onOpenMarket?(): void }) {
  const [snapshot, setSnapshot] = useState<SkillCenterSnapshot>({ catalog: [], packages: [], dossiers: [] })
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocusTrap(dialogRef, onClose)

  const load = async (): Promise<void> => {
    const [catalog, packages, worldSnapshot] = await Promise.all([
      api<unknown>(`/api/worlds/${encodeURIComponent(world.id)}/skill-catalog`),
      api<{ items: WorldPackageInstance[] }>(`/api/worlds/${encodeURIComponent(world.id)}/packages`),
      api<{ dossiers?: EmployeeDossier[] }>(`/api/worlds/${encodeURIComponent(world.id)}/snapshot`),
    ])
    setSnapshot({ catalog: normalizeSkillCatalog(catalog), packages: packages.items, dossiers: worldSnapshot.dossiers ?? [] })
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void load().catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '技能中心加载失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // The dialog owns one snapshot for the selected world.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.id])

  const activeInstances = useMemo(() => new Map(snapshot.packages.filter((item) => item.status === 'active').map((item) => [`${item.packageId}@${item.packageVersion}`, item])), [snapshot.packages])
  const grantsByEmployee = useMemo(() => new Map(snapshot.dossiers.map((dossier) => {
    const revision = dossier.revisions.find((item) => item.revision === dossier.employee.currentRevision)
    return [dossier.employee.id, revision?.skillGrants ?? []] as const
  })), [snapshot.dossiers])
  const skillIdsByPackage = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const entry of snapshot.catalog) {
      if (entry.packageId === undefined) continue
      const ids = result.get(entry.packageId) ?? new Set<string>()
      ids.add(entry.id); result.set(entry.packageId, ids)
    }
    return result
  }, [snapshot.catalog])
  const rows = useMemo(() => snapshot.catalog.filter((entry) => {
    const text = `${entry.displayName} ${entry.summary} ${entry.id}`.toLowerCase()
    const matchesQuery = query.trim() === '' || text.includes(query.trim().toLowerCase())
    const matchesFilter = filter === 'all' || (filter === 'loaded' ? entry.worldAvailable : !entry.worldAvailable && entry.packageId !== undefined)
    return matchesQuery && matchesFilter
  }), [filter, query, snapshot.catalog])

  const refresh = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setError(undefined)
    try { await action(); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '技能中心操作失败') }
    finally { setBusy(undefined) }
  }

  const toggleEmployee = (entry: SkillCatalogEntry, employee: EmployeeInstance, checked: boolean): Promise<void> => refresh(`${entry.id}:${employee.id}`, async () => {
    const current = grantsByEmployee.get(employee.id) ?? []
    const skillGrants = checked ? [...new Set([...current, entry.id])] : current.filter((id) => id !== entry.id)
    await api(`/api/employees/${encodeURIComponent(employee.id)}/revisions`, {
      method: 'POST',
      body: JSON.stringify({ reason: `${checked ? '引用' : '移除'}技能中心技能：${entry.displayName}`, skillGrants }),
    })
  })

  const toggleAllEmployees = (entry: SkillCatalogEntry, checked: boolean): Promise<void> => refresh(`${entry.id}:all`, async () => {
    await Promise.all(employees.map((employee) => {
      const current = grantsByEmployee.get(employee.id) ?? []
      const skillGrants = checked ? [...new Set([...current, entry.id])] : current.filter((id) => id !== entry.id)
      return api(`/api/employees/${encodeURIComponent(employee.id)}/revisions`, {
        method: 'POST',
        body: JSON.stringify({ reason: `${checked ? '引用' : '移除'}技能中心技能：${entry.displayName}`, skillGrants }),
      })
    }))
  })

  const loadPackage = (entry: SkillCatalogEntry): Promise<void> => refresh(`${entry.id}:package`, () => api(`/api/worlds/${encodeURIComponent(world.id)}/packages/instantiate`, {
    method: 'POST', body: JSON.stringify({ packageId: entry.packageId, version: entry.packageVersion }),
  }))

  const unloadPackage = (entry: SkillCatalogEntry): Promise<void> => {
    const instance = activeInstances.get(`${entry.packageId}@${entry.packageVersion}`)
    return instance === undefined ? Promise.resolve() : refresh(`${entry.id}:package`, () => api(`/api/world-package-instances/${encodeURIComponent(instance.id)}/disable`, { method: 'POST', body: '{}' }))
  }

  const loadedCount = snapshot.catalog.filter((entry) => entry.worldAvailable).length
  const assignedCount = snapshot.catalog.filter((entry) => employees.some((employee) => grantsByEmployee.get(employee.id)?.includes(entry.id))).length

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="skill-center" role="dialog" aria-modal="true" aria-labelledby="skill-center-title">
      <header className="skill-center__header">
        <div><h2 id="skill-center-title"><PuzzlePiece size={21} />技能中心</h2><p>{world.name} 的 Skill 依赖与角色引用。技能定义保持单份，世界和角色通过 ID 引用并跟随版本更新。</p></div>
        <button type="button" className="icon-button" data-dialog-initial-focus aria-label="关闭技能中心" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="skill-center__summary" aria-label="技能中心摘要">
        <div><strong>{loadedCount}</strong><span>当前世界已加载</span></div><div><strong>{assignedCount}</strong><span>已分配给角色</span></div><div><strong>{employees.length}</strong><span>当前世界角色</span></div>
      </div>
      <div className="skill-center__toolbar">
        <label><MagnifyingGlass size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能名称、说明或 ID" /></label>
        <div role="group" aria-label="技能筛选">
          {([['all', '全部技能'], ['loaded', '已加载'], ['loadable', '可加载']] as const).map(([id, label]) => <button key={id} type="button" className={filter === id ? 'is-active' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
        </div>
      </div>
      {error === undefined ? null : <div className="permission-notice permission-notice--warning" role="alert"><p>{error}</p></div>}
      <div className="skill-center__content">
        {loading ? <div className="dialog-empty" role="status">正在读取当前世界技能…</div> : rows.length === 0 ? <div className="dialog-empty">当前筛选下没有技能。</div> : rows.map((entry) => {
          const assigned = employees.filter((employee) => grantsByEmployee.get(employee.id)?.includes(entry.id))
          const packageLoaded = entry.packageId !== undefined && activeInstances.has(`${entry.packageId}@${entry.packageVersion}`)
          const canLoad = !entry.worldAvailable && entry.packageId !== undefined && entry.packageVersion !== undefined
          const needsInstall = !entry.worldAvailable && entry.packageId !== undefined && entry.packageVersion === undefined
          const packageSkillIds = entry.packageId === undefined ? new Set([entry.id]) : skillIdsByPackage.get(entry.packageId) ?? new Set([entry.id])
          const packageAssigned = employees.some((employee) => (grantsByEmployee.get(employee.id) ?? []).some((id) => packageSkillIds.has(id)))
          const allAssigned = employees.length > 0 && assigned.length === employees.length
          return <article key={entry.id} className={`skill-center-card${entry.worldAvailable ? ' is-loaded' : ' is-unavailable'}`}>
            <header><div className="skill-center-card__icon"><PuzzlePiece size={19} /></div><div><strong>{entry.displayName}</strong><code>{entry.id}</code></div><span>{entry.worldAvailable ? <><Check size={14} />已加载</> : canLoad ? '等待加载' : needsInstall ? '等待安装' : '当前不可用'}</span></header>
            <p>{entry.summary}</p>
            <div className="skill-center-card__meta"><span>{sourceLabel(entry)}</span>{entry.packageVersion === undefined ? null : <span>版本 {entry.packageVersion}</span>}<span>{entry.kind === 'integration' ? '连接型技能' : '工作方法'}</span></div>
            {entry.worldAvailable ? <section className="skill-center-card__roles">
              <header><strong>引用到角色</strong><label><input type="checkbox" checked={allAssigned} onChange={(event) => void toggleAllEmployees(entry, event.target.checked)} disabled={busy !== undefined || employees.length === 0} />全选</label></header>
              {employees.length === 0 ? <p>当前世界暂无角色。</p> : <div>{employees.map((employee) => <label key={employee.id}><input type="checkbox" checked={grantsByEmployee.get(employee.id)?.includes(entry.id) === true} disabled={busy !== undefined} onChange={(event) => void toggleEmployee(entry, employee, event.target.checked)} /><span>{employee.displayName}</span><small>{employee.role}</small></label>)}</div>}
            </section> : null}
            {canLoad ? <button className="primary-button" type="button" disabled={busy !== undefined} onClick={() => void loadPackage(entry)}><Package size={16} />{busy === `${entry.id}:package` ? '正在加载…' : '加载到当前世界'}</button> : packageLoaded ? <button className="secondary-button" type="button" disabled={busy !== undefined || packageAssigned} title={packageAssigned ? '先移除这个技能包的全部角色引用后再卸载' : ''} onClick={() => void unloadPackage(entry)}>从当前世界卸载</button> : null}
            {needsInstall ? <button className="secondary-button" type="button" onClick={() => { onClose(); onOpenMarket?.() }}><Package size={16} />前往市场安装技能包</button> : null}
          </article>
        })}
      </div>
    </section>
  </div>, document.body)
}

function sourceLabel(entry: SkillCatalogEntry): string {
  if (entry.source === 'plugin') return '技能包'
  if (entry.source === 'mcp') return 'MCP 技能'
  if (entry.source === 'builtin') return '内置技能'
  return '扩展技能'
}
