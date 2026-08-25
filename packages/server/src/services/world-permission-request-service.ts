import type { JsonObject } from '@dsh-cyber/contracts'
import type {
  CreateWorldPermissionRequestInput,
  DecideWorldPermissionRequestInput,
  WorldAuthorityActor,
  WorldCharacterAuthority,
  WorldCharacterPermission,
  WorldPermissionDecisionScope,
  WorldPermissionRequest,
  WorldPermissionRequestStatus,
} from '@dsh-cyber/contracts/world-authority'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

/**
 * The persistence seam for world-local permission decisions.  The concrete
 * SQLite implementation belongs to the persistence package; keeping this port
 * here lets the Skill Runtime remain independent of SQL and keeps request
 * lifecycle separate from ApprovalPolicy.
 */
export interface WorldPermissionRequestStore {
  createWorldPermissionRequest(input: CreateWorldPermissionRequestInput): WorldPermissionRequest | Promise<WorldPermissionRequest>
  getWorldPermissionRequest(id: string): WorldPermissionRequest | undefined | Promise<WorldPermissionRequest | undefined>
  listWorldPermissionRequests(worldId: string, status?: WorldPermissionRequestStatus): WorldPermissionRequest[] | Promise<WorldPermissionRequest[]>
  /** Indexed by the exact SkillAction binding; no world-wide scan fallback. */
  getWorldPermissionRequestForAction?(skillActionId: string, permission?: WorldCharacterPermission): WorldPermissionRequest | undefined | Promise<WorldPermissionRequest | undefined>
  /** Indexed by the exact WorkTurn binding; no unbounded world scan fallback. */
  listWorldPermissionRequestsForTurn?(workTurnId: string): WorldPermissionRequest[] | Promise<WorldPermissionRequest[]>
  decideWorldPermissionRequest(
    id: string,
    input: DecideWorldPermissionRequestInput,
    now?: string,
  ): WorldPermissionRequest | Promise<WorldPermissionRequest>
  consumeWorldPermissionRequest(id: string, consumedAt?: string): WorldPermissionRequest | Promise<WorldPermissionRequest>
  expireWorldPermissionRequests?(now?: string): number | Promise<number>
  expireWorldPermissionRequest?(id: string, now?: string): WorldPermissionRequest | Promise<WorldPermissionRequest>
}

/** Host authority port implemented by the server authority service. */
export interface WorldAuthorityPort {
  get(worldId: string, employeeId: string): WorldCharacterAuthority | undefined | Promise<WorldCharacterAuthority | undefined>
  hasPermission(
    worldId: string,
    employeeId: string,
    permission: WorldCharacterPermission,
  ): boolean | Promise<boolean>
  updateAuthority?(input: {
    worldId: string
    targetEmployeeId: string
    actor: WorldAuthorityActor
    role: WorldCharacterAuthority['role']
    permissionGrants: WorldCharacterPermission[]
    reason: string
  }): WorldCharacterAuthority | Promise<WorldCharacterAuthority>
}

export interface WorldPermissionActionCheck {
  status: 'granted' | 'pending' | 'rejected' | 'expired'
  request?: WorldPermissionRequest
}

export interface EnsureWorldPermissionRequestInput {
  workspaceId: string
  worldId: string
  employeeId: string
  workTurnId: string
  skillActionId: string
  permission: WorldCharacterPermission
  now?: Date
  expiresInMs?: number
}

export interface DecideWorldPermissionInput {
  requestId: string
  decision: WorldPermissionDecisionScope | 'reject'
  decidedBy: string
  /** The authority actor is normally the owner; employee self-grants are rejected by the authority port. */
  actor?: WorldAuthorityActor
  now?: Date
}

export interface WorldPermissionRequestServiceOptions {
  store: WorldPermissionRequestStore
  authority: WorldAuthorityPort
  clock?: () => Date
  /** Announces that this world's pending decisions changed. */
  onDecisionChanged?(worldId: string, payload: JsonObject): void
}

const DEFAULT_TTL_MS = 10 * 60_000

/**
 * Durable lifecycle for a missing world permission.
 *
 * A request is exact-bound to `(skillActionId, permission)`.  `once` never
 * updates an authority row and is consumed after that one action settles;
 * `persistent` updates the WorldCharacterAuthority first and only then settles
 * the request.  No ApprovalPolicy is created by this service.
 */
export class WorldPermissionRequestService {
  readonly #store: WorldPermissionRequestStore
  readonly #authority: WorldAuthorityPort
  readonly #clock: () => Date
  readonly #onDecisionChanged: ((worldId: string, payload: JsonObject) => void) | undefined

  constructor(options: WorldPermissionRequestServiceOptions) {
    this.#store = options.store
    this.#authority = options.authority
    this.#clock = options.clock ?? (() => new Date())
    this.#onDecisionChanged = options.onDecisionChanged
  }

