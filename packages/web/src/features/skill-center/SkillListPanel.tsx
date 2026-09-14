import { FileCode, Folder, MagnifyingGlass, PencilSimple } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { SkillDetailView } from '@dsh-cyber/contracts'

import type { SkillCatalogEntry } from '../../components/skill-catalog.js'
import {
  groupSearchText,
  groupSkillCatalog,
  skillEntityMemberLabel,
  type SkillEntityGroup,
} from '../../components/skill-entity-grouping.js'

type SourceFilter = 'all' | SkillCatalogEntry['source']

export function SkillListPanel({ catalog, detail, selectedId, loadingDetail, onSelect, onEdit }: {
  catalog: SkillCatalogEntry[]
  detail?: SkillDetailView
  selectedId?: string
  loadingDetail: boolean
  onSelect(skillId: string): void
  onEdit(detail: SkillDetailView): void
}) {
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedFile, setSelectedFile] = useState<string>()
  useEffect(() => { setSelectedFile(detail?.files[0]?.path) }, [detail?.entry.id, detail?.files])
  const groups = useMemo(() => groupSkillCatalog(catalog), [catalog])
  const sourceCounts = useMemo(() => countSources(groups), [groups])
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return groups.filter((group) => (filter === 'all' || group.source === filter)
      && (needle === '' || groupSearchText(group).includes(needle)))
  }, [filter, groups, query])
  const selectedGroup = detail === undefined ? undefined : groups.find((group) => group.memberIds.includes(detail.entry.id))
  const currentFile = detail?.files.find((file) => file.path === selectedFile) ?? detail?.files[0]

  return <div className="skill-center__list-layout">
    <aside className="skill-center__source-rail" aria-label="技能来源筛选">
      {SOURCE_OPTIONS.map((option) => <button key={option.id} type="button" className={filter === option.id ? 'is-active' : ''} aria-current={filter === option.id} onClick={() => setFilter(option.id)}><span>{option.label}</span><small>{option.id === 'all' ? groups.length : sourceCounts.get(option.id) ?? 0}</small></button>)}
    </aside>
    <section className="skill-center__skill-list">
      <label className="skill-center__search"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能名称或 ID" aria-label="搜索技能列表" /></label>
      <div className="skill-center__skill-rows">
        {rows.map((group) => <button key={group.key} type="button" className={group.memberIds.includes(selectedId ?? '') ? 'is-active' : ''} aria-current={group.memberIds.includes(selectedId ?? '')} onClick={() => onSelect(group.primaryId)}>
          <span><strong>{group.displayName}</strong><code>{groupCode(group)}</code></span>
          <small>{sourceLabel(group.source)}{group.entries.length > 1 ? <>{' · '}{group.kind === 'mcp-service' ? `${group.entries.length} 个工具` : `${group.entries.length} 项能力`}</> : null}</small>
        </button>)}
        {rows.length === 0 ? <p className="skill-center__empty-inline">当前筛选下没有技能。</p> : null}
      </div>
    </section>
    <section className="skill-center__inspector" aria-label="技能详情">
      {loadingDetail ? <div className="skill-center__empty">正在读取 Skill 内容…</div> : detail === undefined ? <div className="skill-center__empty"><strong>选择一个技能</strong><span>这里会显示文件树、Skill 内容与版本信息。</span></div> : <>
        <header className="skill-center__inspector-header">
          <div><strong>{selectedGroup?.displayName ?? detail.entry.displayName}</strong><code>{selectedGroup === undefined ? detail.entry.id : groupCode(selectedGroup)}</code></div>
          <button type="button" onClick={() => onEdit(detail)}><PencilSimple size={14} />{detail.editable ? '编辑技能' : '基于此技能新建'}</button>
        </header>
        <p className="skill-center__inspector-summary">{selectedGroup?.summary ?? detail.entry.summary}</p>
        {selectedGroup === undefined ? null : <SkillEntityInspector group={selectedGroup} selectedId={detail.entry.id} onSelect={onSelect} />}
        <div className="skill-center__file-layout">
          <nav className="skill-center__file-tree" aria-label="Skill 文件树">
            <div className="skill-center__tree-root"><Folder size={14} /><strong>{detail.packageId ?? detail.entry.id}</strong></div>
            {treeRows(detail.tree.map((item) => item.path)).map((node) => node.kind === 'folder'
              ? <div key={`folder:${node.path}`} className="skill-center__tree-folder" style={{ paddingLeft: `${10 + node.depth * 13}px` }}><Folder size={13} />{node.label}</div>
              : <button key={node.path} type="button" className={currentFile?.path === node.path ? 'is-active' : ''} style={{ paddingLeft: `${10 + node.depth * 13}px` }} onClick={() => setSelectedFile(node.path)}><FileCode size={13} /><span>{node.label}</span></button>)}
          </nav>
          <div className="skill-center__file-content">
            <header><strong>{currentFile?.path}</strong><span>{currentFile?.language}</span></header>
            <pre>{currentFile?.content ?? ''}</pre>
          </div>
        </div>
      </>}
    </section>
  </div>
}

