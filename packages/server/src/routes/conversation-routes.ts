import type { AgentPermissionMode, ApprovalRequestView, ChatAttachment, JsonObject, ReasoningEffort } from '@dsh-cyber/contracts'
import type {
  ConversationOrchestrator,
  DirectConversationInput,
} from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { mapPermissionDecisionError } from '../http/world-permission-errors.js'
import type { Router } from '../http/router.js'
import {
  nonNegativeInteger,
  optionalPositiveInteger,
  optionalString,
  optionalStringArray,
  readJson,
  record,
  requiredEnum,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'
import { applyInstalledPromptTransforms } from '../installed-package-runtime.js'
import {
  DelegatedCollaborationService,
  detectDelegatedCollaboration,
} from '../services/delegated-collaboration-service.js'
import { ConversationHubService } from '../services/conversation-hub-service.js'
import type { EmployeeActivityProjectionService } from '../services/employee-activity-projection-service.js'
import type { CharacterSkillRuntime } from '../services/character-skill-runtime.js'
import type { PeerCollaborationService } from '../services/peer-collaboration-service.js'
import type { RuntimeStreamHub } from '../streams/runtime-stream-hub.js'
import type { WorldRuntimeService } from '../world-runtime-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldFileService } from '../services/world-file-service.js'
import type { WorldSettingsService } from '../services/world-settings-service.js'
import type { WorldTraceService } from '../services/world-trace-service.js'
import type { WorldPackageInstanceService } from '../services/world-package-instance-service.js'
import type { OwnerRuntimeAccessService } from '../services/owner-runtime-access-service.js'
import type { WorldRuntimePermissionResolver } from '../services/world-runtime-permission-resolver.js'
import type { TurnAwareApprovalContinuationService } from '../services/turn-aware-approval-continuation-service.js'
import { ServiceError } from '../services/service-error.js'

export interface ConversationRoutesDependencies {
  store: SqliteStore
  orchestrator: ConversationOrchestrator
  peerCollaboration: PeerCollaborationService
  skillRuntime: CharacterSkillRuntime
  runtimeStreamHub: RuntimeStreamHub
  worldRuntime: WorldRuntimeService
  worldAccess: WorldAccessService
  worldFiles: WorldFileService
  worldSettings: WorldSettingsService
  worldTrace: WorldTraceService
  employeeActivity: EmployeeActivityProjectionService
  worldPackages: WorldPackageInstanceService
  worldRuntimePermissions?: WorldRuntimePermissionResolver
  /** Issues and spends one-time owner host-access grants. */
  ownerRuntimeAccess?: OwnerRuntimeAccessService
  turnContinuations: TurnAwareApprovalContinuationService
}

export function registerConversationRoutes(router: Router, dependencies: ConversationRoutesDependencies): void {
  const {
    store,
    orchestrator,
    peerCollaboration,
    skillRuntime,
    runtimeStreamHub,
    worldRuntime,
    worldAccess,
    worldFiles,
    worldSettings,
    worldTrace,
    employeeActivity,
    worldPackages,
    worldRuntimePermissions,
    ownerRuntimeAccess,
    turnContinuations,
  } = dependencies
  const delegatedCollaboration = new DelegatedCollaborationService({
    store,
    orchestrator,
    peerCollaboration,
    worldSettings,
  })
  const conversationHub = new ConversationHubService(store)

  router.post(/^\/api\/worlds\/([^/]+)\/group-sessions$/, async ({ request, response, params }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const employeeIds = [...new Set(optionalStringArray(body.employeeIds))]
    if (employeeIds.length < 2) throw new HttpError(422, 'group_participants_required', '群聊至少需要两名角色')
    const employees = employeeIds.map((employeeId) => store.getEmployee(employeeId))
    if (employees.some((employee) => employee === undefined || employee.worldId !== world.id || employee.status === 'archived')) {
      throw new HttpError(422, 'group_participant_unavailable', '群聊成员必须来自当前世界且处于可用状态')
    }
    const title = optionalString(body.title) ?? employees.map((employee) => employee!.displayName).join('、')
    const session = store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'group',
      title,
      participants: [
        { participantId: 'owner', kind: 'owner' },
        ...employeeIds.map((employeeId) => ({ participantId: employeeId, kind: 'employee' as const })),
      ],
      actorId: 'owner',
    })
    writeJson(response, 201, { session, participantIds: employeeIds })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/chat$/, async ({ request, response, params }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const prompt = requiredString(body, 'prompt')
    const explicitIds = optionalStringArray(body.employeeIds)
    const employeeIds = explicitIds.length > 0 ? explicitIds : mentionedEmployeeIds(prompt, store.listEmployees(world.id))
    const employees = employeeIds.map((employeeId) => store.getEmployee(employeeId))
    if (employeeIds.length === 0) throw new HttpError(422, 'agent_required', '至少需要一个角色')
    if (employees.some((employee) => employee === undefined || employee.worldId !== world.id || employee.status === 'archived')) {
      throw new HttpError(422, 'character_unavailable', '所选角色不属于当前世界或已归档')
    }

    // Settle an existing narrow approval phrase before tracing or beginning a
    const requestedSessionId = optionalString(body.sessionId)
    // turn. The approval response may continue its original WorkTurn, but it
    // never creates a second one.
    if (employeeIds.length === 1) {
      // A refusal from the authority layer is a legitimate answer to the user
      // ("a member cannot hold a management permission"), not a server fault.
      // This call sits outside the handler's main try block, so it needs its
      // own mapping or it escapes as an opaque 500.
      const approval = await decideTextApprovalSafely(turnContinuations, {
        worldId: world.id,
        employeeId: employeeIds[0]!,
        ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
        text: prompt,
        decidedBy: 'local-user',
        actor: { kind: 'owner', id: 'local-user' },
        source: 'raw-user',
      })
      if (approval.handled) {
        if (approval.continuation !== undefined) {
          writeJson(response, 200, { ...approval.continuation, permissionRequest: approval.request })
          return
        }
        // A decision whose turn was already pruned can still be shown, but it
        // has nothing left to continue.
        const originalTurn = approval.request.workTurnId === undefined
          ? undefined
          : store.getWorkTurn(approval.request.workTurnId)
        const sessionId = originalTurn?.sessionId ?? approval.request.sessionId
        const originalSession = sessionId === undefined ? undefined : store.getSession(sessionId)
        if (originalTurn === undefined || originalSession === undefined) {
          throw new HttpError(409, 'world_permission_continuation_unavailable', '原工作回合无法继续')
        }
        writeJson(response, 202, {
          session: originalSession,
          replies: [],
          workTurnId: originalTurn.id,
          waitingForApproval: true,
          permissionRequest: approval.request,
        })
        return
      }
    }
    const attachments = await validatedChatAttachments(body.attachments, store, world.workspaceId, world.id, worldFiles)
    const attachmentPrompt = attachments.length === 0 ? prompt : attachmentAwarePrompt(prompt, attachments)
    const transformedPrompt = await applyInstalledPromptTransforms(await worldPackages.listRuntimePackages(world.id), attachmentPrompt)
    const worldSettingsValue = await worldSettings.get(world.id)
    const requestedReasoning = body.reasoningEffort === undefined
      ? worldSettingsValue.model.reasoningEffort
      : requiredEnum<ReasoningEffort>(body, 'reasoningEffort', ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    const requestedPermissionMode = body.permissionMode === undefined ? 'read-only' : requiredEnum<AgentPermissionMode>(body, 'permissionMode', ['read-only', 'workspace-write', 'danger-full-access'])
    // Full host access requires a one-time grant the owner issued for this
    // exact turn. It is spent on the first check, so it cannot be replayed,
    // and nothing on the skill path can mint one.
    const ownerHostAccess = requestedPermissionMode === 'danger-full-access'
      && ownerRuntimeAccess?.consume({
        grantId: optionalString(body.runtimeAccessGrantId),
        worldId: world.id,
        employeeIds,
        clientTurnId: optionalString(body.clientTurnId),
      }) === true
    const resolvedPermissions = worldRuntimePermissions === undefined
      ? undefined
      : await Promise.all(employeeIds.map((employeeId) => worldRuntimePermissions.resolve({
          worldId: world.id,
          employeeId,
          requestedMode: requestedPermissionMode,
          ownerHostAccess,
        })))
    const permissionMode: AgentPermissionMode = resolvedPermissions === undefined
      // Without a resolver the request cannot be trusted to cap itself; the
      // safe default is the least privilege, not what the client asked for.
      ? requestedPermissionMode === 'danger-full-access' ? 'read-only' : requestedPermissionMode
      : resolvedPermissions.every((item) => item.permissionMode === 'danger-full-access')
        ? 'danger-full-access'
        : resolvedPermissions.every((item) => item.permissionMode === 'workspace-write' || item.permissionMode === 'danger-full-access')
          ? 'workspace-write'
          : 'read-only'
    if (employeeIds.length === 0) throw new HttpError(422, 'agent_required', '请选择或 @ 至少一个角色')
    const clientTurnId = optionalString(body.clientTurnId)
    if (clientTurnId !== undefined && clientTurnId.length > 128) {
      throw new HttpError(422, 'invalid_client_turn_id', 'clientTurnId cannot exceed 128 characters')
    }
    const metadata: JsonObject = {
      participantIds: employeeIds,
      permissionMode,
      interactionKind: body.interactionKind === 'task' || body.interactionKind === 'meeting' ? body.interactionKind : 'chat',
      ...(attachments.length === 0 ? {} : { attachments: attachments.map(chatAttachmentJson) }),
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
      ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
    }
    const title = optionalString(body.title)
    const traceCheckpoint = await createTraceCheckpoint(world.id, worldTrace)
    try {
    let result
    if (employeeIds.length === 1) {
      const character = store.getEmployee(employeeIds[0]!)
      if (character === undefined || character.worldId !== world.id) {
        throw new HttpError(422, 'character_unavailable', '所选角色不属于当前世界')
      }
      const canonical = (await conversationHub.list(world.id))
        .find((item) => item.canonicalCharacterId === character.id)
      const sessionId = requestedSessionId ?? canonical?.session.id
      if (sessionId !== undefined) {
        // restoreCanonicalDirect writes this world's hub state. A session id
        // supplied by the client is checked against the world *before* that
        // write, or one world's chat endpoint can un-hide a conversation
        // belonging to another world.
        const requested = store.getSession(sessionId)
        if (requested === undefined || requested.worldId !== world.id) {
          throw new HttpError(422, 'session_unavailable', '所选会话不属于当前世界')
        }
        await conversationHub.restoreCanonicalDirect(sessionId)
      }

      const delegation = detectDelegatedCollaboration({
        prompt,
        initiator: character,
        characters: store.listEmployees(world.id),
      })
      if (delegation !== undefined) {
        result = await delegatedCollaboration.run({
          ...delegation,
          workspaceId: world.workspaceId,
          worldId: world.id,
          transformedPrompt,
          metadata,
          ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
          permissionMode,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(title === undefined ? {} : { title }),
        })
      } else {
        const directInput: DirectConversationInput = {
          workspaceId: world.workspaceId,
          worldId: world.id,
          employeeId: character.id,
          prompt,
          metadata,
          ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
          permissionMode,
        }
        if (sessionId !== undefined) directInput.sessionId = sessionId
        if (title !== undefined) directInput.title = title
        result = await turnContinuations.direct({ ...directInput, skillPrompt: prompt, transformedPrompt })
      }
    } else {
      result = await orchestrator.group({
        workspaceId: world.workspaceId,
        worldId: world.id,
        employeeIds,
        prompt,
        metadata,
        runtimePrompt: await worldSettings.composeGroupRuntimePrompt(world.id, transformedPrompt),
        ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
        permissionMode,
        ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
        ...(title === undefined ? {} : { title }),
      })
    }
    for (const employeeId of employeeIds) employeeActivity.project(employeeId)
    worldRuntime.publishCurrent(world.id)
    writeJson(response, 200, result)
    } finally {
      await publishTraceChanges(world.id, worldTrace, traceCheckpoint, runtimeStreamHub)
    }
  })

  router.get(/^\/api\/worlds\/([^/]+)\/skill-actions$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: await skillRuntime.list(worldId) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/approvals$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    const rawStatus = url.searchParams.get('status')
    const status = rawStatus === null ? undefined : rawStatus
    if (status !== undefined && !['pending', 'approved', 'rejected', 'expired'].includes(status)) {
      throw new HttpError(422, 'invalid_approval_status', '不支持的审批状态')
    }
    const requests = skillRuntime.listApprovalRequests(worldId, status as 'pending' | 'approved' | 'rejected' | 'expired' | undefined)
    const actions = new Map(store.listWorldSkillActions(worldId).map((action) => [action.id, action]))
    // Consent to a real-world side effect needs the concrete call, not a
    // one-line summary, so the subject action travels with its request.
    const items: ApprovalRequestView[] = requests.map((request) => {
      const subject = request.subjectType === 'skill-action' ? actions.get(request.subjectId) : undefined
      const character = request.characterId === undefined ? undefined : store.getEmployee(request.characterId)
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
    writeJson(response, 200, { items })
  })

  router.post(/^\/api\/approvals\/([^/]+)\/decision$/, async ({ request, response, params }) => {
    const approval = store.getApprovalRequest(params[0]!)
    if (approval === undefined) throw new HttpError(404, 'approval_not_found', '审批请求不存在')
    await worldAccess.assertUnlocked(approval.worldId, request)
    if (approval.status !== 'pending') throw new HttpError(409, 'approval_already_decided', '审批请求已经处理')
    const body = await readJson(request)
    const decision = requiredEnum(body, 'decision', ['approved', 'rejected'])
    const scope = body.scope === undefined ? 'once' : requiredEnum(body, 'scope', ['once', 'character', 'world'])
    const result = await turnContinuations.decideApproval(approval.id, decision, scope, 'local-user')
    writeJson(response, 200, result)
  })

  router.get(/^\/api\/worlds\/([^/]+)\/approval-policies$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: skillRuntime.listApprovalPolicies(worldId) })
  })

  router.delete(/^\/api\/approval-policies\/([^/]+)$/, async ({ request, response, params }) => {
    const policy = skillRuntime.getApprovalPolicy(params[0]!)
    if (policy === undefined) throw new HttpError(404, 'approval_policy_not_found', '授权策略不存在')
    await worldAccess.assertUnlocked(policy.worldId, request)
    if (policy.revokedAt !== undefined) throw new HttpError(409, 'approval_policy_revoked', '授权策略已经撤销')
    writeJson(response, 200, { policy: skillRuntime.revokeApprovalPolicy(policy.id) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/peer-conversations$/, async ({ request, response, params }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const initiatorId = requiredString(body, 'initiatorId')
    const participantIds = optionalStringArray(body.participantIds)
    const purpose = requiredString(body, 'purpose')
    if (purpose.length > 2_000) throw new HttpError(422, 'purpose_too_long', '角色协作目标不能超过 2000 个字符')
    const maxRounds = optionalPositiveInteger(body.maxRounds) ?? 1
    if (maxRounds > 3) throw new HttpError(422, 'invalid_rounds', '角色协作最多进行 3 轮')
    const settings = await worldSettings.get(world.id)
    const requestedReasoning = body.reasoningEffort === undefined
      ? settings.model.reasoningEffort
      : requiredEnum<ReasoningEffort>(body, 'reasoningEffort', ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    const transformedPurpose = await applyInstalledPromptTransforms(await worldPackages.listRuntimePackages(world.id), purpose)
    const peerTitle = optionalString(body.title)
    const traceCheckpoint = await createTraceCheckpoint(world.id, worldTrace)
    try {
    const result = await peerCollaboration.run({
      workspaceId: world.workspaceId,
      worldId: world.id,
      initiatorId,
      participantIds,
      purpose,
      maxRounds,
      runtimePrompt: await worldSettings.composeGroupRuntimePrompt(world.id, transformedPurpose),
      ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
      ...(peerTitle === undefined ? {} : { title: peerTitle }),
    })
    worldRuntime.publishCurrent(world.id)
    writeJson(response, 201, result)
    } finally {
      await publishTraceChanges(world.id, worldTrace, traceCheckpoint, runtimeStreamHub)
    }
  })

  router.get(/^\/api\/worlds\/([^/]+)\/live$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    runtimeStreamHub.connect(worldId, request, response)
  })

  router.get(/^\/api\/sessions\/([^/]+)\/messages$/, async ({ request, response, params, url }) => {
    const session = store.getSession(params[0]!)
    if (session === undefined) throw new HttpError(404, 'session_not_found', 'Session not found')
    await worldAccess.assertUnlocked(session.worldId, request)
    // Keep the original after-cursor response for existing stream/recovery clients.
    // New chat/history clients use bounded pages so opening a long conversation never
    // materializes the complete transcript in the browser.
    const afterParam = url.searchParams.get('after')
    const hasPageOptions = ['limit', 'before', 'page', 'q', 'search', 'date', 'view'].some((key) => url.searchParams.has(key))
    if (afterParam !== null && !hasPageOptions) {
      writeJson(response, 200, { items: store.listMessages(session.id, nonNegativeInteger(afterParam)) })
      return
    }
    const limit = queryPositiveInteger(url.searchParams.get('limit'), 20) ?? 20
    const before = queryNonNegativeInteger(url.searchParams.get('before'))
    const page = queryPositiveInteger(url.searchParams.get('page'))
    const search = optionalString(url.searchParams.get('q') ?? url.searchParams.get('search'))
    const date = optionalString(url.searchParams.get('date'))
    if (date !== undefined && !isIsoCalendarDate(date)) {
      throw new HttpError(422, 'invalid_message_date', '日期必须使用 YYYY-MM-DD 格式')
    }
    if (search !== undefined && search.length > 160) {
      throw new HttpError(422, 'message_search_too_long', '搜索内容不能超过 160 个字符')
    }
    const result = store.listMessagesPage(session.id, {
      limit,
      ...(before === undefined ? {} : { beforeSequence: before }),
      ...(afterParam === null ? {} : { afterSequence: nonNegativeInteger(afterParam) }),
      ...(page === undefined ? {} : { page }),
      ...(search === undefined ? {} : { search }),
      ...(date === undefined ? {} : { date }),
      ...(url.searchParams.get('view') === 'chat' ? { chatOnly: true } : {}),
    })
    writeJson(response, 200, result)
  })

  router.get(/^\/api\/sessions\/([^/]+)\/turns$/, async ({ request, response, params }) => {
    const session = store.getSession(params[0]!)
    if (session === undefined) throw new HttpError(404, 'session_not_found', 'Session not found')
    await worldAccess.assertUnlocked(session.worldId, request)
    writeJson(response, 200, { items: store.listSessionTurns(session.id) })
  })

  router.get(/^\/api\/turns\/([^/]+)$/, async ({ request, response, params }) => {
    const turn = store.getWorkTurn(params[0]!)
    if (turn === undefined) throw new HttpError(404, 'turn_not_found', 'Turn not found')
    await worldAccess.assertUnlocked(turn.worldId, request)
    writeJson(response, 200, { turn, runs: store.listTurnAgentRuns(turn.id) })
  })

  router.get(/^\/api\/sessions\/([^/]+)\/participants$/, async ({ request, response, params }) => {
    const session = store.getSession(params[0]!)
    if (session === undefined) throw new HttpError(404, 'session_not_found', 'Session not found')
    await worldAccess.assertUnlocked(session.worldId, request)
    writeJson(response, 200, { items: store.listParticipants(session.id) })
  })
}

function queryPositiveInteger(value: string | null, fallback?: number): number | undefined {
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new HttpError(422, 'invalid_message_page', '分页参数必须是正整数')
  return parsed
}

function queryNonNegativeInteger(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new HttpError(422, 'invalid_message_cursor', '消息游标必须是非负整数')
  return parsed
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year!, month! - 1, day!))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day
}

