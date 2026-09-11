import { useEffect, useMemo, useRef } from 'react'
import type { CharacterSkillDescriptor } from '@dsh-cyber/contracts/creative-platform'
import {
  groupMcpServicesFromItems,
  mcpServiceChecked,
  mcpServiceToggle,
  toggleSkillIdInList,
  type McpServiceGroup,
  type McpServiceTool,
} from '../mcp-skill-grouping.js'
import { useI18n } from '../../i18n/runtime.js'

/**
 * The workshop's per-role skill picker with service-level MCP aggregation.
 *
 * One "MCP · <connection name>" row stands for every tool of that service:
 * checking the row requests the whole service, unchecking removes the whole
 * service, and the expandable tool list still allows per-tool requests.
 * Non-MCP skills keep the flat one-row-per-skill layout. `value` is the
 * role's `requestedSkillIds` — requests only; grants are produced later by
 * the recruitment/revision flow.
 */
export function WorkshopSkillPicker({ skills, value, query, onChange }: {
  skills: CharacterSkillDescriptor[]
  value: string[]
  query: string
  onChange(next: string[]): void
}) {
  const { t } = useI18n()
  const trimmedQuery = query.trim().toLocaleLowerCase()
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills])
  const groups = useMemo(() => groupMcpServicesFromItems(skills, value, value), [skills, value])
  const skillMatches = (skill: CharacterSkillDescriptor): boolean =>
    trimmedQuery === '' || `${skill.displayName} ${skill.summary} ${skill.id}`.toLocaleLowerCase().includes(trimmedQuery)
  const flatSkills = skills.filter((skill) => skill.mcpService === undefined && skillMatches(skill))
  const serviceRows: { group: McpServiceGroup; tools: McpServiceTool[] }[] = []
  for (const group of groups) {
    const serviceMatches = trimmedQuery === '' || `MCP · ${group.label} ${group.serviceId}`.toLocaleLowerCase().includes(trimmedQuery)
    const tools = serviceMatches
      ? group.tools
      : group.tools.filter((tool) => {
        const descriptor = skillById.get(tool.id)
        return descriptor !== undefined && skillMatches(descriptor)
      })
    // A dead service (tools gone, requests still held) stays revocable when
    // not searching.
    const deadOrphan = group.tools.length === 0 && group.grantedIds.length > 0
    if (tools.length > 0 || (trimmedQuery === '' && deadOrphan)) serviceRows.push({ group, tools })
  }
  if (serviceRows.length === 0 && flatSkills.length === 0) {
    return <div className="dialog-empty">{t('workshop.permissions.noMatches', '没有匹配的技能。')}</div>
  }
  return <div className="creative-workshop-skill-catalog">
    {serviceRows.map(({ group, tools }) => <McpServicePickerRow key={`mcp-service-${group.serviceId}`} group={group} tools={tools} value={value} onChange={onChange} />)}
    {flatSkills.map((skill) => {
      const selected = value.includes(skill.id)
      return <label key={skill.id} className={selected ? 'is-selected' : ''}>
        <input type="checkbox" checked={selected} onChange={(event) => onChange(toggleSkillIdInList(value, skill.id, event.target.checked))} />
        <span><strong>{skill.displayName}</strong><small>{skill.summary}</small><em>{skill.kind === 'integration' ? t('workshop.permissions.external', '外部连接') : t('workshop.permissions.method', '工作方法')} · {riskLabel(skill, t)}</em></span>
      </label>
    })}
  </div>
}

function McpServicePickerRow({ group, tools, value, onChange }: {
  group: McpServiceGroup
  tools: McpServiceTool[]
  value: string[]
  onChange(next: string[]): void
}) {
  const { t } = useI18n()
  const { checked, indeterminate } = mcpServiceChecked(group, value)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])
  const dead = group.tools.length === 0
  return <div className={`creative-workshop-skill-catalog__mcp-service${checked ? ' is-selected' : ''}${dead ? ' is-unavailable' : ''}`}>
    <input ref={inputRef} type="checkbox" aria-label={t('workshop.permissions.mcpServiceAria', 'MCP 服务 {name}', { name: group.label })} checked={checked} onChange={(event) => onChange(mcpServiceToggle(group, value, event.target.checked))} />
    <span>
      <strong>{t('workshop.permissions.mcpServiceLabel', 'MCP · {name}', { name: group.label })}</strong>
      <small>{dead
        ? t('workshop.permissions.mcpServiceDeadHint', '该 MCP 服务当前不可用（连接未配置、已停用或不可达）。取消勾选可移除对应的技能请求。')
        : t('workshop.permissions.mcpServiceHint', '共 {count} 个工具 · 外部操作需审批。勾选即请求该 MCP 服务下的全部工具；授权仍由角色创建后的 Skill 授权决定。', { count: group.tools.length })}</small>
      {dead ? null : <details className="creative-workshop-skill-catalog__mcp-tools"><summary>{t('workshop.permissions.mcpServiceTools', '{count} 个工具', { count: tools.length })}</summary><div>{tools.map((tool) => {
        const selected = value.includes(tool.id)
        return <label key={tool.id} className={selected ? 'is-selected' : ''}>
          <input type="checkbox" checked={selected} onChange={(event) => onChange(toggleSkillIdInList(value, tool.id, event.target.checked))} />
          <span><code>{tool.name}</code><em>{t('workshop.permissions.riskExternal', '外部操作需审批')}</em></span>
        </label>
      })}</div></details>}
    </span>
  </div>
}

function riskLabel(skill: CharacterSkillDescriptor, t: ReturnType<typeof useI18n>['t']): string {
  if (skill.risks.includes('external-side-effect')) return t('workshop.permissions.riskExternal', '外部操作需审批')
  if (skill.risks.includes('write-local')) return t('workshop.permissions.riskWrite', '可写当前世界')
  return t('workshop.permissions.riskRead', '只读')
}
