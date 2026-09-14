import { useEffect, useMemo, useRef } from 'react'
import {
  groupSearchText,
  groupSkillItems,
  skillEntityMemberLabel,
  skillEntitySelectionState,
  toggleSkillEntity,
  toggleSkillIdInList,
  type SkillEntityDescriptor,
  type SkillEntityGroup,
} from '../skill-entity-grouping.js'
import { useI18n } from '../../i18n/runtime.js'

/**
 * The workshop's per-role Skill picker with service- and package-level aggregation.
 *
 * One "MCP · <connection name>" row stands for every tool of that service:
 * checking the row requests the whole service, unchecking removes the whole
 * service, and the expandable tool list still allows per-tool requests.
 * `value` is the role's `requestedSkillIds` — requests only; grants are
 * produced later by the recruitment/revision flow.
 */
export function WorkshopSkillPicker({ skills, value, query, onChange }: {
  skills: SkillEntityDescriptor[]
  value: string[]
  query: string
  onChange(next: string[]): void
}) {
  const { t } = useI18n()
  const trimmedQuery = query.trim().toLocaleLowerCase()
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills])
  const staleMcpItems = value
    .filter((id) => !skillById.has(id) && id.startsWith('mcp.'))
    .map((id): SkillEntityDescriptor => {
      const tail = id.slice('mcp.'.length)
      const dot = tail.indexOf('.')
      const service = dot > 0 ? tail.slice(0, dot) : tail
      return {
        id,
        displayName: `MCP 工具 · ${tail}`,
        summary: '该 MCP 工具请求当前没有匹配的目录项。',
        adapterId: 'builtin.mcp',
        risks: ['external-side-effect'],
        supportsScheduling: false,
        persistentApproval: 'forbidden',
        kind: 'integration',
        mcpService: { id: service, label: service },
        source: 'mcp',
        worldAvailable: false,
        availability: 'unavailable',
      }
    })
  const groups = useMemo(() => groupSkillItems([...skills, ...staleMcpItems]), [skills, staleMcpItems])
  const visibleGroups = groups.filter((group) => trimmedQuery === '' || groupSearchText(group).includes(trimmedQuery))
  if (visibleGroups.length === 0) {
    return <div className="dialog-empty">{t('workshop.permissions.noMatches', '没有匹配的技能。')}</div>
  }
  return <div className="creative-workshop-skill-catalog">
    {visibleGroups.map((group) => <SkillEntityPickerRow key={group.key} group={group} value={value} onChange={onChange} t={t} />)}
  </div>
}

function SkillEntityPickerRow({ group, value, onChange, t }: {
  group: SkillEntityGroup<SkillEntityDescriptor>
  value: string[]
  onChange(next: string[]): void
  t: ReturnType<typeof useI18n>['t']
}) {
  const { checked, indeterminate, selectedCount } = skillEntitySelectionState(group, value)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])
  const dead = group.availableIds.length === 0
  const isMcp = group.kind === 'mcp-service'
  const isPackage = group.kind === 'skill-package'
  const label = group.displayName
  const countLabel = isMcp ? t('workshop.permissions.mcpServiceTools', '{count} 个工具', { count: group.entries.length }) : t('workshop.permissions.skillPackageMembers', '{count} 项能力', { count: group.entries.length })
  return <div className={`creative-workshop-skill-catalog__entity${isMcp ? ' creative-workshop-skill-catalog__mcp-service' : ''}${checked || selectedCount > 0 ? ' is-selected' : ''}${dead ? ' is-unavailable' : ''}`}>
    <input ref={inputRef} type="checkbox" aria-label={isMcp ? t('workshop.permissions.mcpServiceAria', 'MCP 服务 {name}', { name: group.mcpService?.label ?? label }) : isPackage ? t('workshop.permissions.skillPackageAria', '技能包 {name}', { name: label }) : t('workshop.permissions.skillAria', '技能 {name}', { name: label })} checked={checked} disabled={dead && selectedCount === 0} onChange={(event) => onChange(toggleSkillEntity(group, value, event.target.checked))} />
    <span>
      <strong>{label}</strong>
      <small>{dead
        ? t('workshop.permissions.mcpServiceDeadHint', '该技能当前不可用。取消勾选可移除保留的请求。')
        : isMcp ? t('workshop.permissions.mcpServiceHint', '共 {count} 个工具 · 外部操作需审批。勾选即请求该服务下的全部工具；授权仍由角色创建后的 Skill 授权决定。', { count: group.entries.length }) : isPackage ? t('workshop.permissions.skillPackageHint', '技能包中的多个入口归属于同一个 Skill，可整体请求并按入口查看。', {}) : t('workshop.permissions.skillHint', '这项 Skill 可直接请求，授权仍由角色创建后的 Skill 授权决定。', {})}</small>
      {group.entries.length <= 1 ? null : <details className="creative-workshop-skill-catalog__mcp-tools"><summary>{countLabel}</summary><div>{group.entries.map((item) => {
        const selected = value.includes(item.id)
        return <label key={item.id} className={selected ? 'is-selected' : ''}>
          <input type="checkbox" checked={selected} disabled={item.worldAvailable === false || item.availability === 'unavailable'} onChange={(event) => onChange(toggleSkillIdInList(value, item.id, event.target.checked))} />
          <span><code>{skillEntityMemberLabel(group, item)}</code><em>{item.kind === 'integration' ? t('workshop.permissions.riskExternal', '外部操作需审批') : t('workshop.permissions.method', '工作方法')}</em></span>
        </label>
      })}</div></details>}
    </span>
  </div>
}
