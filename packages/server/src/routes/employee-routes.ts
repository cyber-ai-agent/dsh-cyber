import type { CharacterAvatarProfile, JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { AgentPermissionMode } from '@dsh-cyber/contracts'
import { assertCharacterBehaviorProfileAppearance } from '@dsh-cyber/world-simulation'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldCharacterAuthorityService } from '../services/world-character-authority-service.js'
import type { OwnerRuntimeAccessService } from '../services/owner-runtime-access-service.js'
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
  requiredNumber,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'

export interface EmployeeRoutesDependencies {
  store: SqliteStore
  worldAccess?: WorldAccessService
  authority?: WorldCharacterAuthorityService
  ownerRuntimeAccess?: OwnerRuntimeAccessService
  skillAvailability: WorldSkillAvailabilityPort
}

export function registerEmployeeRoutes(router: Router, dependencies: EmployeeRoutesDependencies): void {
  const { store, worldAccess, authority, ownerRuntimeAccess, skillAvailability } = dependencies

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
    if (body.runtimePermissionMode !== undefined) {
      reviseInput.runtimePermissionMode = requiredEnum<AgentPermissionMode>(body, 'runtimePermissionMode', ['read-only', 'workspace-write', 'danger-full-access'])
      if (reviseInput.runtimePermissionMode === 'danger-full-access' && body.confirmedFullAccess !== true) {
        throw new HttpError(422, 'owner_runtime_access_denied', '角色选择完全访问时必须明确确认高风险权限')
      }
    }
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
    const revision = store.reviseEmployee(reviseInput)
    const grants = (revision.runtimePermissionMode ?? 'read-only') === 'danger-full-access'
      ? store.listSessions(employee.worldId)
        .filter((session) => session.kind === 'direct' && session.status === 'open' && store.listParticipants(session.id).some((participant) => participant.kind === 'employee' && participant.participantId === employee.id))
        .flatMap((session) => {
          const participants = store.listParticipants(session.id).filter((participant) => participant.kind === 'employee').map((participant) => participant.participantId)
          const grant = ownerRuntimeAccess?.issueSession({ worldId: employee.worldId, sessionId: session.id, employeeIds: participants, confirmed: true })
          return grant === undefined ? [] : [grant]
        })
      : []
    const revokedSessionIds = (revision.runtimePermissionMode ?? 'read-only') === 'danger-full-access'
      ? []
      : ownerRuntimeAccess?.revokeForEmployee(employee.worldId, employee.id) ?? []
    writeJson(response, 201, { revision, grants, revokedSessionIds })
  })

  router.get(/^\/api\/employees\/([^/]+)\/dossier$/, async ({ request, response, params }) => {
    await assertCharacterUnlocked(params[0]!, request)
    writeJson(response, 200, store.getEmployeeDossier(params[0]!))
  })

  router.put(/^\/api\/employees\/([^/]+)\/profile$/, async ({ request, response, params }) => {
    await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const appearance = record(body.appearance) as JsonObject | undefined
    const voiceProfileInput = record(body.voiceProfile)
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
      if (appearance.digitalHumanAvatar !== undefined) {
        const descriptor = avatarProfile(appearance.digitalHumanAvatar)
        if (descriptor === undefined) throw new HttpError(422, 'invalid_avatar_profile', '角色形象资料格式无效')
        const avatarAsset = store.getCharacterAvatarAsset(descriptor.assetId)
        if (avatarAsset === undefined || avatarAsset.employeeId !== params[0]) {
          throw new HttpError(422, 'avatar_asset_scope_mismatch', '角色形象资产不属于当前角色')
        }
      }
    }
    const profile = store.reviseEmployeeProfile({
      employeeId: params[0]!,
      ...(body.displayName === undefined ? {} : { displayName: requiredString(body, 'displayName') }),
      ...(body.role === undefined ? {} : { role: requiredString(body, 'role') }),
      ...(body.gender === undefined ? {} : { gender: requiredEnum(body, 'gender', ['female', 'male', 'neutral']) }),
      ...(voiceProfileInput === undefined
        ? {}
        : {
            voiceProfile: {
              provider: requiredEnum(voiceProfileInput, 'provider', ['auto', 'system', 'kokoro', 'cosyvoice']),
              voiceId: typeof voiceProfileInput.voiceId === 'string' ? voiceProfileInput.voiceId : '',
              speed: requiredNumber(voiceProfileInput, 'speed'),
              pitch: requiredNumber(voiceProfileInput, 'pitch'),
            },
          }),
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

  router.post(/^\/api\/employees\/([^/]+)\/avatar-assets\/([^/]+)\/publish$/, async ({ request, response, params }) => {
    const employee = await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const current = store.getEmployeeProfile(employee.id)
    const expectedProfileRevision = requiredInteger(body, 'expectedProfileRevision', 0)
    if ((current?.revision ?? 0) !== expectedProfileRevision) {
      throw new HttpError(409, 'profile_revision_conflict', '角色资料已在其他页面更新，请刷新后重试')
    }
    const avatarAsset = store.getCharacterAvatarAsset(params[1]!)
    if (avatarAsset === undefined || avatarAsset.employeeId !== employee.id || avatarAsset.worldId !== employee.worldId) {
      throw new HttpError(404, 'avatar_asset_not_found', '角色形象资产不存在')
    }
    if (avatarAsset.rendererKind === 'mesh-preview') {
      throw new HttpError(422, 'avatar_vrm_required', '普通 GLB 只能预览，不能发布为交互式 VRM 数字人')
    }
    const fallbackAvatarIndex = requiredInteger(body, 'fallbackAvatarIndex', 0, 7)
    const capabilities: CharacterAvatarProfile['capabilities'] = avatarAsset.rendererKind === 'vrm-3d'
      ? ['full-body', 'expression', 'gesture', 'look-at', ...(avatarAsset.validation.visemeReady === true ? ['viseme' as const] : [])]
      : ['portrait']
    const descriptor: CharacterAvatarProfile = {
      schemaVersion: 1,
      identityId: employee.id,
      rendererKind: avatarAsset.rendererKind,
      assetId: avatarAsset.assetId,
      ...(avatarAsset.rendererKind === 'image-2d' ? { portraitAssetId: avatarAsset.assetId } : {}),
      sourceName: avatarAsset.originalName,
      fallbackAvatarIndex,
      capabilities,
      publishedAt: new Date().toISOString(),
    }
    const appearance: JsonObject = {
      ...(current?.appearance ?? {}),
      avatarIndex: fallbackAvatarIndex,
      worldSkinIndex: fallbackAvatarIndex,
      digitalHumanAvatar: descriptor as unknown as JsonObject,
    }
    const profile = store.reviseEmployeeProfile({
      employeeId: employee.id,
      appearance,
      reason: `发布角色形象：${avatarAsset.originalName}`,
    })
    writeJson(response, 201, { profile, employee: store.getEmployee(employee.id), avatarAsset })
  })

  router.post(/^\/api\/employees\/([^/]+)\/avatar-profile\/rollback$/, async ({ request, response, params }) => {
    const employee = await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const current = store.getEmployeeProfile(employee.id)
    const expectedProfileRevision = requiredInteger(body, 'expectedProfileRevision', 1)
    if (current?.revision !== expectedProfileRevision) {
      throw new HttpError(409, 'profile_revision_conflict', '角色资料已在其他页面更新，请刷新后重试')
    }
    const targetRevision = requiredInteger(body, 'targetRevision', 1)
    const target = store.listEmployeeProfiles(employee.id).find((profile) => profile.revision === targetRevision)
    if (target === undefined || target.revision >= current.revision) {
      throw new HttpError(422, 'invalid_profile_revision', '只能恢复到更早的角色资料版本')
    }
    const descriptor = avatarProfile(target.appearance.digitalHumanAvatar)
    if (descriptor !== undefined) {
      const avatarAsset = store.getCharacterAvatarAsset(descriptor.assetId)
      if (avatarAsset === undefined || avatarAsset.employeeId !== employee.id) {
        throw new HttpError(409, 'avatar_asset_missing', '该历史版本引用的形象资产已经缺失，无法恢复')
      }
    }
    const profile = store.reviseEmployeeProfile({
      employeeId: employee.id,
      appearance: target.appearance,
      reason: `恢复角色形象版本 ${target.revision}`,
    })
    writeJson(response, 201, { profile, employee: store.getEmployee(employee.id), restoredFromRevision: target.revision })
  })

  router.post(/^\/api\/employees\/([^/]+)\/avatar-profile\/reset$/, async ({ request, response, params }) => {
    const employee = await assertCharacterUnlocked(params[0]!, request)
    const body = await readJson(request)
    const current = store.getEmployeeProfile(employee.id)
    const expectedProfileRevision = requiredInteger(body, 'expectedProfileRevision', 0)
    if ((current?.revision ?? 0) !== expectedProfileRevision) {
      throw new HttpError(409, 'profile_revision_conflict', '角色资料已在其他页面更新，请刷新后重试')
    }
    const fallbackAvatarIndex = requiredInteger(body, 'fallbackAvatarIndex', 0, 7)
    const appearance: JsonObject = { ...(current?.appearance ?? {}), avatarIndex: fallbackAvatarIndex, worldSkinIndex: fallbackAvatarIndex }
    delete appearance.digitalHumanAvatar
    const profile = store.reviseEmployeeProfile({ employeeId: employee.id, appearance, reason: '恢复内置角色形象' })
    writeJson(response, 201, { profile, employee: store.getEmployee(employee.id) })
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

function requiredInteger(body: Record<string, unknown>, key: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = requiredNumber(body, key)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(422, 'invalid_integer', `${key} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function avatarProfile(value: unknown): CharacterAvatarProfile | undefined {
  const input = record(value)
  if (input === undefined || input.schemaVersion !== 1) return undefined
  if ((input.rendererKind !== 'image-2d' && input.rendererKind !== 'vrm-3d') || typeof input.assetId !== 'string') return undefined
  return input as unknown as CharacterAvatarProfile
}
