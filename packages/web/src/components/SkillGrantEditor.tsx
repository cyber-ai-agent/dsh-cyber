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
  if (blueprint === undefined) return <div className="dialog-empty">正在读取可用能力…</div>
  if (requested.length === 0) return <div className="dialog-empty">这个角色模板没有申请可用能力。</div>

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
              <strong>{descriptor?.displayName ?? '未识别的能力'}</strong>
              <small>{descriptor?.summary ?? '当前环境尚未提供这项能力，暂时不能授权。'}</small>
              <span className="skill-grant-row__meta">
                {descriptor === undefined ? <em>当前不可用</em> : <em>{descriptor.risks.includes('external-side-effect') ? '涉及外部操作' : '受控能力'}</em>}
              </span>
            </span>
          </label>
        )
      })}
      <p className="skill-grant-editor__note">勾选后，角色可以使用当前环境提供的对应能力。涉及外部操作时，系统仍会针对具体动作请求确认，不会因为已启用能力而自动放行。</p>
    </div>
  )
}
