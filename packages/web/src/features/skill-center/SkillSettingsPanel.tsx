import { ArrowCounterClockwise, MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkillScopeView, SkillSettingsView } from '@dsh-cyber/contracts'

import type { SkillCatalogEntry } from '../../components/skill-catalog.js'
import {
  groupSearchText,
  groupSkillCatalog,
  skillEntityMemberLabel,
  skillEntitySelectionState,
  toggleSkillEntity,
  type SkillEntityGroup,
} from '../../components/skill-entity-grouping.js'

export function SkillSettingsPanel({ catalog, settings, busy, onSave }: {
  catalog: SkillCatalogEntry[]
  settings?: SkillSettingsView
  busy: boolean
  onSave(scope: SkillScopeView, skillIds: string[], inherit?: boolean): Promise<void>
}) {
  const scopes = useMemo(() => settings === undefined ? [] : [settings.global, ...settings.worlds], [settings])
  const [scopeKey, setScopeKey] = useState<string>()
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const activeScope = scopes.find((scope) => `${scope.scope}:${scope.scopeId}` === scopeKey) ?? scopes[0]
  useEffect(() => {
    if (activeScope === undefined) return
    setScopeKey(`${activeScope.scope}:${activeScope.scopeId}`)
    setSelected([...activeScope.skillIds])
  }, [activeScope?.scope, activeScope?.scopeId, activeScope?.skillIds.join('\u0000')])
  const groups = useMemo(() => groupSkillCatalog(catalog), [catalog])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return groups.filter((group) => needle === '' || groupSearchText(group).includes(needle))
  }, [groups, query])
  const selectable = useMemo(() => [...new Set(groups.flatMap((group) => [
    ...group.availableIds,
    ...group.memberIds.filter((id) => selected.includes(id)),
  ]))], [groups, selected])
  const changed = activeScope !== undefined && !sameSet(selected, activeScope.skillIds)

  return <div className="skill-center__settings-layout">
    <aside className="skill-center__scope-rail" aria-label="技能设置范围">
      <header><strong>应用范围</strong><small>全局与所有世界</small></header>
      {scopes.map((scope) => {
        const key = `${scope.scope}:${scope.scopeId}`
        return <button key={key} type="button" className={activeScope === scope ? 'is-active' : ''} aria-current={activeScope === scope} onClick={() => { setScopeKey(key); setSelected([...scope.skillIds]) }}>
          <span><strong>{scope.displayName}</strong><small>{scope.scope === 'workspace' ? '所有世界默认值' : scope.inherited ? '跟随全局' : scope.configured ? '单独设置' : '兼容默认'}</small></span><em>{selectedEntityCount(groups, scope.skillIds)}</em>
        </button>
      })}
    </aside>
    <section className="skill-center__settings-main">
      {activeScope === undefined ? <div className="skill-center__empty">正在读取技能设置…</div> : <>
        <header className="skill-center__settings-header">
          <div><h3>{activeScope.displayName}</h3><p>{activeScope.scope === 'workspace' ? '作为所有世界的默认 Skill 集合；世界可以保存自己的覆盖配置。' : '勾选当前世界加载的 Skill。角色仍通过自己的技能引用获得使用资格。'}</p></div>
          <div className="skill-center__settings-actions">
            {activeScope.scope === 'world' && (activeScope.configured || changed) ? <button type="button" disabled={busy} onClick={() => void onSave(activeScope, [], true)}><ArrowCounterClockwise size={14} />跟随全局</button> : null}
            <button type="button" className="primary-button" disabled={busy || !changed} onClick={() => void onSave(activeScope, selected)}>{busy ? '正在保存…' : '保存技能设置'}</button>
          </div>
        </header>
        <div className="skill-center__settings-toolbar">
          <label className="skill-center__search"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索可用技能" aria-label="搜索技能设置" /></label>
          <SelectAll ids={selectable} selected={selected} onChange={setSelected} />
        </div>
        <div className="skill-center__check-list">
          {visible.map((group) => <SkillSettingsEntityRow key={group.key} group={group} selected={selected} onChange={setSelected} />)}
        </div>
      </>}
    </section>
  </div>
}

function SkillSettingsEntityRow({ group, selected, onChange }: { group: SkillEntityGroup; selected: string[]; onChange(next: string[]): void }) {
  const { checked, indeterminate, selectedCount } = skillEntitySelectionState(group, selected)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (inputRef.current !== null) inputRef.current.indeterminate = indeterminate }, [indeterminate])
  const available = group.availableIds.length > 0
  const status = !available ? '当前不可用' : checked ? '已启用' : indeterminate ? '部分启用' : '可用'
  return <label className={`${checked || selectedCount > 0 ? 'is-checked' : ''}${available ? '' : ' is-unavailable'}`}>
    <input ref={inputRef} type="checkbox" checked={checked} disabled={!available && selectedCount === 0} onChange={(event) => onChange(toggleSkillEntity(group, selected, event.target.checked))} />
    <span><strong>{group.displayName}</strong><small>{group.summary}</small><code>{groupCode(group)}{group.entries.length > 1 ? ` · ${group.entries.length}${group.kind === 'mcp-service' ? ' 个工具' : ' 项能力'}` : ''}</code>{group.entries.length > 1 ? <details className="skill-center__settings-members"><summary>查看组成</summary><div>{group.entries.map((entry) => <span key={entry.id}><code>{skillEntityMemberLabel(group, entry)}</code><em>{entry.worldAvailable === false || entry.availability === 'unavailable' ? '当前不可用' : selected.includes(entry.id) ? '已启用' : '可用'}</em></span>)}</div></details> : null}</span>
    <em>{group.source === 'builtin' ? '内置' : group.source === 'mcp' ? 'MCP' : group.source === 'plugin' ? '技能包' : '连接'} · {status}</em>
  </label>
}

function SelectAll({ ids, selected, onChange }: { ids: string[]; selected: string[]; onChange(next: string[]): void }) {
  const ref = useRef<HTMLInputElement>(null)
  const count = ids.filter((id) => selected.includes(id)).length
  const checked = ids.length > 0 && count === ids.length
  useEffect(() => { if (ref.current !== null) ref.current.indeterminate = count > 0 && !checked }, [checked, count])
  return <label className="skill-center__select-all"><input ref={ref} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked ? [...new Set([...selected, ...ids])] : selected.filter((id) => !ids.includes(id)))} /><span>全部勾选</span><small>{count}/{ids.length}</small></label>
}

function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item) => right.includes(item)) }
function groupCode(group: SkillEntityGroup): string { return group.kind === 'mcp-service' ? group.mcpService?.id ?? group.primaryId : group.kind === 'skill-package' ? group.packageId ?? group.primaryId : group.primaryId }
function selectedEntityCount(groups: readonly SkillEntityGroup[], selected: readonly string[]): number { return groups.filter((group) => group.memberIds.some((id) => selected.includes(id))).length }
