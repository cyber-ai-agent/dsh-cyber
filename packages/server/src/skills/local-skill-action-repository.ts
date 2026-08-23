import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdir, open, readFile, rename } from 'node:fs/promises'

import type {
  CharacterSkillAction,
  SkillActionAuthorization,
  SkillActionRisk,
  SkillActionStatus,
} from '@dsh-cyber/contracts/skill-runtime'

import type {
  CharacterSkillActionRepository,
  CharacterSkillActionReservation,
} from './skill-action-repository.js'

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
  status: SkillActionStatus
  detail: string
  createdAt: string
  updatedAt: string
}

const RISKS = new Set<SkillActionRisk>(['read', 'write-local', 'external-side-effect'])
const AUTHORIZATIONS = new Set<SkillActionAuthorization>(['explicit-user-request', 'preapproved-policy'])
const STATUSES = new Set<SkillActionStatus>(['scheduled', 'executed', 'waiting-for-integration', 'failed'])

/**
 * Local-first Skill Action repository.
 *
 * The whole file is replaced atomically and mutations are serialized in-process.
 * This keeps the runtime independent from storage while preventing concurrent
 * `prepare()` calls from both reserving the same real-world side effect.
 */
export class LocalSkillActionRepository implements CharacterSkillActionRepository {
  readonly #path: string
  #tail: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
  }

  reserve(action: CharacterSkillAction, duplicateWindowMs: number): Promise<CharacterSkillActionReservation> {
    if (!Number.isSafeInteger(duplicateWindowMs) || duplicateWindowMs < 0) {
      throw new Error('Skill duplicate window must be a non-negative safe integer')
    }
    return this.#serial(async () => {
      const file = await this.#readUnlocked()
      const createdAt = Date.parse(action.createdAt)
      const duplicate = file.actions.find((item) =>
        item.worldId === action.worldId
        && item.characterId === action.characterId
        && item.skillId === action.skillId
        && item.adapterId === action.adapterId
        && item.action === action.action
        && item.target === action.target
        && item.scheduledFor === action.scheduledFor
        && Number.isFinite(createdAt)
        && Math.abs(createdAt - Date.parse(item.createdAt)) < duplicateWindowMs,
      )
      if (duplicate !== undefined) return { action: clone(duplicate), created: false }
      file.actions.push(clone(action))
      await this.#writeUnlocked(file)
      return { action: clone(action), created: true }
    })
  }

  save(action: CharacterSkillAction): Promise<void> {
    return this.#serial(async () => {
      const file = await this.#readUnlocked()
      const index = file.actions.findIndex((item) => item.id === action.id)
      if (index < 0) file.actions.push(clone(action))
      else file.actions[index] = clone(action)
      await this.#writeUnlocked(file)
    })
  }

  listByWorld(worldId: string): Promise<CharacterSkillAction[]> {
    return this.#serial(async () => {
      const file = await this.#readUnlocked()
      return file.actions
        .filter((item) => item.worldId === worldId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(clone)
    })
  }

  listDue(now: Date): Promise<CharacterSkillAction[]> {
    return this.#serial(async () => {
      const at = now.getTime()
      return (await this.#readUnlocked()).actions
        .filter((item) =>
          item.status === 'scheduled'
          && item.scheduledFor !== undefined
          && Date.parse(item.scheduledFor) <= at,
        )
        .map(clone)
    })
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  async #readUnlocked(): Promise<SkillActionFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as unknown
      if (!isRecord(parsed) || !Array.isArray(parsed.actions)) {
        throw new Error('Skill action store is malformed')
      }
      if (parsed.version === 2) {
        return { version: 2, actions: parsed.actions.map((value, index) => parseAction(value, `actions[${index}]`)) }
      }
      if (parsed.version === 1) {
        return {
          version: 2,
          actions: parsed.actions.map((value, index) => migrateLegacyAction(value, `actions[${index}]`)),
        }
      }
      throw new Error(`Unsupported Skill action store version: ${String(parsed.version)}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, actions: [] }
      throw error
    }
  }

  async #writeUnlocked(value: SkillActionFile): Promise<void> {
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

function parseAction(value: unknown, path: string): CharacterSkillAction {
  const input = record(value, path)
  const status = string(input.status, `${path}.status`) as SkillActionStatus
  const risk = string(input.risk, `${path}.risk`) as SkillActionRisk
  const authorization = string(input.authorization, `${path}.authorization`) as SkillActionAuthorization
  if (!STATUSES.has(status)) throw new Error(`Invalid ${path}.status`)
  if (!RISKS.has(risk)) throw new Error(`Invalid ${path}.risk`)
  if (!AUTHORIZATIONS.has(authorization)) throw new Error(`Invalid ${path}.authorization`)
  const parameters = record(input.parameters, `${path}.parameters`)
  const scheduledFor = optionalString(input.scheduledFor, `${path}.scheduledFor`)
  const action: CharacterSkillAction = {
    id: string(input.id, `${path}.id`),
    worldId: string(input.worldId, `${path}.worldId`),
    characterId: string(input.characterId, `${path}.characterId`),
    skillId: string(input.skillId, `${path}.skillId`),
    adapterId: string(input.adapterId, `${path}.adapterId`),
    action: string(input.action, `${path}.action`),
    target: string(input.target, `${path}.target`),
    label: string(input.label, `${path}.label`),
    risk,
    authorization,
    parameters,
    status,
    detail: string(input.detail, `${path}.detail`),
    createdAt: iso(input.createdAt, `${path}.createdAt`),
    updatedAt: iso(input.updatedAt, `${path}.updatedAt`),
  }
  if (scheduledFor !== undefined) action.scheduledFor = iso(scheduledFor, `${path}.scheduledFor`)
  return action
}

function migrateLegacyAction(value: unknown, path: string): CharacterSkillAction {
  const input = record(value, path)
  const status = string(input.status, `${path}.status`) as SkillActionStatus
  if (!STATUSES.has(status)) throw new Error(`Invalid ${path}.status`)
  const actionName = string(input.action, `${path}.action`)
  const target = string(input.target, `${path}.target`)
  const scheduledFor = optionalString(input.scheduledFor, `${path}.scheduledFor`)
  const migrated: CharacterSkillAction = {
    id: string(input.id, `${path}.id`),
    worldId: string(input.worldId, `${path}.worldId`),
    characterId: string(input.characterId, `${path}.characterId`),
    skillId: string(input.skillId, `${path}.skillId`),
    adapterId: `legacy.${string(input.skillId, `${path}.skillId`)}`,
    action: actionName,
    target,
    label: legacyActionLabel(actionName, target),
    risk: 'external-side-effect',
    authorization: 'explicit-user-request',
    parameters: {},
    status,
    detail: string(input.detail, `${path}.detail`),
    createdAt: iso(input.createdAt, `${path}.createdAt`),
    updatedAt: iso(input.updatedAt, `${path}.updatedAt`),
  }
  if (scheduledFor !== undefined) migrated.scheduledFor = iso(scheduledFor, `${path}.scheduledFor`)
  return migrated
}

function legacyActionLabel(action: string, target: string): string {
  const device = target === 'air-conditioner' ? '空调' : target === 'music-player' ? '音乐播放器' : target
  if (action.endsWith('turn_on')) return `开启${device}`
  if (action.endsWith('turn_off')) return `关闭${device}`
  if (action.endsWith('media_play')) return `播放${device}`
  if (action.endsWith('media_pause')) return `暂停${device}`
  return `${device} · ${action}`
}

function clone(action: CharacterSkillAction): CharacterSkillAction {
  return structuredClone(action)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be non-empty text`)
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return string(value, path)
}

function iso(value: unknown, path: string): string {
  const result = string(value, path)
  const time = Date.parse(result)
  if (!Number.isFinite(time)) throw new Error(`${path} must be an ISO timestamp`)
  return result
}