const SOURCE_OPTIONS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: '全部技能' }, { id: 'builtin', label: '内置技能' }, { id: 'plugin', label: '技能包' }, { id: 'mcp', label: 'MCP 技能' }, { id: 'other', label: '连接技能' },
]

function sourceLabel(source: SkillCatalogEntry['source'] | undefined): string { return source === 'builtin' ? '内置' : source === 'plugin' ? '技能包' : source === 'mcp' ? 'MCP' : '连接' }
function countSources(groups: SkillEntityGroup[]): Map<string, number> { const result = new Map<string, number>(); for (const group of groups) if (group.source !== undefined) result.set(group.source, (result.get(group.source) ?? 0) + 1); return result }
function groupCode(group: SkillEntityGroup): string {
  if (group.kind === 'mcp-service') return group.mcpService?.id ?? group.primaryId
  if (group.kind === 'skill-package') return group.packageId ?? group.primaryId
  return group.primaryId
}

function SkillEntityInspector({ group, selectedId, onSelect }: { group: SkillEntityGroup; selectedId: string; onSelect(skillId: string): void }) {
  const dependencyKeys = new Set<string>()
  for (const entry of group.entries) for (const dependency of entry.dependencies ?? []) dependencyKeys.add(`${dependency.kind}:${dependency.id}`)
  return <div className="skill-center__entity-inspector">
    <div className="skill-center__entity-badges"><span>{group.kind === 'mcp-service' ? '连接服务' : group.kind === 'skill-package' ? '技能包' : '独立技能'}</span><span>{group.entries.length}{group.kind === 'mcp-service' ? ' 个工具' : ' 项能力'}</span></div>
    {dependencyKeys.size === 0 ? null : <p className="skill-center__entity-dependencies"><strong>依赖</strong>{[...dependencyKeys].map((key) => <code key={key}>{key.slice(key.indexOf(':') + 1)}</code>)}</p>}
    {group.entries.length <= 1 ? null : <details className="skill-center__entity-members" open={group.kind === 'mcp-service'}><summary>查看组成（{group.entries.length} 项）</summary><div>{group.entries.map((entry) => <button key={entry.id} type="button" className={entry.id === selectedId ? 'is-active' : ''} onClick={() => onSelect(entry.id)}><span>{skillEntityMemberLabel(group, entry)}</span><code>{entry.id}</code></button>)}</div></details>}
  </div>
}

interface TreeRow { kind: 'folder' | 'file'; path: string; label: string; depth: number }
function treeRows(paths: string[]): TreeRow[] {
  const result: TreeRow[] = []; const folders = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 0; index < segments.length - 1; index += 1) {
      const folder = segments.slice(0, index + 1).join('/')
      if (!folders.has(folder)) { folders.add(folder); result.push({ kind: 'folder', path: folder, label: segments[index]!, depth: index }) }
    }
    result.push({ kind: 'file', path, label: segments.at(-1)!, depth: segments.length - 1 })
  }
  return result
}
