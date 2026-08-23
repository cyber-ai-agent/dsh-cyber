import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename } from 'node:fs/promises'

import type {
  CharacterSkillAction,
  CharacterSkillDescriptor,
  CharacterSkillResult,
} from '@dsh-cyber/contracts/skill-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { createBuiltinSkillRegistry } from '../skills/builtin-skill-registry.js'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'

const TICK_MS = 30_000

interface SkillActionFile {
  version: 2
  actions: CharacterSkillAction[]
}

interface LegacySkillAction {
  id: string
  worldId: string
  characterId: string
  skillId: string
  action: string
  target: string
  scheduledFor?: string
  status: CharacterSkillAction['status']
  detail: string
  createdAt: string
  updatedAt: string
}

export interface CharacterSkillRuntimeOptions {
  registry?: CharacterSkillAdapterRegistry
}

/**
 * Provider-neutral skill orchestration.
 *
 * Responsibilities stay deliberately narrow: authorize by character revision,
 * ask registered trusted adapters for structured proposals, persist durable
 * actions, schedule them, and feed factual execution results back to the Agent.
 * It never knows how Home Assistant, GitHub, Feishu or any future provider works.
 */
export class CharacterSkillRuntime {
  readonly #store: SqliteStore
  readonly #path: string
  readonly #registry: CharacterSkillAdapterRegistry
  #timer: NodeJS.Timeout | undefined
  #ticking = false

  constructor(store: SqliteStore, options: CharacterSkillRuntimeOptions = {}) {
    this.#store = store
    this.#path = join(dirname(dirname(store.databasePath)), 'skills', 'actions.json')
    this.#registry = options.registry ?? createBuiltinSkillRegistry()
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

    const file = await this.#read()
    const actions: CharacterSkillAction[] = []
    for (const proposal of proposals) {
      if (!revision.skillGrants.includes(proposal.skillId)) continue
      const duplicate = file.actions.find((item) =>
        item.worldId === worldId
        && item.characterId === characterId
        && item.skillId === proposal.skillId
        && item.adapterId === proposal.adapterId
        && item.action === proposal.action
        && item.target === proposal.target
        && item.scheduledFor === proposal.scheduledFor
        && Math.abs(now.getTime() - Date.parse(item.createdAt)) < 60_000,
      )
      if (duplicate !== undefined) {
        actions.push(duplicate)
        continue
      }

      const created: CharacterSkillAction = {
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
          ? '正在通过受信任技能适配器执行'
          : `已创建本地计划，将在 ${localTimeLabel(proposal.scheduledFor)} 尝试执行`,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }
      if (proposal.scheduledFor === undefined) await this.#execute(created, now)
      file.actions.push(created)
      actions.push(created)
    }

    if (actions.length === 0) return { handled: false, actions: [] }
    await this.#write(file)
    const skillIds = [...new Set(actions.map((item) => item.skillId))]
    return {
      handled: true,
      ...(skillIds.length === 1 ? { skillId: skillIds[0] } : {}),
      summary: skillSummary(actions),
      actions,
    }
  }

  async list(worldId: string): Promise<CharacterSkillAction[]> {
    return (await this.#read()).actions
      .filter((item) => item.worldId === worldId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      const file = await this.#read()
      let changed = false
      for (const action of file.actions) {
        if (action.status !== 'scheduled' || action.scheduledFor === undefined || Date.parse(action.scheduledFor) > now.getTime()) continue
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
          changed = true
          continue
        }
        await this.#execute(action, now)
        changed = true
      }
      if (changed) await this.#write(file)
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

  async #read(): Promise<SkillActionFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as {
        version?: number
        actions?: unknown[]
      }
      if (!Array.isArray(parsed.actions)) return { version: 2, actions: [] }
      if (parsed.version === 2) return { version: 2, actions: parsed.actions as CharacterSkillAction[] }
      if (parsed.version === 1) {
        return {
          version: 2,
          actions: (parsed.actions as LegacySkillAction[]).map((action) => this.#migrateLegacyAction(action)),
        }
      }
      return { version: 2, actions: [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, actions: [] }
      throw error
    }
  }

  #migrateLegacyAction(action: LegacySkillAction): CharacterSkillAction {
    const adapter = this.#registry.adapterForSkill(action.skillId)
    return {
      ...action,
      adapterId: adapter?.id ?? `unavailable.${action.skillId}`,
      label: legacyActionLabel(action.action, action.target),
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: {},
    }
  }

  async #write(value: SkillActionFile): Promise<void> {
    const directory = dirname(this.#path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.#path}.tmp-${randomUUID()}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.#path)
  }
}

function skillSummary(actions: CharacterSkillAction[]): string {
  return actions.map((item) => `${item.label}：${item.detail}`).join('\n')
}

function legacyActionLabel(action: string, target: string): string {
  const device = target === 'air-conditioner' ? '空调' : target === 'music-player' ? '音乐播放器' : target
  if (action.endsWith('turn_on')) return `开启${device}`
  if (action.endsWith('turn_off')) return `关闭${device}`
  if (action.endsWith('media_play')) return `播放${device}`
  if (action.endsWith('media_pause')) return `暂停${device}`
  return `${device} · ${action}`
}

function localTimeLabel(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
