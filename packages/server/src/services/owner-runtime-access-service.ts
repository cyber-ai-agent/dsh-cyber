import { randomUUID } from 'node:crypto'
import type { OwnerRuntimeAccessGrant } from '@dsh-cyber/contracts'

/**
 * Full access is a conversation permission confirmed by the person at the
 * keyboard. It is scoped to the current world, conversation session and
 * selected characters, then remains valid for later messages in that session.
 * The local server persists the grant so refreshes, world/session switches
 * and service restarts restore the same owner-approved authority. Embedders
 * without a store retain the in-memory fallback used by focused unit tests.
 */
export type OwnerRuntimeSessionAccessGrant = OwnerRuntimeAccessGrant

export interface OwnerRuntimeAccessStore {
  saveOwnerRuntimeAccessGrant(input: { id: string; worldId: string; sessionId: string; employeeIds: string[] }): OwnerRuntimeAccessGrant
  getOwnerRuntimeAccessGrant(id: string): OwnerRuntimeAccessGrant | undefined
  listOwnerRuntimeAccessGrants(worldId: string): OwnerRuntimeAccessGrant[]
  deleteOwnerRuntimeAccessGrant(id: string): boolean
}

export interface IssueOwnerRuntimeSessionAccessInput {
  worldId: string
  sessionId: string
  employeeIds: readonly string[]
  /** The owner has seen and accepted what full session access means. */
  confirmed: boolean
}

export class OwnerRuntimeAccessDeniedError extends Error {
  readonly code = 'owner_runtime_access_denied'

  constructor(message: string) {
    super(message)
    this.name = 'OwnerRuntimeAccessDeniedError'
  }
}

export class OwnerRuntimeAccessService {
  readonly #sessionGrants = new Map<string, OwnerRuntimeSessionAccessGrant>()
  readonly #store: OwnerRuntimeAccessStore | undefined

  constructor(store?: OwnerRuntimeAccessStore) {
    this.#store = store
  }

  issueSession(input: IssueOwnerRuntimeSessionAccessInput): OwnerRuntimeSessionAccessGrant {
    if (input.confirmed !== true) {
      throw new OwnerRuntimeAccessDeniedError('当前会话完全访问需要显式风险确认')
    }
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length === 0) throw new OwnerRuntimeAccessDeniedError('当前会话完全访问必须指定角色')
    const sessionId = input.sessionId.trim()
    if (!sessionId) throw new OwnerRuntimeAccessDeniedError('当前会话完全访问必须绑定一个已有会话')
    const now = new Date().toISOString()
    const grant: OwnerRuntimeSessionAccessGrant = {
      id: randomUUID(),
      worldId: input.worldId,
      sessionId,
      employeeIds,
      createdAt: now,
      updatedAt: now,
    }
    if (this.#store !== undefined) {
      return this.#store.saveOwnerRuntimeAccessGrant(grant)
    }
    for (const [id, current] of this.#sessionGrants) {
      if (current.worldId === grant.worldId && current.sessionId === grant.sessionId) this.#sessionGrants.delete(id)
    }
    this.#sessionGrants.set(grant.id, grant)
    return grant
  }

  authorizeSession(input: {
    grantId: string | undefined
    worldId: string
    sessionId: string | undefined
    employeeIds: readonly string[]
  }): boolean {
    if (input.grantId === undefined || input.sessionId === undefined) return false
    const grant = this.#store?.getOwnerRuntimeAccessGrant(input.grantId) ?? this.#sessionGrants.get(input.grantId)
    if (grant === undefined) return false
    if (grant.worldId !== input.worldId || grant.sessionId !== input.sessionId) return false
    return input.employeeIds.every((employeeId) => grant.employeeIds.includes(employeeId))
  }

  listWorld(worldId: string): OwnerRuntimeSessionAccessGrant[] {
    if (this.#store !== undefined) return this.#store.listOwnerRuntimeAccessGrants(worldId)
    return [...this.#sessionGrants.values()].filter((grant) => grant.worldId === worldId)
  }

  revokeForEmployee(worldId: string, employeeId: string): string[] {
    const revoked = this.listWorld(worldId).filter((grant) => grant.employeeIds.includes(employeeId))
    for (const grant of revoked) {
      if (this.#store !== undefined) this.#store.deleteOwnerRuntimeAccessGrant(grant.id)
      else this.#sessionGrants.delete(grant.id)
    }
    return revoked.map((grant) => grant.sessionId)
  }
}