  /**
   * Tells the world its pending decisions moved.
   *
   * Fire-and-forget: the HTTP list stays authoritative, and a stream failure
   * must never break a decision.
   */
  #announce(request: WorldPermissionRequest): void {
    try {
      this.#onDecisionChanged?.(request.worldId, {
        requestId: request.id,
        employeeId: request.employeeId,
        permission: request.permission,
        status: request.status,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.decisionScope === undefined ? {} : { decisionScope: request.decisionScope }),
      })
    } catch {
      // Intentionally swallowed.
    }
  }

  async ensure(input: EnsureWorldPermissionRequestInput): Promise<WorldPermissionRequest> {
    const existing = await this.findForAction(input.skillActionId, input.permission, input.worldId)
    if (existing !== undefined) return existing
    const now = input.now ?? this.#clock()
    const created = await this.#store.createWorldPermissionRequest({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      employeeId: input.employeeId,
      workTurnId: input.workTurnId,
      skillActionId: input.skillActionId,
      permission: input.permission,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.expiresInMs ?? DEFAULT_TTL_MS)).toISOString(),
    })
    this.#announce(created)
    return created
  }

  async check(action: Pick<CharacterSkillAction, 'worldId' | 'characterId' | 'workTurnId' | 'id' | 'requiredWorldPermission'> & {
    workspaceId?: string
  }): Promise<WorldPermissionActionCheck> {
    const permission = action.requiredWorldPermission
    if (permission === undefined) return { status: 'granted' }
    if (await this.#authority.hasPermission(action.worldId, action.characterId, permission)) {
      return { status: 'granted' }
    }
    const request = await this.findForAction(action.id, permission, action.worldId)
    if (request?.status === 'approved') {
      if (request.decisionScope === 'once' && request.consumedAt === undefined) return { status: 'granted', request }
      if (request.decisionScope === 'persistent'
        && await this.#authority.hasPermission(action.worldId, action.characterId, permission)) {
        return { status: 'granted', request }
      }
      if (request.decisionScope === 'persistent') {
        // An approved persistent request without its durable grant is a
        // broken/revoked authorization, never a reason to wait forever.
        return { status: 'rejected', request }
      }
    }
    if (request?.status === 'rejected') return { status: 'rejected', request }
    if (request?.status === 'expired') return { status: 'expired', request }
    if (request === undefined) return { status: 'pending' }
    return { status: 'pending', request }
  }

  async ensureForAction(
    action: Pick<CharacterSkillAction, 'worldId' | 'characterId' | 'workTurnId' | 'id' | 'requiredWorldPermission'>,
    workspaceId: string,
    now = this.#clock(),
  ): Promise<WorldPermissionRequest | undefined> {
    const permission = action.requiredWorldPermission
    if (permission === undefined || action.workTurnId === undefined) return undefined
    const check = await this.check(action)
    if (check.status !== 'pending') return check.request
    if (check.request !== undefined) return check.request
    return await this.ensure({
      workspaceId,
      worldId: action.worldId,
      employeeId: action.characterId,
      workTurnId: action.workTurnId,
      skillActionId: action.id,
      permission,
      now,
    })
  }

  async decide(input: DecideWorldPermissionInput): Promise<WorldPermissionRequest> {
    const current = await this.#store.getWorldPermissionRequest(input.requestId)
    if (current === undefined) throw new Error(`World permission request not found: ${input.requestId}`)
    if (current.status !== 'pending') throw new WorldPermissionRequestConflictError()
    const now = input.now ?? this.#clock()
    if (Date.parse(current.expiresAt) <= now.getTime()) {
      if (this.#store.expireWorldPermissionRequest !== undefined) {
        return await this.#store.expireWorldPermissionRequest(input.requestId, now.toISOString())
      }
      // The current SQLite list helper performs the indexed expiry CAS for a
      // world before returning rows. Read it back so expiry remains distinct
      // from an explicit reject.
      await this.#store.listWorldPermissionRequests(current.worldId)
      const expired = await this.#store.getWorldPermissionRequest(input.requestId)
      if (expired?.status === 'expired') return expired
      // A concrete SQLite repository should expose the indexed expire CAS. Do
      // not turn an expired request into `rejected` when that seam is absent.
      throw new WorldPermissionRequestExpiredError()
    }
    if (input.decision === 'reject') {
      return await this.#store.decideWorldPermissionRequest(input.requestId, {
        decisionScope: 'reject',
        decidedBy: input.decidedBy,
      }, now.toISOString())
    }
    if (input.decision === 'persistent') {
      if (this.#authority.updateAuthority === undefined) {
        throw new Error('World authority service is unavailable')
      }
      const authority = await this.#authority.get(current.worldId, current.employeeId)
      if (authority === undefined) throw new Error('World character authority not found')
      const actor = input.actor ?? { kind: 'owner', id: input.decidedBy } satisfies WorldAuthorityActor
      const grants = authority.permissionGrants.includes(current.permission)
        ? authority.permissionGrants
        : [...authority.permissionGrants, current.permission]
      try {
        await this.#authority.updateAuthority({
          worldId: current.worldId,
          targetEmployeeId: current.employeeId,
          actor,
          role: authority.role,
          permissionGrants: grants,
          reason: `授予世界权限并继续动作 ${current.skillActionId}`,
        })
      } catch (error) {
        // "This character must be an administrator first" is an answer to the
        // user, delivered through the same 409 the caller already handles.
        if ((error as { code?: unknown } | null)?.code === 'requires_administrator_promotion') {
          throw new WorldPermissionGrantRejectedError()
        }
        throw error
      }
      // Authority services may safely cap or strip grants (for example a
      // member cannot receive a management permission). Never settle the
      // request as approved if the durable authority row did not actually
      // acquire the requested permission; leave it pending for an explicit
      // corrective decision instead of creating a false persistent grant.
      if (!await this.#authority.hasPermission(current.worldId, current.employeeId, current.permission)) {
        throw new WorldPermissionGrantRejectedError()
      }
    }
    const decided = await this.#store.decideWorldPermissionRequest(input.requestId, {
      decisionScope: input.decision,
      decidedBy: input.decidedBy,
    }, now.toISOString())
    this.#announce(decided)
    return decided
  }

  async consumeOnce(requestId: string, now = this.#clock()): Promise<WorldPermissionRequest> {
    const request = await this.#store.getWorldPermissionRequest(requestId)
    if (request === undefined) throw new Error(`World permission request not found: ${requestId}`)
    if (request.status !== 'approved' || request.decisionScope !== 'once' || request.consumedAt !== undefined) return request
    const consumed = await this.#store.consumeWorldPermissionRequest(requestId, now.toISOString())
    this.#announce(consumed)
    return consumed
  }

  async findForAction(actionId: string, permission?: WorldCharacterPermission, worldId?: string): Promise<WorldPermissionRequest | undefined> {
    if (this.#store.getWorldPermissionRequestForAction !== undefined) {
      return await this.#store.getWorldPermissionRequestForAction(actionId, permission)
    }
    // Never scan `listWorldPermissionRequests('')`: the persistence contract
    // deliberately requires an indexed action lookup for recovery/exact-once.
    // Until the host supplies that helper, an action is treated as new and the
    // UNIQUE(skill_action_id, permission) constraint remains the final guard.
    void worldId
    return undefined
  }

  async listPending(worldId: string): Promise<WorldPermissionRequest[]> {
    return await this.#store.listWorldPermissionRequests(worldId, 'pending')
  }

  async listForTurn(workTurnId: string): Promise<WorldPermissionRequest[]> {
    if (this.#store.listWorldPermissionRequestsForTurn === undefined) return []
    return await this.#store.listWorldPermissionRequestsForTurn(workTurnId)
  }

  async expire(now = this.#clock()): Promise<number> {
    if (this.#store.expireWorldPermissionRequests !== undefined) {
      return await this.#store.expireWorldPermissionRequests(now.toISOString())
    }
    return 0
  }

  /**
   * Reconcile the crash window between a persistent authority write and the
   * request decision. If the durable authority already contains the exact
   * requested permission, settling the pending request as persistent is the
   * only safe recovery; no adapter execution happens in this method.
   */
  async recoverPending(worldId: string, now = this.#clock()): Promise<WorldPermissionRequest[]> {
    const pending = await this.#store.listWorldPermissionRequests(worldId, 'pending')
    const recovered: WorldPermissionRequest[] = []
    for (const request of pending) {
      if (Date.parse(request.expiresAt) <= now.getTime()) {
        const expired = this.#store.expireWorldPermissionRequest === undefined
          ? undefined
          : await this.#store.expireWorldPermissionRequest(request.id, now.toISOString())
        if (expired !== undefined) recovered.push(expired)
        continue
      }
      if (!await this.#authority.hasPermission(request.worldId, request.employeeId, request.permission)) continue
      recovered.push(await this.#store.decideWorldPermissionRequest(request.id, {
        decisionScope: 'persistent',
        decidedBy: 'system-recovery',
      }, now.toISOString()))
    }
    return recovered
  }
}

export class WorldPermissionRequestConflictError extends Error {
  readonly code = 'world_permission_request_already_decided'

  constructor() {
    super('世界权限请求已经处理')
    this.name = 'WorldPermissionRequestConflictError'
  }
}

export class WorldPermissionRequestExpiredError extends Error {
  readonly code = 'world_permission_request_expired'

  constructor() {
    super('世界权限请求已过期')
    this.name = 'WorldPermissionRequestExpiredError'
  }
}

export class WorldPermissionGrantRejectedError extends Error {
  readonly code = 'world_permission_grant_rejected'

  constructor() {
    super('当前角色身份不允许长期授予该世界权限，请先调整角色身份后重试')
    this.name = 'WorldPermissionGrantRejectedError'
  }
}
