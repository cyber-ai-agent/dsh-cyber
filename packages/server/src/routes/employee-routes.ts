import type { JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import { assertCharacterBehaviorProfileAppearance } from '@dsh-cyber/world-simulation'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldCharacterAuthorityService } from '../services/world-character-authority-service.js'
import {
  unavailableWorldSkillIds,
  type WorldSkillAvailabilityPort,
} from '../services/world-skill-availability.js'
import {
  nullableString,
  optionalString,
  optionalStringArray,
  readJson,
  record,
  requiredEnum,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'

export interface EmployeeRoutesDependencies {
  store: SqliteStore
  worldAccess?: WorldAccessService
  authority?: WorldCharacterAuthorityService
  skillAvailability: WorldSkillAvailabilityPort
}

export function registerEmployeeRoutes(router: Router, dependencies: EmployeeRoutesDependencies): void {
  const { store, worldAccess, authority, skillAvailability } = dependencies

  const assertCharacterUnlocked = async (employeeId: string, request: Parameters<WorldAccessService['assertUnlocked']>[1]) => {
    const employee = store.getEmployee(employeeId)
    if (employee === undefined) throw new HttpError(404, 'character_not_found', 'Character not found')
    await worldAccess?.assertUnlocked(employee.worldId, request)
    return employee
  }

  router.post(/^\/api\/employees\/([^/]+)\/revisions$/, async ({ request, response, params }) => {
    const employee = await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const reviseInput: Parameters<SqliteStore['reviseEmployee']>[0] = {
      employeeId: params[0]!,
      reason: requiredString(body, 'reason'),
    }
    const persona = optionalString(body.persona)
    if (persona !== undefined) reviseInput.persona = persona
    if (body.skillGrants !== undefined) {
      if (!Array.isArray(body.skillGrants) || body.skillGrants.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw new HttpError(422, 'invalid_skill_grants', 'skillGrants must be an array of non-empty strings')
      }
      const skillGrants = optionalStringArray(body.skillGrants)
      const unavailable = await unavailableWorldSkillIds(skillAvailability, {
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        skillIds: skillGrants,
      })
      const previous = store.getEmployeeRevision(employee.id, employee.currentRevision)
      const historical = new Set(previous?.skillGrants ?? [])
      const denied = unavailable.find((skillId) => !historical.has(skillId))
      if (denied !== undefined) {
        throw new HttpError(
          422,
          'skill_unavailable_in_world',
          `当前世界暂不可用：${denied}`,
        )
      }
      // An unavailable skill already present in the revision is deliberately
      // retained only when the caller keeps it in this explicit list. Omitting
      // it is the durable revoke operation.
      reviseInput.skillGrants = skillGrants
    }
    if (body.capabilityGrants !== undefined) {
      reviseInput.capabilityGrants = optionalStringArray(body.capabilityGrants)
    }
    const modelPolicy = record(body.modelPolicy)
    if (modelPolicy !== undefined) reviseInput.modelPolicy = modelPolicy as JsonObject
    writeJson(response, 201, { revision: store.reviseEmployee(reviseInput) })
  })

  router.get(/^\/api\/employees\/([^/]+)\/dossier$/, async ({ request, response, params }) => {
    await assertCharacterUnlocked(params[0]!, request)
    writeJson(response, 200, store.getEmployeeDossier(params[0]!))
  })

  router.put(/^\/api\/employees\/([^/]+)\/profile$/, async ({ request, response, params }) => {
    await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const appearance = record(body.appearance) as JsonObject | undefined
    if (appearance !== undefined) {
      try {
        assertCharacterBehaviorProfileAppearance(appearance)
      } catch (error) {
        throw new HttpError(
          422,
          'invalid_character_behavior_profile',
          error instanceof Error ? error.message : 'Invalid character behavior profile',
        )
      }
    }
    const profile = store.reviseEmployeeProfile({
      employeeId: params[0]!,
      ...(body.displayName === undefined ? {} : { displayName: requiredString(body, 'displayName') }),
      ...(body.role === undefined ? {} : { role: requiredString(body, 'role') }),
      ...(body.birthday === undefined ? {} : { birthday: nullableString(body.birthday) }),
      ...(body.background === undefined ? {} : { background: requiredString(body, 'background') }),
      ...(body.personalityTraits === undefined
        ? {}
        : { personalityTraits: optionalStringArray(body.personalityTraits) }),
      ...(appearance === undefined ? {} : { appearance }),
      reason: requiredString(body, 'reason'),
    })
    writeJson(response, 201, { profile, employee: store.getEmployee(params[0]!) })
  })

  router.post(/^\/api\/employees\/([^/]+)\/skill-evidence$/, async ({ request, response, params }) => {
    await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const evidence = store.recordSkillEvidence({
      employeeId: params[0]!,
      skillId: requiredString(body, 'skillId'),
      kind: requiredEnum(body, 'kind', ['task', 'test', 'review', 'artifact', 'training']),
      outcome: requiredEnum(body, 'outcome', ['observed', 'passed', 'failed']),
      summary: requiredString(body, 'summary'),
      sourceEventIds: optionalStringArray(body.sourceEventIds),
      sourceMessageIds: optionalStringArray(body.sourceMessageIds),
      artifactRefs: optionalStringArray(body.artifactRefs),
    })
    writeJson(response, 201, { evidence })
  })

  router.post(/^\/api\/employees\/([^/]+)\/skills$/, async ({ request, response, params }) => {
    await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const skill = store.reviseEmployeeSkill({
      employeeId: params[0]!,
      skillId: requiredString(body, 'skillId'),
      status: requiredEnum(body, 'status', ['learning', 'verified', 'suspended']),
      evidenceIds: optionalStringArray(body.evidenceIds),
      reason: requiredString(body, 'reason'),
    })
    writeJson(response, 201, { skill })
  })

  router.post(/^\/api\/employees\/([^/]+)\/milestones$/, async ({ request, response, params }) => {
    await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const milestone = store.appendEmployeeMilestone({
      employeeId: params[0]!,
      category: requiredEnum(body, 'category', [
        'joined', 'task', 'delivery', 'skill', 'review', 'promotion',
        'failure', 'recovery', 'celebration', 'birthday', 'reflection',
      ]),
      title: requiredString(body, 'title'),
      summary: requiredString(body, 'summary'),
      sourceEventIds: optionalStringArray(body.sourceEventIds),
      sourceMessageIds: optionalStringArray(body.sourceMessageIds),
      artifactRefs: optionalStringArray(body.artifactRefs),
      ...(body.occurredAt === undefined ? {} : { occurredAt: requiredString(body, 'occurredAt') }),
    })
    writeJson(response, 201, { milestone })
  })

  router.post(/^\/api\/employees\/([^/]+)\/journals$/, async ({ request, response, params }) => {
    await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const journal = store.writeEmployeeJournal({
      employeeId: params[0]!,
      localDate: requiredString(body, 'localDate'),
      summary: requiredString(body, 'summary'),
      highlights: optionalStringArray(body.highlights),
      sourceEventIds: optionalStringArray(body.sourceEventIds),
      sourceMessageIds: optionalStringArray(body.sourceMessageIds),
    })
    writeJson(response, 201, { journal })
  })

  router.post(/^\/api\/employees\/([^/]+)\/archive$/, async ({ request, response, params }) => {
    const employee = await assertCharacterUnlocked(params[0]!, request)
    const archived = authority === undefined
      ? store.archiveEmployee(employee.id, 'local-user')
      : authority.archiveEmployee(employee.worldId, employee.id, { kind: 'owner', id: 'local-user' })
    writeJson(response, 200, { employee: archived })
  })
}
