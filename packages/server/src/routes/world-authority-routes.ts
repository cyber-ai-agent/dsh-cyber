import type {
  ApprovalRequestView,
  JsonObject,
  WorldCharacterPermission,
  WorldCharacterRole,
  WorldPermissionRequest,
} from '@dsh-cyber/contracts'
import { RECOMMENDED_ADMIN_PERMISSIONS } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { mapPermissionDecisionError } from '../http/world-permission-errors.js'
import { TraceSanitizer } from '../world-trace/trace-sanitizer.js'
import type { OwnerRuntimeAccessService } from '../services/owner-runtime-access-service.js'
import type { Router } from '../http/router.js'
import {
  optionalStringArray, readJson, requiredEnum, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { CharacterSkillRuntime } from '../services/character-skill-runtime.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldCharacterAuthorityService } from '../services/world-character-authority-service.js'
import type { TurnAwareApprovalContinuationService } from '../services/turn-aware-approval-continuation-service.js'
import {
  WorldPermissionGrantRejectedError,
  WorldPermissionRequestConflictError,
  WorldPermissionRequestExpiredError,
  WorldPermissionRequestService,
} from '../services/world-permission-request-service.js'

const OWNER_ACTOR = { kind: 'owner', id: 'local-user' } as const

export interface WorldAuthorityRoutesDependencies {
  store: SqliteStore
  worldAccess: WorldAccessService
  authority: WorldCharacterAuthorityService
  worldPermissions: WorldPermissionRequestService
  skillRuntime: CharacterSkillRuntime
  turnContinuations: TurnAwareApprovalContinuationService
  /** Issues one-time owner host-access grants. */
  ownerRuntimeAccess?: OwnerRuntimeAccessService
}

/** World-local authority and decision endpoints. */
export function registerWorldAuthorityRoutes(
  router: Router,
  dependencies: WorldAuthorityRoutesDependencies,
): void {
  const { store, worldAccess, authority, worldPermissions, skillRuntime, turnContinuations, ownerRuntimeAccess } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/authorities$/, async ({ request, response, params }) => {
    const world = requireWorld(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    writeJson(response, 200, { worldId: world.id, authorities: authority.list(world.id) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/authorities\/([^/]+)$/, async ({ request, response, params }) => {
    const world = requireWorld(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    requireEmployeeInWorld(store, world.id, params[1]!)
    const value = authority.get(world.id, params[1]!)
    if (value === undefined) throw new HttpError(404, 'world_authority_not_found', 'World authority not found')
    writeJson(response, 200, { authority: value })
  })

  router.put(/^\/api\/worlds\/([^/]+)\/authorities\/([^/]+)$/, async ({ request, response, params }) => {
    const world = requireWorld(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    requireEmployeeInWorld(store, world.id, params[1]!)
    const body = await readJson(request)
    const role = requiredEnum<WorldCharacterRole>(body, 'role', ['member', 'administrator'])
    // An administrator with no permissions cannot administrate. The recommended
    // set stands in whether the caller omitted the field or sent an empty
    // array — the second case used to persist a powerless administrator.
    const requested = body.permissionGrants === undefined ? [] : requiredPermissions(body, 'permissionGrants')
    const permissionGrants = role === 'administrator' && requested.length === 0
      ? [...RECOMMENDED_ADMIN_PERMISSIONS]
      : requested
    // "This character must be an administrator first" is an answer the editor
    // can act on — it offers promote-and-grant — not a server fault.
    let value
    try {
      value = authority.updateAuthority({
        worldId: world.id,
        targetEmployeeId: params[1]!,
        actor: OWNER_ACTOR,
        role,
        permissionGrants,
        reason: requiredString(body, 'reason'),
      })
    } catch (error) {
      throw mapPermissionDecisionError(error)
    }
    writeJson(response, 200, { authority: value })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/runtime-access-grants$/, async ({ request, response, params }) => {
    const world = requireWorld(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    if (ownerRuntimeAccess === undefined) {
      throw new HttpError(501, 'owner_runtime_access_unavailable', '完整访问授权服务不可用')
    }
    const body = await readJson(request)
    // This route is the only way a grant comes into existence, and nothing on
    // the skill path can reach it: a character can never elevate itself.
    for (const employeeId of optionalStringArray(body.employeeIds)) {
      requireEmployeeInWorld(store, world.id, employeeId)
    }
    try {
      const grant = ownerRuntimeAccess.issue({
        worldId: world.id,
        employeeIds: optionalStringArray(body.employeeIds),
        clientTurnId: requiredString(body, 'clientTurnId'),
        confirmed: body.confirmed === true,
      })
      writeJson(response, 201, { grant: { id: grant.id, expiresAt: new Date(grant.expiresAt).toISOString() } })
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'owner_runtime_access_denied') {
        throw new HttpError(422, 'owner_runtime_access_denied', (error as Error).message)
      }
      throw error
    }
  })

  router.get(/^\/api\/worlds\/([^/]+)\/permission-requests$/, async ({ request, response, params }) => {
    const world = requireWorld(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    const permissionRequests = await worldPermissions.listPending(world.id)
    writeJson(response, 200, {
      worldId: world.id,
      permissionRequests,
      requests: permissionRequests,
    })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/pending-decisions$/, async ({ request, response, params }) => {
    const world = requireWorld(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    const permissionRequests = (await worldPermissions.listPending(world.id))
      .map((item) => withSubject(store, item))
    const approvals = listPendingApprovalViews(store, skillRuntime, world.id)
    writeJson(response, 200, {
      worldId: world.id,
      approvals,
      permissionRequests,
      worldPermissionRequests: permissionRequests,
      requests: permissionRequests,
    })
  })

  router.post(/^\/api\/world-permission-requests\/([^/]+)\/decision$/, async ({ request, response, params }) => {
    const current = store.getWorldPermissionRequest(params[0]!)
    if (current === undefined) throw new HttpError(404, 'world_permission_request_not_found', 'World permission request not found')
    const world = requireWorld(store, current.worldId)
    await worldAccess.assertUnlocked(world.id, request)
    const employee = requireEmployeeInWorld(store, world.id, current.employeeId)
    if (employee.status === 'archived') throw new HttpError(409, 'employee_archived', '归档角色不能接受新的世界权限')
    if (current.status === 'expired') {
      throw new HttpError(409, 'world_permission_request_expired', '世界权限请求已过期')
    }
    if (current.status !== 'pending') {
      throw new HttpError(409, 'world_permission_request_already_decided', '世界权限请求已经处理')
    }
    const body = await readJson(request)
    const decisionValue = body.decision ?? body.decisionScope
    if (typeof decisionValue !== 'string') {
      throw new HttpError(422, 'field_required', 'decision is required')
    }
    if (decisionValue !== 'once' && decisionValue !== 'persistent' && decisionValue !== 'reject') {
      throw new HttpError(422, 'invalid_enum', 'decision has an unsupported value')
    }
    try {
      const result = await turnContinuations.decideWorldPermission({
        requestId: current.id,
        decision: decisionValue,
        decidedBy: OWNER_ACTOR.id,
        actor: OWNER_ACTOR,
      })
      writeJson(response, 200, {
        request: result.request,
        permissionRequest: result.request,
        ...(result.action === undefined ? {} : { action: result.action }),
        ...(result.continuation === undefined ? {} : { continuation: result.continuation }),
      })
    } catch (error) {
      throw mapPermissionDecisionError(error)
    }
  })
}

function requireWorld(store: SqliteStore, worldId: string) {
  const world = store.getWorld(worldId)
  if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
  return world
}

function requireEmployeeInWorld(store: SqliteStore, worldId: string, employeeId: string) {
  const employee = store.getEmployee(employeeId)
  if (employee === undefined) throw new HttpError(404, 'character_not_found', 'Character not found')
  if (employee.worldId !== worldId) throw new HttpError(403, 'cross_world_authority', 'World authority cannot cross worlds')
  return employee
}

function requiredPermissions(
  body: Record<string, unknown>,
  key: string,
): WorldCharacterPermission[] {
  const value = body[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new HttpError(422, 'invalid_world_permissions', `${key} must be an array of non-empty strings`)
  }
  return value.map((item) => (item as string).trim()) as WorldCharacterPermission[]
}

/**
 * Attaches the concrete action a permission request is gating.
 *
 * A card that says only "requests world.settings.write" asks the user to
 * consent to a permission key, not to a change. The same argument is already
 * written down for the approval card next to it; the world card was strictly
 * weaker.
 */
function withSubject(store: SqliteStore, request: WorldPermissionRequest): WorldPermissionRequest & {
  subject?: { id: string; action: string; target: string; label: string; parameters: JsonObject }
} {
  const action = store.getSkillAction?.(request.skillActionId)
    ?? store.listWorldSkillActions(request.worldId).find((item) => item.id === request.skillActionId)
  if (action === undefined) return request
  return {
    ...request,
    subject: {
      id: action.id,
      action: action.action,
      target: action.target,
      label: action.label,
      // Adapter parameters are host-authored but small and open-ended; run
      // them through the same redaction the audit trail uses so a card can
      // never show more than the trace would.
      parameters: sanitizer.json(action.parameters),
    },
  }
}

const sanitizer = new TraceSanitizer()

function listPendingApprovalViews(
  store: SqliteStore,
  skillRuntime: CharacterSkillRuntime,
  worldId: string,
): ApprovalRequestView[] {
  const requests = skillRuntime.listApprovalRequests(worldId, 'pending')
  const actions = new Map(store.listWorldSkillActions(worldId).map((action) => [action.id, action]))
  const characters = new Map(store.listEmployees(worldId, true).map((character) => [character.id, character]))
  return requests.map((request) => {
    const subject = request.subjectType === 'skill-action' ? actions.get(request.subjectId) : undefined
    const character = request.characterId === undefined ? undefined : characters.get(request.characterId)
    return {
      request,
      ...(character === undefined ? {} : { characterName: character.displayName }),
      ...(subject === undefined ? {} : {
        subject: {
          id: subject.id,
          skillId: subject.skillId,
          adapterId: subject.adapterId,
          action: subject.action,
          target: subject.target,
          label: subject.label,
          risk: subject.risk,
          parameters: subject.parameters,
          ...(subject.scheduledFor === undefined ? {} : { scheduledFor: subject.scheduledFor }),
        },
      }),
    }
  })
}

