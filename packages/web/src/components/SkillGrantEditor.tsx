import { useEffect, useMemo, useRef, useState } from 'react'
import type { EmployeeBlueprint, EmployeeInstance } from '@dsh-cyber/contracts'

import { api } from '../api.js'
import {
  normalizeSkillCatalog,
  skillCatalogErrorMessage,
  worldBlueprintCatalogPath,
  worldSkillCatalogPath,
  type SkillCatalogEntry,
} from './skill-catalog.js'
import {
  groupSkillCatalog,
  skillEntityMemberLabel,
  skillEntitySelectionState,
  toggleSkillEntity,
  type SkillEntityGroup,
} from './skill-entity-grouping.js'
import './SkillGrantEditor.css'

interface SkillGrantEditorProps {
  employee: EmployeeInstance
  value: string[]
  onChange(next: string[]): void
}

export function SkillGrantEditor({ employee, value, onChange }: SkillGrantEditorProps) {
  const [blueprint, setBlueprint] = useState<EmployeeBlueprint>()
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([
      api<{ items: EmployeeBlueprint[] }>(worldBlueprintCatalogPath(employee.worldId)),
      api<unknown>(worldSkillCatalogPath(employee.worldId)),
    ]).then(([blueprints, skills]) => {
      if (cancelled) return
      setBlueprint(blueprints.items.find((item) => item.id === employee.blueprintId && item.version === employee.blueprintVersion))
      setCatalog(normalizeSkillCatalog(skills))
      setError(undefined)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(skillCatalogErrorMessage(cause))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [employee.blueprintId, employee.blueprintVersion, employee.worldId])

  const requested = blueprint?.requestedSkills ?? []
  const entryById = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog])
  // Historical grants whose catalog entry is gone remain revocable through
  // the same entity row as their sibling tools.
  const legacyOrphans = useMemo(() => {
    const rows: SkillCatalogEntry[] = []
    const known = new Set(catalog.map((item) => item.id))
    for (const skillId of value) {
      if (known.has(skillId) || entryById.has(skillId)) continue
      rows.push(legacyUnavailableSkill(skillId))
      known.add(skillId)
    }
    return rows
  }, [catalog, entryById, value])

  const entityGroups = useMemo(() => groupSkillCatalog([...catalog, ...legacyOrphans]), [catalog, legacyOrphans])
  const recommendedRows = entityGroups.filter((group) => group.entries.some((item) => isLearnable(item) && requested.includes(item.id)))
  const learnableRows = entityGroups.filter((group) => group.availableIds.length > 0 && !recommendedRows.includes(group))
  const unavailableRows = entityGroups.filter((group) => group.availableIds.length === 0 && group.memberIds.some((id) => value.includes(id)))

  if (loading) return <div className="dialog-empty" role="status">正在读取当前世界的技能目录…</div>
  if (error !== undefined) return <div className="permission-notice permission-notice--warning" role="alert"><p>{error}</p></div>
  if (catalog.length === 0 && value.length === 0) return <div className="dialog-empty">当前世界没有可学习的角色技能。</div>

  return <div className="skill-grant-editor">
    {blueprint === undefined ? <div className="skill-grant-editor__hint">没有找到这个角色对应的蓝图版本；保留中的历史授权仍可在“当前不可用”中撤销。</div> : null}
    <SkillGrantGroup title="推荐技能" rows={recommendedRows} empty="这个角色没有可默认推荐的角色技能。" value={value} onChange={onChange} recommended />
    <SkillGrantGroup title="其他可学习技能" rows={learnableRows} empty="当前世界没有其他可学习的角色技能。" value={value} onChange={onChange} />
    <SkillGrantGroup title="当前不可用" rows={unavailableRows} empty="没有不可用的历史授权。" value={value} onChange={onChange} />
    <p className="skill-grant-editor__note">已有角色可以学习蓝图未请求的角色技能；当前不可用的历史授权不会被静默删除，可保留或撤销。涉及外部操作时，系统仍会针对具体动作请求确认。</p>
  </div>
}

function SkillGrantGroup({ title, rows, empty, value, onChange, recommended = false }: {
  title: string
  rows: SkillEntityGroup[]
  empty: string
  value: string[]
  onChange(next: string[]): void
  recommended?: boolean
}) {
  return <section className="skill-grant-group" aria-labelledby={`skill-grant-${title}`}>
    <header><div><h4 id={`skill-grant-${title}`}>{title}</h4><span>{rows.length} 项</span></div></header>
    {rows.length === 0 ? <p className="skill-grant-group__empty">{empty}</p> : <div className="skill-grant-group__rows">{rows.map((group) => <SkillGrantRow key={group.key} group={group} value={value} recommended={recommended} onChange={onChange} />)}</div>}
  </section>
}

