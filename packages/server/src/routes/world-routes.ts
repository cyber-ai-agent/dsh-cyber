import { BUILTIN_BLUEPRINTS, worldTemplate } from '@dsh-cyber/catalog'
import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { loadInstalledBlueprints } from '../installed-package-runtime.js'
import { ConversationHubService } from '../services/conversation-hub-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldPackageInstanceService } from '../services/world-package-instance-service.js'
import {
  nonNegativeInteger,
  optionalPositiveInteger,
  optionalString,
  optionalStringArray,
  readJson,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'

export interface WorldRoutesDependencies {
  store: SqliteStore
  worldAccess?: WorldAccessService
  worldPackages?: WorldPackageInstanceService
}

export function registerWorldRoutes(router: Router, dependencies: WorldRoutesDependencies): void {
  const { store, worldAccess, worldPackages } = dependencies
  const conversationHub = new ConversationHubService(store)

  router.get(/^\/api\/workspaces\/([^/]+)\/worlds$/, ({ response, params }) => {
    writeJson(response, 200, { items: store.listWorlds(params[0]!) })
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

  router.put(/^\/api\/worlds\/([^/]+)\/administrator$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await worldAccess?.assertUnlocked(worldId, request)
    const body = await readJson(request)
    writeJson(response, 200, { world: store.setWorldAdministrator(worldId, requiredString(body, 'employeeId')) })
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
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess?.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const blueprintId = requiredString(body, 'blueprintId')
    const blueprintVersion = optionalPositiveInteger(body.blueprintVersion) ?? 1
    const liveBlueprint = await findLiveBlueprint(store, world.id, blueprintId, blueprintVersion, worldPackages)
    const recruitInput: Parameters<SqliteStore['recruitEmployee']>[0] = {
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId,
      blueprintVersion,
    }
    const displayName = optionalString(body.displayName)
    if (displayName !== undefined) recruitInput.displayName = displayName
    if (body.skillGrants !== undefined) {
      if (!Array.isArray(body.skillGrants) || body.skillGrants.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw new HttpError(422, 'invalid_skill_grants', 'skillGrants must be an array of non-empty strings')
      }
      const skillGrants = optionalStringArray(body.skillGrants)
      const requestedSkills = new Set(liveBlueprint?.requestedSkills ?? store.getBlueprint(blueprintId, blueprintVersion)?.requestedSkills ?? [])
      const denied = skillGrants.find((skill) => !requestedSkills.has(skill))
      if (denied !== undefined) throw new HttpError(422, 'skill_not_requested', `Skill was not requested by the blueprint: ${denied}`)
      recruitInput.skillGrants = skillGrants
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
    const employee = store.recruitEmployee(recruitInput)
    await conversationHub.ensureDirectSessions(world.id)
    writeJson(response, 201, { employee })
  })
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
