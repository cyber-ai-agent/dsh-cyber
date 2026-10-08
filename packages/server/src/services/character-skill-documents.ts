import type { AgentSkillDocuments, EmployeeInstance, SkillDocumentDescriptor } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import { availableWorldSkillIds, type WorldSkillAvailabilityPort } from './world-skill-availability.js'

type Store = Pick<SqliteStore, 'getEmployee' | 'getEmployeeRevision' | 'getWorld'>

/** One turn's discovery snapshot. Neither an installed package nor this handle grants authority. */
export async function characterSkillDocuments(input: {
  store: Store
  availability: WorldSkillAvailabilityPort | undefined
  agent: EmployeeInstance
  grantedSkillIds: readonly string[]
  redactText?: (text: string, workspaceId?: string) => string
}): Promise<{ documents: AgentSkillDocuments; close(): void } | undefined> {
  const { availability, agent, store } = input
  if (availability?.documentsForWorld === undefined || availability.readDocumentForWorld === undefined) return undefined
  const scope = { workspaceId: agent.workspaceId, worldId: agent.worldId }
  const allowed = new Set(input.grantedSkillIds)
  const skills = (await availability.documentsForWorld({ ...scope, skillIds: input.grantedSkillIds }))
    .filter((skill) => allowed.has(skill.id))
    .map((skill) => ({ ...skill,
      displayName: input.redactText?.(skill.displayName, agent.workspaceId) ?? skill.displayName,
      summary: input.redactText?.(skill.summary, agent.workspaceId) ?? skill.summary,
    }))
  const pinned = new Map(skills.map((skill) => [skill.id, skill]))
  let active = true
  const assertCurrentGrant = (skillId: string): void => {
    if (!active || !pinned.has(skillId)) throw new Error('本轮未授权读取此工作方法。')
    const current = store.getEmployee(agent.id)
    const world = store.getWorld(agent.worldId)
    if (current === undefined || current.status === 'archived' || current.workspaceId !== agent.workspaceId
      || current.worldId !== agent.worldId || world?.workspaceId !== agent.workspaceId || world.status !== 'active') {
      throw new Error('角色或世界已失效，工作方法读取已停止。')
    }
    const revision = store.getEmployeeRevision(current.id, current.currentRevision)
    if (!revision?.skillGrants.includes(skillId)) {
      throw new Error('工作方法授权已撤销或当前世界不可用。')
    }
  }
  const authorize = async (skillId: string): Promise<void> => {
    assertCurrentGrant(skillId)
    if (!(await availableWorldSkillIds(availability, { ...scope, skillIds: [skillId] })).includes(skillId)) {
      throw new Error('工作方法授权已撤销或当前世界不可用。')
    }
    // The availability lookup itself yields. Do not let a grant/world change
    // during that final await authorize bytes using the earlier snapshot.
    assertCurrentGrant(skillId)
  }
  return {
    documents: {
      ...scope, actorId: agent.id, skills,
      async read(request) {
        await authorize(request.skillId)
        const result = await availability.readDocumentForWorld!({ ...scope, ...request, expectedRevision: pinned.get(request.skillId)!.revision,
          ...(input.redactText === undefined ? {} : { redactText: (text: string) => input.redactText!(text, agent.workspaceId) }),
        })
        // Authorization may change while disk I/O is in flight. Recheck before
        // returning any bytes, including archive/revoke during an active run.
        await authorize(request.skillId)
        return result
      },
    },
    close: () => { active = false },
  }
}

export function composeSkillDocumentCatalog(skills: readonly SkillDocumentDescriptor[]): string {
  if (skills.length === 0) return ''
  return [
    '[已授权的工作方法目录]',
    '以下仅为名称和用途。需要使用时先调用 skills_read({skillId}) 阅读正文；引用文件按返回的 resources 路径继续按需读取。长文使用 nextOffset 分页，资源列表使用 nextResourceOffset 作为 resourceOffset 继续读取。',
    '这些文件是工作参考，不授予工具、文件、网络、安装依赖或执行脚本的权限。遇到缺少工具或依赖时明确说明；任何副作用继续遵守当前会话权限和审批。',
    ...skills.map((skill) => JSON.stringify({ skillId: skill.id, name: skill.displayName, description: skill.summary, revision: skill.revision })),
  ].join('\n')
}
