import { randomUUID } from 'node:crypto'

/**
 * Full access is a conversation permission confirmed by the person at the
 * keyboard. It is scoped to the current world, conversation session and
 * selected characters, then remains valid for later messages in that session.
 * The grant lives in memory so a server restart clears the elevated mode.
 */
export interface OwnerRuntimeSessionAccessGrant {
  id: string
  worldId: string
  sessionId: string
  employeeIds: readonly string[]
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

  issueSession(input: IssueOwnerRuntimeSessionAccessInput): OwnerRuntimeSessionAccessGrant {
    if (input.confirmed !== true) {
      throw new OwnerRuntimeAccessDeniedError('当前会话完全访问需要显式风险确认')
    }
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length === 0) throw new OwnerRuntimeAccessDeniedError('当前会话完全访问必须指定角色')
    const sessionId = input.sessionId.trim()
    if (!sessionId) throw new OwnerRuntimeAccessDeniedError('当前会话完全访问必须绑定一个已有会话')
    const grant: OwnerRuntimeSessionAccessGrant = {
      id: randomUUID(),
      worldId: input.worldId,
      sessionId,
      employeeIds,
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
    const grant = this.#sessionGrants.get(input.grantId)
    if (grant === undefined) return false
    if (grant.worldId !== input.worldId || grant.sessionId !== input.sessionId) return false
    return input.employeeIds.every((employeeId) => grant.employeeIds.includes(employeeId))
  }
}
