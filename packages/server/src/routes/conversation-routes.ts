import type { AgentPermissionMode, ChatAttachment, JsonObject, ReasoningEffort, WorkSessionCollaborationMode, WorkTask } from '@dsh-cyber/contracts'
import type {
  ConversationOrchestrator,
  DirectConversationInput,
  GroupTurnCandidate,
  GroupTurnPlan,
} from '@dsh-cyber/orchestration'
import {
  normalizeUserPrompt,
  UserPromptValidationError,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { requireWorldAcceptingWork } from '../services/world-work-guard.js'
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
import { WorldRuntimeContextComposer, type WorldRuntimePromptComposer } from '../services/world-runtime-context-composer.js'
import { ServiceError } from '../services/service-error.js'
import type { GroupTaskCollaborationService } from '../services/group-task-collaboration-service.js'
import type { GroupTaskRoutingResult } from '../services/group-task-router.js'
import type { PreparedGroupTurnPlanner } from '../services/prepared-group-turn-planner.js'
import type { ConversationQueueService } from '../services/conversation-queue-service.js'
import { GroupIntentRouter } from '../services/group-intent-router.js'
import type { ConversationTaskIntentOutcome, ConversationTaskIntentService } from '../services/conversation-task-intent-service.js'
import { listApprovalRequestViews } from '../services/approval-request-views.js'
import type { HarnessToolApprovalService } from '../services/harness-tool-approval-service.js'

const MAX_GROUP_PARTICIPANTS = 20

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
  runtimeContext?: WorldRuntimePromptComposer
  worldTrace: WorldTraceService
  employeeActivity: EmployeeActivityProjectionService
  worldPackages: WorldPackageInstanceService
  worldRuntimePermissions?: WorldRuntimePermissionResolver
  /** Issues current-session owner host-access grants. */
  ownerRuntimeAccess?: OwnerRuntimeAccessService
  turnContinuations: TurnAwareApprovalContinuationService
  toolApprovals?: HarnessToolApprovalService
  groupTasks?: GroupTaskCollaborationService
  groupTurnPlanner?: PreparedGroupTurnPlanner
  conversationQueue?: ConversationQueueService
  /**
   * Turns an owner message that asks for work into one draft task.
   *
   * Optional: a host composed without it simply never proposes a task, and
   * every conversation path behaves exactly as it did before.
   */
  taskIntent?: ConversationTaskIntentService
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
    // The world's stable rules no longer travel in the request: the runtime
    // renders them into the cacheable prefix, so a caller without contributors
    // gets the bare request composer rather than the settings service.
    runtimeContext = new WorldRuntimeContextComposer(),
    worldTrace,
    employeeActivity,
    worldPackages,
    worldRuntimePermissions,
    ownerRuntimeAccess,
    turnContinuations,
    toolApprovals,
    groupTasks,
    groupTurnPlanner,
    conversationQueue,
    taskIntent,
  } = dependencies
  const delegatedCollaboration = new DelegatedCollaborationService({
    store,
    orchestrator,
    peerCollaboration,
    worldSettings: runtimeContext,
  })
  const conversationHub = new ConversationHubService(store)
  const groupIntentRouter = new GroupIntentRouter()

  router.post(/^\/api\/worlds\/([^/]+)\/group-sessions$/, async ({ request, response, params }) => {
    const world = requireWorldAcceptingWork(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const employeeIds = [...new Set(optionalStringArray(body.employeeIds))]
    if (employeeIds.length < 2) throw new HttpError(422, 'group_participants_required', '群聊至少需要两名角色')
    if (employeeIds.length > MAX_GROUP_PARTICIPANTS) {
      throw new HttpError(422, 'group_participants_limit', `群聊最多支持 ${MAX_GROUP_PARTICIPANTS} 名角色`)
    }
    const employees = employeeIds.map((employeeId) => store.getEmployee(employeeId))
    if (employees.some((employee) => employee === undefined || employee.worldId !== world.id || employee.status === 'archived')) {
      throw new HttpError(422, 'group_participant_unavailable', '群聊成员必须来自当前世界且处于可用状态')
    }
    const title = optionalString(body.title) ?? employees.map((employee) => employee!.displayName).join('、')
    const collaborationMode = body.collaborationMode === undefined
      ? 'discussion' as const
      : requiredEnum<WorkSessionCollaborationMode>(body, 'collaborationMode', ['discussion', 'task'])
    const session = store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'group',
      collaborationMode,
      title,
      participants: [
        { participantId: 'owner', kind: 'owner' },
        ...employeeIds.map((employeeId) => ({ participantId: employeeId, kind: 'employee' as const })),
      ],
      actorId: 'owner',
    })
    writeJson(response, 201, { session, participantIds: employeeIds, collaborationMode })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/chat$/, async ({ request, response, params }) => {
    const world = requireWorldAcceptingWork(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const prompt = requiredChatPrompt(body.prompt)
    const explicitIds = optionalStringArray(body.employeeIds)
    const employeeIds = explicitIds.length > 0 ? explicitIds : mentionedEmployeeIds(prompt, store.listEmployees(world.id))
    const employees = employeeIds.map((employeeId) => store.getEmployee(employeeId))
    if (employeeIds.length === 0) throw new HttpError(422, 'agent_required', '至少需要一个角色')
    if (employeeIds.length > MAX_GROUP_PARTICIPANTS) throw new HttpError(422, 'group_participants_limit', `单次会话最多支持 ${MAX_GROUP_PARTICIPANTS} 名角色`)
    if (employees.some((employee) => employee === undefined || employee.worldId !== world.id || employee.status === 'archived')) {
      throw new HttpError(422, 'character_unavailable', '所选角色不属于当前世界或已归档')
    }

    const requestedSessionId = optionalString(body.sessionId)
    // Settle an existing narrow approval phrase before tracing or beginning a
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

    // The one place a message is classified, and the narrowest one: an owner
    // message that is about to open a new WorkTurn here. Approval replies
    // returned above; peer collaboration, schedules, ambient life, task step
    // runs and every queue re-execution of an existing turn enter elsewhere and
    // are never classified. Started now rather than after the turn so the call
    // overlaps attachments, planning, permissions and the characters' own work,
    // and settled once the turn has an id.
    const proposedTaskIntent = taskIntent?.propose({ workspaceId: world.workspaceId, worldId: world.id, prompt })

    if (body.collaborationMode !== undefined) {
      requiredEnum<WorkSessionCollaborationMode>(body, 'collaborationMode', ['discussion', 'task'])
    }
    const queueMode = body.queueMode === undefined
      ? undefined
      : requiredEnum<'normal' | 'next'>(body, 'queueMode', ['normal', 'next'])
    // Resolve the persisted mode before consuming attachments, permissions, or
    // a current-session host-access grant. A stale client hint must be rejected as a
    // no-op against the session authority, not after partial request setup.
    const requestedSession = employeeIds.length > 1 && requestedSessionId !== undefined
      ? store.getSession(requestedSessionId)
      : undefined
    if (employeeIds.length > 1 && requestedSessionId !== undefined && (requestedSession === undefined || requestedSession.worldId !== world.id)) {
      throw new HttpError(422, 'session_unavailable', '所选会话不属于当前世界')
    }
    if (requestedSession !== undefined) {
      const sessionMembers = new Set(store.listParticipants(requestedSession.id)
        .filter((participant) => participant.kind === 'employee')
        .map((participant) => participant.participantId))
      const outsideMention = mentionedEmployeeIds(prompt, store.listEmployees(world.id))
        .find((employeeId) => !sessionMembers.has(employeeId))
      if (outsideMention !== undefined) {
        throw new HttpError(422, 'mentioned_character_not_in_session', '被 @ 的角色不在当前群聊中，请先加入群聊')
      }
    }
    const groupIntent = employeeIds.length > 1 ? groupIntentRouter.route({ prompt }) : undefined
    const collaborationMode = groupIntent?.collaborationMode

    const attachments = await validatedChatAttachments(body.attachments, store, world.workspaceId, world.id, worldFiles)
    const attachmentPrompt = attachments.length === 0 ? prompt : attachmentAwarePrompt(prompt, attachments)
    const transformedPrompt = queueMode === undefined
      ? await applyInstalledPromptTransforms(await worldPackages.listRuntimePackages(world.id), attachmentPrompt)
      : attachmentPrompt
    const clientTurnId = optionalString(body.clientTurnId)
    if (clientTurnId !== undefined && clientTurnId.length > 128) {
      throw new HttpError(422, 'invalid_client_turn_id', 'clientTurnId cannot exceed 128 characters')
    }

    // Plan before permissions and queue reservation. Room membership is social
    // visibility; runtimeEmployeeIds is the minimum set that actually needs a
    // model/tool lane for this turn.
    let runtimeEmployeeIds = [...employeeIds]
    let plannedGroupTurn: GroupTurnPlan | undefined
    let plannedTaskRouting: GroupTaskRoutingResult | undefined
    let coordinatorEmployeeId = optionalString(body.coordinatorEmployeeId)
    if (employeeIds.length > 1 && collaborationMode === 'task') {
      if (groupTasks === undefined) throw new HttpError(501, 'task_router_unavailable', '任务协作调度服务不可用')
      plannedTaskRouting = await groupTasks.plan({
        workspaceId: world.workspaceId,
        worldId: world.id,
        employeeIds,
        prompt,
        ...(coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId }),
      })
      coordinatorEmployeeId = plannedTaskRouting.coordinatorEmployeeId
      runtimeEmployeeIds = uniqueEmployeeIds([
        ...plannedTaskRouting.steps.flatMap((step) => step.assignedEmployeeIds),
        plannedTaskRouting.coordinatorEmployeeId,
      ])
    } else if (employeeIds.length > 1 && groupTurnPlanner !== undefined) {
      const candidates = groupTurnCandidates(store, employeeIds)
      plannedGroupTurn = await groupTurnPlanner.prepare({
        workspaceId: world.workspaceId,
        worldId: world.id,
        sessionId: requestedSessionId ?? `pending:${clientTurnId ?? 'group'}`,
        prompt,
        candidates,
        collaborationMode: 'discussion',
      })
      runtimeEmployeeIds = uniqueEmployeeIds(plannedGroupTurn.waves.flatMap((wave) => wave.speakers.map((speaker) => speaker.employeeId)))
    }
    if (runtimeEmployeeIds.length === 0) runtimeEmployeeIds = [...employeeIds]

    const worldSettingsValue = await worldSettings.get(world.id)
    const requestedReasoning = body.reasoningEffort === undefined
      ? worldSettingsValue.model.reasoningEffort
      : requiredEnum<ReasoningEffort>(body, 'reasoningEffort', ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    const requestedPermissionMode = body.permissionMode === undefined
      ? defaultRuntimePermissionMode(store, runtimeEmployeeIds)
      : requiredEnum<AgentPermissionMode>(body, 'permissionMode', ['read-only', 'workspace-write', 'danger-full-access'])
    // Full host access requires a current-session grant issued by the owner;
    // nothing on the skill path can mint one. A grant for the whole room also
    // authorizes a planned subset, but an unrelated member no longer forces a
    // narrower permission on the employees who actually execute this turn.
    const runtimeAccessGrantId = optionalString(body.runtimeAccessGrantId)
    const ownerHostAccess = requestedPermissionMode === 'danger-full-access'
      && ownerRuntimeAccess?.authorizeSession({
        grantId: runtimeAccessGrantId,
        worldId: world.id,
        sessionId: requestedSessionId,
        employeeIds: runtimeEmployeeIds,
      }) === true
    if (requestedPermissionMode === 'danger-full-access' && !ownerHostAccess) {
      throw new HttpError(403, 'owner_runtime_access_denied', '当前会话完全访问授权已失效，请重新确认')
    }
    const resolvedPermissions = worldRuntimePermissions === undefined
      ? undefined
      : await Promise.all(runtimeEmployeeIds.map((employeeId) => worldRuntimePermissions.resolve({
          worldId: world.id,
          employeeId,
          requestedMode: requestedPermissionMode,
          ownerHostAccess,
        })))
    const permissionMode: AgentPermissionMode = resolvedPermissions === undefined
      ? requestedPermissionMode === 'danger-full-access'
        ? ownerHostAccess ? 'danger-full-access' : 'read-only'
        : requestedPermissionMode
      : resolvedPermissions.every((item) => item.permissionMode === 'danger-full-access')
        ? 'danger-full-access'
        : resolvedPermissions.every((item) => item.permissionMode === 'workspace-write' || item.permissionMode === 'danger-full-access')
          ? 'workspace-write'
          : 'read-only'

    const modelProfileId = optionalString(body.modelProfileId)
    if (modelProfileId !== undefined) {
      const profile = store.getModelProfile(modelProfileId)
      if (profile === undefined || profile.workspaceId !== world.workspaceId) {
        throw new HttpError(422, 'conversation_model_unavailable', '所选临时会话模型不存在或不属于当前工作区')
      }
    }
    // A group is where one model for the whole turn is the wrong shape: the
    // characters have their own assignments, and a single scalar silently
    // collapses all of them onto whatever the composer had selected.
    const modelProfileIds = participantModelProfileIds(body.modelProfileIds, world.workspaceId, store, employeeIds)
    const metadata: JsonObject = {
      participantIds: employeeIds,
      reservationEmployeeIds: runtimeEmployeeIds,
      permissionMode,
      interactionKind: body.interactionKind === 'task' || body.interactionKind === 'meeting' ? body.interactionKind : 'chat',
      ...(attachments.length === 0 ? {} : { attachments: attachments.map(chatAttachmentJson) }),
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
      ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
      ...(modelProfileId === undefined ? {} : { modelProfileId }),
      ...(modelProfileIds === undefined ? {} : { modelProfileIds }),
      ...(plannedGroupTurn === undefined ? {} : { groupTurnPlan: groupTurnPlanJson(plannedGroupTurn) }),
      ...(plannedTaskRouting === undefined ? {} : { taskRouting: taskRoutingJson(plannedTaskRouting) }),
    }
    if (groupIntent !== undefined) {
      metadata.collaborationMode = groupIntent.collaborationMode
      metadata.groupIntent = { source: 'core', reason: groupIntent.reason }
    }
    const title = optionalString(body.title)
    const traceCheckpoint = await createTraceCheckpoint(world.id, worldTrace)
    try {
    let result
    let responseStatus = 200
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
        const turnAwareInput = { ...directInput, skillPrompt: prompt, transformedPrompt }
        if (queueMode !== undefined) {
          if (conversationQueue === undefined) throw new HttpError(501, 'conversation_queue_unavailable', '对话队列服务不可用')
          result = conversationQueue.enqueueDirect(turnAwareInput, queueMode === 'next')
          responseStatus = 202
        } else {
          result = await turnContinuations.direct(turnAwareInput)
        }
      }
    } else {
      const effectiveCollaborationMode = collaborationMode ?? 'discussion'
      // The host intent core is authoritative for this turn. Client hints and
      // a legacy session mode cannot make a discussion look like a task (or
      // vice versa) in durable history.
      const collaborationMetadata: JsonObject = {
        ...metadata,
        ...(coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId }),
        interactionKind: effectiveCollaborationMode === 'task'
          ? 'task'
          : metadata.interactionKind === 'task' || metadata.interactionKind === 'meeting' ? 'meeting' : 'chat',
      }
      const groupInput = {
        workspaceId: world.workspaceId,
        worldId: world.id,
        // Queue ingress keeps the complete room membership so a newly-created
        // session is correct. The queue row itself reads reservationEmployeeIds
        // from metadata and execution resumes only those planned employees.
        employeeIds,
        prompt,
        metadata: collaborationMetadata,
        collaborationMode: effectiveCollaborationMode,
        ...(modelProfileIds === undefined ? {} : { modelProfileIds }),
        ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
        permissionMode,
        ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
        ...(title === undefined ? {} : { title }),
      }
      if (queueMode !== undefined) {
        if (conversationQueue === undefined) throw new HttpError(501, 'conversation_queue_unavailable', '对话队列服务不可用')
        result = conversationQueue.enqueueGroup(groupInput, queueMode === 'next')
        responseStatus = 202
      } else if (effectiveCollaborationMode === 'task') {
        if (groupTasks === undefined) throw new HttpError(501, 'task_router_unavailable', '任务协作调度服务不可用')
        // An existing room can execute just the planned subset. For an ad-hoc
        // API call without a session we keep all members in the newly-created
        // room while the preplanned routing still limits actual AgentRuns.
        const immediateEmployeeIds = requestedSessionId === undefined ? employeeIds : runtimeEmployeeIds
        result = await groupTasks.run({
          ...groupInput,
          employeeIds: immediateEmployeeIds,
          transformedPrompt,
          ...(coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId }),
          ...(plannedTaskRouting === undefined ? {} : { preplannedRouting: plannedTaskRouting }),
        })
      } else {
        const immediateEmployeeIds = requestedSessionId === undefined ? employeeIds : runtimeEmployeeIds
        if (plannedGroupTurn !== undefined && requestedSessionId !== undefined && groupTurnPlanner !== undefined) {
          groupTurnPlanner.seed({ workspaceId: world.workspaceId, worldId: world.id, sessionId: requestedSessionId, prompt }, plannedGroupTurn)
        }
        result = await orchestrator.group({
          ...groupInput,
          employeeIds: immediateEmployeeIds,
          runtimePrompt: await runtimeContext.composeGroupRuntimePrompt(world.id, transformedPrompt),
        })
      }
    }
    const proposedTask = await settleTaskIntent(taskIntent, proposedTaskIntent, world, result)
    for (const employeeId of runtimeEmployeeIds) employeeActivity.project(employeeId)
    worldRuntime.publishCurrent(world.id)
    writeJson(response, responseStatus, proposedTask === undefined ? result : { ...result, proposedTask })
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
    const items = listApprovalRequestViews(
      store,
      skillRuntime,
      worldId,
      status as 'pending' | 'approved' | 'rejected' | 'expired' | undefined,
      toolApprovals,
    )
    writeJson(response, 200, { items })
  })

  router.post(/^\/api\/approvals\/([^/]+)\/decision$/, async ({ request, response, params }) => {
    const approval = store.getApprovalRequest(params[0]!)
    if (approval === undefined) throw new HttpError(404, 'approval_not_found', '审批请求不存在')
    // Approving resumes the paused turn, which starts a new AgentRun. An
    // archived world must refuse that as clearly as it refuses a new chat.
    requireWorldAcceptingWork(store, approval.worldId)
    await worldAccess.assertUnlocked(approval.worldId, request)
    if (approval.status !== 'pending') throw new HttpError(409, 'approval_already_decided', '审批请求已经处理')
    const body = await readJson(request)
    const decision = requiredEnum(body, 'decision', ['approved', 'rejected'])
    const scope = body.scope === undefined ? 'once' : requiredEnum(body, 'scope', ['once', 'character', 'world'])
    if (approval.subjectType === 'tool-call' && scope !== 'once') {
      throw new HttpError(422, 'tool_approval_scope_forbidden', '运行时工具只支持本次批准')
    }
    const result = approval.subjectType === 'tool-call'
      ? await toolApprovals?.decide(approval.id, decision)
        ?? (() => { throw new HttpError(503, 'tool_approval_unavailable', '动作审批服务当前不可用') })()
      : await turnContinuations.decideApproval(approval.id, decision, scope, 'local-user')
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
    const world = requireWorldAcceptingWork(store, params[0]!)
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
      runtimePrompt: await runtimeContext.composeGroupRuntimePrompt(world.id, transformedPurpose),
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

/**
 * Records the task this turn asked for, once the turn owns an id.
 *
 * Every chat entry point returns the WorkTurn it created — the queued one
 * included, which is why a queued instruction is visible as a task before it
 * ever runs. A result carrying no turn has nothing to own a task and records
 * none. This never throws and never starts anything: `attach` writes the draft
 * row, and executing it stays an explicit action by the owner.
 */
async function settleTaskIntent(
  taskIntent: ConversationTaskIntentService | undefined,
  pending: Promise<ConversationTaskIntentOutcome> | undefined,
  world: { id: string; workspaceId: string },
  result: unknown,
): Promise<WorkTask | undefined> {
  if (taskIntent === undefined || pending === undefined) return undefined
  const outcome = await pending
  const workTurnId = (result as { workTurnId?: unknown }).workTurnId
  if (typeof workTurnId !== 'string' || workTurnId === '') return undefined
  const sessionId = (result as { session?: { id?: unknown } }).session?.id
  return taskIntent.attach(outcome, {
    workspaceId: world.workspaceId,
    worldId: world.id,
    workTurnId,
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
  })
}

function queryPositiveInteger(value: string | null, fallback?: number): number | undefined {
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new HttpError(422, 'invalid_message_page', '分页参数必须是正整数')
  return parsed
}

function requiredChatPrompt(value: unknown): string {
  try {
    return normalizeUserPrompt(value)
  } catch (error) {
    if (error instanceof UserPromptValidationError) {
      throw new HttpError(422, error.code, error.message)
    }
    throw error
  }
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

/**
 * Validates a per-character model map from the composer.
 *
 * Every profile has to exist in this workspace and every character has to be
 * in this turn, because the map reaches the runtime as a routing instruction:
 * an unchecked entry would let a request run a character on a model belonging
 * to somebody else's workspace.
 */
function participantModelProfileIds(
  value: unknown,
  workspaceId: string,
  store: SqliteStore,
  employeeIds: readonly string[],
): Record<string, string> | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  const participants = new Set(employeeIds)
  const resolved: Record<string, string> = {}
  for (const [employeeId, profileId] of Object.entries(source)) {
    if (!participants.has(employeeId)) {
      throw new HttpError(422, 'conversation_model_unavailable', '指定模型的角色不在本次会话中')
    }
    if (typeof profileId !== 'string' || profileId.trim() === '') {
      throw new HttpError(422, 'conversation_model_unavailable', '角色模型配置无效')
    }
    const profile = store.getModelProfile(profileId)
    if (profile === undefined || profile.workspaceId !== workspaceId) {
      throw new HttpError(422, 'conversation_model_unavailable', '所选角色模型不存在或不属于当前工作区')
    }
    resolved[employeeId] = profileId
  }
  return Object.keys(resolved).length === 0 ? undefined : resolved
}

function groupTurnCandidates(store: SqliteStore, employeeIds: readonly string[]): GroupTurnCandidate[] {
  return employeeIds.flatMap((employeeId) => {
    const employee = store.getEmployee(employeeId)
    if (employee === undefined) return []
    const revision = store.getEmployeeRevision(employee.id, employee.currentRevision)
    return [{
      employeeId: employee.id,
      displayName: employee.displayName,
      ...(employee.role.trim() ? { role: employee.role } : {}),
      ...(revision === undefined || revision.skillGrants.length === 0 ? {} : { skillIds: revision.skillGrants }),
    }]
  })
}

function groupTurnPlanJson(plan: GroupTurnPlan): JsonObject {
  return {
    source: plan.source,
    waves: plan.waves.map((wave) => ({
      speakers: wave.speakers.map((speaker) => ({
        employeeId: speaker.employeeId,
        ...(speaker.brief === undefined ? {} : { brief: speaker.brief }),
      })),
    })),
    ...(plan.rationale === undefined ? {} : { rationale: plan.rationale }),
  }
}

function taskRoutingJson(routing: GroupTaskRoutingResult): JsonObject {
  return {
    coordinatorEmployeeId: routing.coordinatorEmployeeId,
    requiredSkillIds: routing.requiredSkillIds,
    steps: routing.steps.map((step) => ({
      id: step.id,
      ordinal: step.ordinal,
      requiredSkills: step.requiredSkills,
      assignedEmployeeIds: step.assignedEmployeeIds,
      dependsOn: step.dependsOn,
      executionMode: step.executionMode,
      status: step.status,
    })),
  }
}

function uniqueEmployeeIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function mentionedEmployeeIds(prompt: string, employees: Array<{ id: string; displayName: string }>): string[] {
  return employees
    .filter((employee) => prompt.includes(`@${employee.displayName}`))
    .sort((left, right) => prompt.indexOf(`@${left.displayName}`) - prompt.indexOf(`@${right.displayName}`))
    .map((employee) => employee.id)
}

function defaultRuntimePermissionMode(store: SqliteStore, employeeIds: string[]): AgentPermissionMode {
  const rank: Record<AgentPermissionMode, number> = {
    'read-only': 0,
    'workspace-write': 1,
    'danger-full-access': 2,
  }
  return employeeIds
    .map((employeeId) => {
      const employee = store.getEmployee(employeeId)
      return employee === undefined
        ? 'read-only'
        : store.getEmployeeRevision(employee.id, employee.currentRevision)?.runtimePermissionMode ?? 'read-only'
    })
    .reduce<AgentPermissionMode>((least, mode) => rank[mode] < rank[least] ? mode : least, 'danger-full-access')
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
