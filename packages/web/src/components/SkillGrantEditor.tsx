import { useEffect, useMemo, useState } from 'react'
import type { EmployeeBlueprint, EmployeeInstance } from '@dsh-cyber/contracts'
import type { CharacterSkillDescriptor } from '@dsh-cyber/contracts/creative-platform'

import { api } from '../api.js'
import './SkillGrantEditor.css'

interface SkillGrantEditorProps {
  employee: EmployeeInstance
  value: string[]
  onChange(next: string[]): void
}

export function SkillGrantEditor({ employee, value, onChange }: SkillGrantEditorProps) {
  const [blueprint, setBlueprint] = useState<EmployeeBlueprint>()
  const [descriptors, setDescriptors] = useState<CharacterSkillDescriptor[]>([])
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api<{ items: EmployeeBlueprint[] }>(`/api/catalog/blueprints?workspaceId=${encodeURIComponent(employee.workspaceId)}`),
      api<{ items: CharacterSkillDescriptor[] }>(`/api/workspaces/${encodeURIComponent(employee.workspaceId)}/skill-catalog`),
    ]).then(([blueprints, skills]) => {
      if (cancelled) return
      setBlueprint(blueprints.items.find((item) => item.id === employee.blueprintId && item.version === employee.blueprintVersion))
      setDescriptors(skills.items)
      setError(undefined)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '技能目录加载失败')
    })
    return () => { cancelled = true }
  }, [employee.blueprintId, employee.blueprintVersion, employee.workspaceId])

  const requested = blueprint?.requestedSkills ?? []
  const descriptorMap = useMemo(() => new Map(descriptors.map((item) => [item.id, item])), [descriptors])

  if (error !== undefined) return <div className="permission-notice permission-notice--warning"><p>{error}</p></div>
  if (blueprint === undefined) return <div className="dialog-empty">正在读取角色技能请求…</div>
  if (requested.length === 0) return <div className="dialog-empty">这份角色 Blueprint 没有请求任何 Skill。</div>

  return (
    <div className="skill-grant-editor">
      {requested.map((skillId) => {
        const descriptor = descriptorMap.get(skillId)
        const granted = value.includes(skillId)
        const canGrant = descriptor !== undefined
        return (
          <label key={skillId} className={`skill-grant-row${granted ? ' is-granted' : ''}${canGrant ? '' : ' is-unavailable'}`}>
            <input
              type="checkbox"
              checked={granted}
              disabled={!canGrant && !granted}
              onChange={(event) => onChange(event.target.checked
                ? [...new Set([...value, skillId])]
                : value.filter((item) => item !== skillId))}
            />
            <span>
              <strong>{descriptor?.displayName ?? skillId}</strong>
              <small>{descriptor?.summary ?? '当前宿主没有注册这个 Skill Adapter，不能新增授权。'}</small>
              <span className="skill-grant-row__meta">
                <code>{skillId}</code>
                {descriptor === undefined ? <em>Adapter 未安装</em> : <em>{descriptor.risks.includes('external-side-effect') ? '包含外部副作用' : '受控能力'}</em>}
              </span>
            </span>
          </label>
        )
      })}
      <p className="skill-grant-editor__note">勾选只授予 Blueprint 已请求且当前宿主可执行的 Skill。具体外部副作用仍要遵循 Skill Action 的授权策略，不因角色拥有 Skill 就默认放行所有操作。</p>
    </div>
  )
}