async function publishTraceChanges(
  worldId: string,
  trace: WorldTraceService,
  checkpoint: Awaited<ReturnType<WorldTraceService['checkpoint']>>,
  stream: RuntimeStreamHub,
): Promise<void> {
  try {
    stream.publishTrace(worldId, await trace.changesSince(worldId, checkpoint))
  } catch {
    // Trace is an auxiliary read model and must not replace the conversation result.
  }
}

async function createTraceCheckpoint(
  worldId: string,
  trace: WorldTraceService,
): Promise<Awaited<ReturnType<WorldTraceService['checkpoint']>>> {
  try {
    return await trace.checkpoint(worldId)
  } catch {
    return new Map()
  }
}

async function validatedChatAttachments(value: unknown, store: SqliteStore, workspaceId: string, worldId: string, worldFiles: WorldFileService): Promise<ChatAttachment[]> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) throw new HttpError(422, 'invalid_attachments', 'Attachments must be an array with at most 8 items')
  return Promise.all(value.map(async (item) => {
    const input = record(item)
    if (input === undefined) throw new HttpError(422, 'invalid_attachment', 'Invalid attachment')
    const assetId = requiredString(input, 'assetId')
    const asset = store.getLocalAsset(assetId)
    if (asset !== undefined) {
      if (asset.workspaceId !== workspaceId || asset.kind !== 'attachment') throw new HttpError(422, 'attachment_unavailable', 'Attachment does not belong to this workspace')
      return {
        assetId: asset.id,
        name: requiredString(input, 'name').slice(0, 180),
        mimeType: asset.mimeType,
        byteLength: asset.byteLength,
        url: `/api/assets/${asset.id}`,
      }
    }
    try {
      return await worldFiles.getAttachment(worldId, assetId)
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'asset_not_found') throw new HttpError(422, 'attachment_unavailable', 'Attachment does not belong to this workspace')
      if (error instanceof ServiceError) throw new HttpError(422, 'invalid_attachment', '附件已损坏或无法读取，请重新上传')
      throw error
    }
  }))
}

