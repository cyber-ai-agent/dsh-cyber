import { randomUUID } from 'node:crypto'

/**
 * One-time host-access grants issued by the person at the keyboard.
 *
 * `danger-full-access` lets a runtime read and write outside the world
 * directory, so it is not a World Permission and never can be: world
 * administrators administrate a world, not the machine. It is also not a
 * setting — a value stored in `settings.json` would silently elevate every
 * later turn, which is why the resolver has always ignored the stored one.
 *
 * A grant is instead an explicit, single act by the owner: bound to one world,
 * one set of characters and one client turn, single-use, and short-lived.
 *
 * Deliberately in memory. Durability would buy nothing here and would create a
 * window in which a grant outlives the intent behind it; a restart should
 * revoke elevation, not preserve it.
 */
export interface OwnerRuntimeAccessGrant {
  id: string
  worldId: string
  employeeIds: readonly string[]
  clientTurnId: string
  expiresAt: number
}

export interface IssueOwnerRuntimeAccessInput {
  worldId: string
  employeeIds: readonly string[]
  clientTurnId: string
  /** The owner has seen and accepted what full host access means. */
  confirmed: boolean
}

const DEFAULT_TTL_MS = 2 * 60_000

export class OwnerRuntimeAccessDeniedError extends Error {
  readonly code = 'owner_runtime_access_denied'

  constructor(message: string) {
    super(message)
    this.name = 'OwnerRuntimeAccessDeniedError'
  }
}

export class OwnerRuntimeAccessService {
  readonly #grants = new Map<string, OwnerRuntimeAccessGrant>()
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#now = options.now ?? (() => Date.now())
  }

  issue(input: IssueOwnerRuntimeAccessInput): OwnerRuntimeAccessGrant {
    if (input.confirmed !== true) {
      throw new OwnerRuntimeAccessDeniedError('完整访问需要显式风险确认')
    }
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length === 0) throw new OwnerRuntimeAccessDeniedError('完整访问必须指定角色')
    const clientTurnId = input.clientTurnId.trim()
    if (!clientTurnId) throw new OwnerRuntimeAccessDeniedError('完整访问必须绑定一次具体请求')
    this.#sweep()
    const grant: OwnerRuntimeAccessGrant = {
      id: randomUUID(),
      worldId: input.worldId,
      employeeIds,
      clientTurnId,
      expiresAt: this.#now() + this.#ttlMs,
    }
    this.#grants.set(grant.id, grant)
    return grant
  }

  /**
   * Spends a grant, or refuses.
   *
   * Consumption happens on the first check, so a replayed request finds
   * nothing — the grant authorises one turn, not a window of turns.
   */
  consume(input: {
    grantId: string | undefined
    worldId: string
    employeeIds: readonly string[]
    clientTurnId: string | undefined
  }): boolean {
    if (input.grantId === undefined) return false
    this.#sweep()
    const grant = this.#grants.get(input.grantId)
    if (grant === undefined) return false
    this.#grants.delete(grant.id)
    if (grant.worldId !== input.worldId) return false
    if (grant.clientTurnId !== (input.clientTurnId ?? '')) return false
    // Every character in the turn must be covered; a grant for one character
    // does not elevate the others in a group.
    return input.employeeIds.every((employeeId) => grant.employeeIds.includes(employeeId))
  }

  #sweep(): void {
    const now = this.#now()
    for (const [id, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(id)
    }
  }
}