function SkillGrantRow({ group, value, recommended, onChange }: {
  group: SkillEntityGroup
  value: string[]
  recommended: boolean
  onChange(next: string[]): void
}) {
  const { checked, indeterminate, selectedCount } = skillEntitySelectionState(group, value)
  const available = group.availableIds.length > 0
  const status = !available ? '暂不可用' : checked ? '已启用' : indeterminate ? '部分启用' : recommended ? '推荐' : '可学习'
  const statusClass = status === '暂不可用' ? 'unavailable' : status === '已启用' ? 'granted' : status === '部分启用' ? 'partial' : status === '推荐' ? 'recommended' : 'learnable'
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])
  const external = group.entries.some((entry) => entry.risks.includes('external-side-effect'))
  const integration = group.entries.some((entry) => entry.kind === 'integration')
  return <label className={`skill-grant-row${checked || selectedCount > 0 ? ' is-granted' : ''}${available ? '' : ' is-unavailable'}${group.kind === 'mcp-service' ? ' skill-grant-row--mcp-service' : group.kind === 'skill-package' ? ' skill-grant-row--skill-package' : ''}`}>
    <input ref={inputRef} type="checkbox" checked={checked} disabled={!available && selectedCount === 0} onChange={(event) => onChange(toggleSkillEntity(group, value, event.target.checked))} />
    <span>
      <strong>{group.displayName}</strong>
      <small>{group.summary}</small>
      <span className="skill-grant-row__meta"><em className={`skill-grant-row__status skill-grant-row__status--${statusClass}`}>{status}</em><em>{external ? '涉及外部操作' : integration ? '外部连接' : '工作方法'}</em>{group.entries.length > 1 ? <em>{group.kind === 'mcp-service' ? `${group.entries.length} 个工具` : `${group.entries.length} 项能力`}</em> : null}</span>
      {group.entries.length > 1 ? <details className="skill-grant-row__tools"><summary>查看组成</summary><ul>{group.entries.map((entry) => <li key={entry.id} className={value.includes(entry.id) ? 'is-granted' : ''}><code>{skillEntityMemberLabel(group, entry)}</code><span>{isLearnable(entry) ? value.includes(entry.id) ? '已启用' : '可学习' : '暂不可用'}</span></li>)}</ul></details> : null}
    </span>
  </label>
}

function isLearnable(entry: SkillCatalogEntry): boolean {
  return entry.worldAvailable && entry.availability === 'available'
}

function legacyUnavailableSkill(id: string): SkillCatalogEntry {
  // A grantable MCP skill that no longer resolves to a catalog entry: the
  // owning MCP connection is unconfigured or its process/endpoint is down, or
  // the tool name changed. Keep it identifiable (service + tool) instead of
  // dumping the raw id, and point at the 连接中心 for the fix.
  if (id.startsWith('mcp.')) {
    const tail = id.slice(4)
    const dot = tail.indexOf('.')
    const service = dot > 0 ? tail.slice(0, dot) : tail
    const label = dot > 0 ? `${service} / ${tail.slice(dot + 1)}` : tail
    return {
      id,
      displayName: `MCP 工具 · ${label}`,
      summary: '这项 MCP 授权当前没有对应的目录项：对应 MCP 连接可能未配置、未启用或不可达，也可能工具已改名。可到顶部“连接中心”检查该连接；保留此授权不会自动生效，取消勾选即可撤销。',
      adapterId: 'builtin.mcp',
      risks: ['external-side-effect'],
      supportsScheduling: false,
      persistentApproval: 'forbidden',
      kind: 'integration',
      mcpService: { id: service, label: service },
      source: 'mcp',
      scope: 'workspace',
      globalKnown: false,
      worldAvailable: false,
      availability: 'unavailable',
    }
  }
  return {
    id,
    displayName: id,
    summary: '这项历史授权当前没有对应的技能目录项。可以保留，或取消勾选撤销。',
    adapterId: 'unknown',
    risks: [],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    source: 'other',
    scope: 'world',
    globalKnown: false,
    worldAvailable: false,
    availability: 'unavailable',
  }
}