function attachmentAwarePrompt(prompt: string, attachments: ChatAttachment[]): string {
  const inventory = attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}, asset ${attachment.assetId})`).join('\n')
  return `${prompt}\n\n用户随消息附加了以下本地文件：\n${inventory}\n请在回复中明确说明你如何使用这些附件；无法读取内容时不要臆测。`
}

function chatAttachmentJson(attachment: ChatAttachment): JsonObject {
  return { assetId: attachment.assetId, name: attachment.name, mimeType: attachment.mimeType, byteLength: attachment.byteLength, url: attachment.url }
}

function mentionedEmployeeIds(prompt: string, employees: Array<{ id: string; displayName: string }>): string[] {
  return employees
    .filter((employee) => prompt.includes(`@${employee.displayName}`))
    .sort((left, right) => prompt.indexOf(`@${left.displayName}`) - prompt.indexOf(`@${right.displayName}`))
    .map((employee) => employee.id)
}


/**
 * Decides a chat-typed world permission answer without letting a legitimate
 * refusal escape as an internal error.
 *
 * This call happens before the handler's own try block, so the authority
 * layer's refusals — "a member cannot hold a management permission", an
 * expired or already-decided request — reached the client as HTTP 500. The
 * inline card path has always mapped them to 409; this makes the two agree.
 */
async function decideTextApprovalSafely(
  turnContinuations: TurnAwareApprovalContinuationService,
  input: Parameters<TurnAwareApprovalContinuationService['tryDecideWorldPermissionText']>[0],
): ReturnType<TurnAwareApprovalContinuationService['tryDecideWorldPermissionText']> {
  try {
    return await turnContinuations.tryDecideWorldPermissionText(input)
  } catch (error) {
    const mapped = mapPermissionDecisionError(error)
    throw mapped instanceof HttpError ? mapped : error
  }
}
