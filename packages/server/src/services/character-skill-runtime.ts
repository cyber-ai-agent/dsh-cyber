import { randomUUID } from 'node:crypto'

import type {
  CharacterSkillAction,
  CharacterSkillDescriptor,
  CharacterSkillResult,
} from '@dsh-cyber/contracts/skill-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillActionRepository } from '../skills/skill-action-repository.js'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'

const TICK_MS = 30_000
const DUPLICATE_WINDOW_MS = 60_000

export interface CharacterSkillRuntimeOptions {
  registry: CharacterSkillAdapterRegistry
  actions: CharacterSkillActionRepository
}

/**
 * Provider- and persistence-neutral Skill orchestration.
 *
 * Responsibilities stay deliberately narrow: authorize by current character
 * revision, ask a host-injected registry for structured proposals, reserve
 * durable actions, schedule them, and feed factual execution results back to
 * the Agent. Provider registration and storage implementation both live outside
 * this class.
 */
export class CharacterSkillRuntime {
  readonly #store: SqliteStore
  readonly #registry: CharacterSkillAdapterRegistry
  readonly #actions: CharacterSkillActionRepository
  #timer: NodeJS.Timeout | undefined
  #ticking = false

  constructor(store: SqliteStore, options: CharacterSkillRuntimeOptions) {
    this.#store = store
    this.#registry = options.registry
    this.#actions = options.actions
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS)
    this.#timer.unref()
  }

  close(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  listDescriptors(): CharacterSkillDescriptor[] {
    return this.#registry.list()
  }

  async prepare(worldId: string, characterId: string, prompt: string, now = new Date()): Promise<CharacterSkillResult> {
    const employee = this.#store.getEmployee(characterId)
    if (employee === undefined || employee.worldId !== worldId || employee.status === 'archived') {
      return { handled: false, actions: [] }
    }
    const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
    if (revision === undefined || revision.skillGrants.length === 0) return { handled: false, actions: [] }

    const proposals = await this.#registry.propose({
      worldId,
      characterId,
      prompt,
      grantedSkillIds: revision.skillGrants,
      now,
    })
    if (proposals.length === 0) return { handled: false, actions: [] }

    const actions: CharacterSkillAction[] = []
    for (const proposal of proposals) {
      if (!revision.skillGrants.includes(proposal.skillId)) continue

      const candidate: CharacterSkillAction = {
        id: randomUUID(),
        worldId,
        characterId,
        skillId: proposal.skillId,
        adapterId: proposal.adapterId,
        action: proposal.action,
        target: proposal.target,
        label: proposal.label,
        risk: proposal.risk,
        authorization: proposal.authorization,
        parameters: proposal.parameters ?? {},
        ...(proposal.scheduledFor === undefined ? {} : { scheduledFor: proposal.scheduledFor }),
        status: proposal.scheduledFor === undefined ? 'waiting-for-integration' : 'scheduled',
        detail: proposal.scheduledFor === undefined
          ? '已预留真实动作，正在通过受信任技能适配器执行'
          : `已创建本地计划，将在 ${localTimeLabel(proposal.scheduledFor)} 尝试执行`,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }

      // reserve() is the atomic de-duplication boundary. An immediate external
      // side effect is never executed before its durable reservation exists.
      const reservation = await this.#actions.reserve(candidate, DUPLICATE_WINDOW_MS)
      const action = reservation.action
      if (!reservation.created) {
        actions.push(action)
        continue
      }

      if (action.scheduledFor === undefined) {
        await this.#execute(action, now)
        await this.#actions.save(action)
      }
      actions.push(action)
    }

    if (actions.length === 0) return { handled: false, actions: [] }
    const skillIds = [...new Set(actions.map((item) => item.skillId))]
    return {
      handled: true,
      ...(skillIds.length === 1 ? { skillId: skillIds[0] } : {}),
      summary: skillSummary(actions),
      actions,
    }
  }

  list(worldId: string): Promise<CharacterSkillAction[]> {
    return this.#actions.listByWorld(worldId)
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      for (const action of await this.#actions.listDue(now)) {
        const employee = this.#store.getEmployee(action.characterId)
        const revision = employee === undefined ? undefined : this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
        if (
          employee === undefined
          || employee.status === 'archived'
          || employee.worldId !== action.worldId
          || revision === undefined
          || !revision.skillGrants.includes(action.skillId)
        ) {
          action.status = 'failed'
          action.detail = '计划执行前角色已不可用或技能授权已撤销'
          action.updatedAt = now.toISOString()
          await this.#actions.save(action)
          continue
        }
        await this.#execute(action, now)
        await this.#actions.save(action)
      }
    } finally {
      this.#ticking = false
    }
  }

  async #execute(action: CharacterSkillAction, now: Date): Promise<void> {
    const adapter = this.#registry.adapterById(action.adapterId) ?? this.#registry.adapterForSkill(action.skillId)
    if (adapter === undefined) {
      action.status = 'failed'
      action.detail = `当前宿主没有提供技能 ${action.skillId} 的受信任适配器`
      action.updatedAt = now.toISOString()
      return
    }
    try {
      const result = await adapter.execute(action, { now })
      action.status = result.status
      action.detail = result.detail
    } catch {
      action.status = 'failed'
      action.detail = '技能适配器执行失败，未确认任何外部副作用'
    }
    action.updatedAt = now.toISOString()
  }
}

function skillSummary(actions: CharacterSkillAction[]): string {
  return actions.map((item) => `${item.label}：${item.detail}`).join('\n')
}

function localTimeLabel(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
