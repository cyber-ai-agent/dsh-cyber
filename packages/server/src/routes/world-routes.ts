import { BUILTIN_BLUEPRINTS, worldTemplate } from '@dsh-cyber/catalog'
import type { AgentPermissionMode, EmployeeBlueprint } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { loadInstalledBlueprints } from '../installed-package-runtime.js'
import { ConversationHubService } from '../services/conversation-hub-service.js'
import { adoptBlueprintAvatar, initialCharacterAppearance } from '../services/recruited-character-avatar.js'
import type { AssetService } from '../services/asset-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { OwnerRuntimeAccessService } from '../services/owner-runtime-access-service.js'
import type { WorldLifecycleService } from '../services/world-lifecycle-service.js'
import type { WorldPackageInstanceService } from '../services/world-package-instance-service.js'
import { requireWorldAcceptingWork } from '../services/world-work-guard.js'
import {
  availableWorldSkillIds,
  unavailableWorldSkillIds,
  type WorldSkillAvailabilityPort,
} from '../services/world-skill-availability.js'
import {
  nonNegativeInteger,
  optionalPositiveInteger,
  optionalString,
  optionalStringArray,
  readJson,
  requiredEnum,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'

export interface WorldRoutesDependencies {
  store: SqliteStore
  worldAccess?: WorldAccessService
  worldPackages?: WorldPackageInstanceService
  ownerRuntimeAccess?: OwnerRuntimeAccessService
  skillAvailability: WorldSkillAvailabilityPort
  lifecycle?: WorldLifecycleService
  assets?: Pick<AssetService, 'uploadCharacterAvatar'>
}

export function registerWorldRoutes(router: Router, dependencies: WorldRoutesDependencies): void {
  const { store, worldAccess, worldPackages, ownerRuntimeAccess, skillAvailability, lifecycle, assets } = dependencies
  const conversationHub = new ConversationHubService(store)

  // The default world list shows active worlds only. Archived worlds are a
  // deliberate second view, never mixed into the main list.
  router.get(/^\/api\/workspaces\/([^/]+)\/worlds$/, ({ response, params, url }) => {
    const requested = url.searchParams.get('status') ?? 'active'
    if (!['active', 'archived', 'all'].includes(requested)) {
      throw new HttpError(422, 'invalid_world_status_filter', 'status 只能是 active、archived 或 all')
    }
    const scope = requested as 'active' | 'archived' | 'all'
    const items = store.listWorlds(params[0]!, true)
      .filter((world) => scope === 'all'
        || (scope === 'archived' ? world.status === 'archived' : world.status === 'active'))
    writeJson(response, 200, { items })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/archive$/, ({ response, params }) => {
    writeJson(response, 200, { world: requireLifecycle(lifecycle).archive(params[0]!) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/restore$/, ({ response, params }) => {
    writeJson(response, 200, { world: requireLifecycle(lifecycle).restore(params[0]!) })
  })

  // Permanent deletion. The owner must re-type the world name in `confirmName`
  // and the world must have no work in flight; both refusals are fail-closed.
  router.delete(/^\/api\/worlds\/([^/]+)$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const result = await requireLifecycle(lifecycle).delete(params[0]!, requiredString(body, 'confirmName'))
    writeJson(response, 200, { deleted: true, worldId: result.world.id, filesRemoved: result.filesRemoved })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/worlds$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const requestedTemplateId = requiredString(body, 'templateId')
    if (worldTemplate(requestedTemplateId) === undefined) {
      throw new HttpError(422, 'unknown_world_template', 'Unknown world template')
    }
    const world = store.createWorld({
      workspaceId: params[0]!,
      name: requiredString(body, 'name'),
      templateId: requestedTemplateId,
    })
    writeJson(response, 201, { world })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/snapshot$/, async ({ request, response, params }) => {
    await worldAccess?.assertUnlocked(params[0]!, request)
    await conversationHub.ensureDirectSessions(params[0]!)
    writeJson(response, 200, store.getWorldSnapshot(params[0]!))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/events$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess?.assertUnlocked(worldId, request)
    writeJson(response, 200, {
      items: store.listWorldDomainEvents(worldId, nonNegativeInteger(url.searchParams.get('after'))),
    })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/sessions$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess?.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: store.listSessions(worldId) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/conversation-hub$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess?.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: await conversationHub.list(worldId) })
  })

  router.put(/^\/api\/sessions\/([^/]+)\/conversation-preferences$/, async ({ request, response, params }) => {
    const session = store.getSession(params[0]!)
    if (session === undefined) throw new HttpError(404, 'session_not_found', 'Session not found')
    await worldAccess?.assertUnlocked(session.worldId, request)
    const body = await readJson(request)
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw new HttpError(422, 'invalid_pinned', 'pinned must be boolean')
    if (body.hidden !== undefined && typeof body.hidden !== 'boolean') throw new HttpError(422, 'invalid_hidden', 'hidden must be boolean')
    if (body.pinned !== undefined) await conversationHub.setPinned(session.id, body.pinned)
    if (body.hidden !== undefined) await conversationHub.setHidden(session.id, body.hidden)
    writeJson(response, 200, { items: await conversationHub.list(session.worldId) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/recruit$/, async ({ request, response, params }) => {
    const world = requireWorldAcceptingWork(store, params[0]!)
    await worldAccess?.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const blueprintId = requiredString(body, 'blueprintId')
    const blueprintVersion = optionalPositiveInteger(body.blueprintVersion) ?? 1
    const liveBlueprint = await findLiveBlueprint(store, world.id, blueprintId, blueprintVersion, worldPackages)
    if (liveBlueprint === undefined) {
      // A blueprint is only recruitable where its package is instantiated.
      // Falling back to the workspace-global record let a character be
      // recruited into a world holding no instance of its package, which is
      // exactly what docs/architecture/world-package-instance-v1.md forbids.
      throw new HttpError(
        422,
        'blueprint_not_available_in_world',
        `当前世界没有这个角色蓝图的实例：${blueprintId}@${blueprintVersion}`,
      )
    }
    const recruitInput: Parameters<SqliteStore['recruitEmployee']>[0] = {
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId,
      blueprintVersion,
    }
    const runtimePermissionMode = body.runtimePermissionMode === undefined
      ? 'read-only'
      : requiredEnum<AgentPermissionMode>(body, 'runtimePermissionMode', ['read-only', 'workspace-write', 'danger-full-access'])
    if (runtimePermissionMode === 'danger-full-access' && body.confirmedFullAccess !== true) {
      throw new HttpError(422, 'owner_runtime_access_denied', '新增角色选择完全访问时必须明确确认高风险权限')
    }
    recruitInput.runtimePermissionMode = runtimePermissionMode
    const displayName = optionalString(body.displayName)
    if (displayName !== undefined) recruitInput.displayName = displayName
    if (body.skillGrants !== undefined) {
      if (!Array.isArray(body.skillGrants) || body.skillGrants.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw new HttpError(422, 'invalid_skill_grants', 'skillGrants must be an array of non-empty strings')
      }
      const skillGrants = optionalStringArray(body.skillGrants)
      const unavailable = await unavailableWorldSkillIds(skillAvailability, {
        workspaceId: world.workspaceId,
        worldId: world.id,
        skillIds: skillGrants,
      })
      if (unavailable.length > 0) {
        throw new HttpError(
          422,
          'skill_unavailable_in_world',
          `当前世界暂不可用：${unavailable.join('、')}`,
        )
      }
      recruitInput.skillGrants = skillGrants
    } else {
      // requestedSkills are initial recommendations.  A new recruit receives
      // only recommendations that the current World can actually execute;
      // an explicit [] above remains an intentional empty grant set.
      const defaults = await availableWorldSkillIds(skillAvailability, {
        workspaceId: world.workspaceId,
        worldId: world.id,
        skillIds: liveBlueprint.requestedSkills,
      })
      if (defaults.length > 0) recruitInput.skillGrants = defaults
    }
    if (body.capabilityGrants !== undefined) {
      if (!Array.isArray(body.capabilityGrants) || body.capabilityGrants.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw new HttpError(422, 'invalid_capability_grants', 'capabilityGrants must be an array of non-empty strings')
      }
      const capabilityGrants = optionalStringArray(body.capabilityGrants)
      if (capabilityGrants.length !== body.capabilityGrants.length) {
        throw new HttpError(422, 'duplicate_capability_grant', 'capabilityGrants must not contain duplicates')
      }
      const requestedCapabilities = new Set(liveBlueprint?.requestedCapabilities ?? store.getBlueprint(blueprintId, blueprintVersion)?.requestedCapabilities ?? [])
      const denied = capabilityGrants.find((capability) => !requestedCapabilities.has(capability))
      if (denied !== undefined) throw new HttpError(422, 'capability_not_requested', `Capability was not requested by the blueprint: ${denied}`)
      recruitInput.capabilityGrants = capabilityGrants
    }
    // The character's look is decided with the character, not left for each
    // reader to guess: the built-in slot is durable from the first profile
    // revision, and an owner-supplied image is adopted as the character's own.
    const appearance = initialCharacterAppearance(liveBlueprint)
    if (Object.keys(appearance).length > 0) recruitInput.appearance = appearance
    const employee = store.recruitEmployee(recruitInput)
    if (assets !== undefined) {
      await adoptBlueprintAvatar({
        store,
        assets,
        employee,
        blueprint: liveBlueprint,
        packages: worldPackages === undefined ? [] : await worldPackages.listRuntimePackages(world.id),
      }).catch(() => undefined)
    }
    await conversationHub.ensureDirectSessions(world.id)
    const session = store.listSessions(world.id).find((item) => item.kind === 'direct'
      && store.listParticipants(item.id).some((participant) => participant.kind === 'employee' && participant.participantId === employee.id))
    const grant = runtimePermissionMode === 'danger-full-access' && session !== undefined
      ? ownerRuntimeAccess?.issueSession({ worldId: world.id, sessionId: session.id, employeeIds: [employee.id], confirmed: true })
      : undefined
    // The profile travels with the response so the caller paints the character
    // it will still see after a reload, instead of a placeholder avatar that
    // changes the first time the dossier loads.
    const profile = store.getEmployeeProfile(employee.id)
    writeJson(response, 201, {
      employee,
      ...(profile === undefined ? {} : { profile }),
      ...(grant === undefined ? {} : { grant }),
    })
  })
}

function requireLifecycle(lifecycle: WorldLifecycleService | undefined): WorldLifecycleService {
  if (lifecycle === undefined) throw new HttpError(503, 'world_lifecycle_unavailable', '世界生命周期服务不可用')
  return lifecycle
}

async function findLiveBlueprint(
  store: SqliteStore,
  worldId: string,
  blueprintId: string,
  blueprintVersion: number,
  worldPackages?: WorldPackageInstanceService,
): Promise<EmployeeBlueprint | undefined> {
  const builtIn = BUILTIN_BLUEPRINTS.find((item) => item.id === blueprintId && item.version === blueprintVersion)
  if (builtIn !== undefined) return builtIn
  const installed = await loadInstalledBlueprints(worldPackages === undefined ? [] : await worldPackages.listRuntimePackages(worldId))
  return installed.find((item) => item.id === blueprintId && item.version === blueprintVersion)
}
