import type {
  ConversationOrchestrator,
  ConversationResult,
  GroupTurnPlan,
} from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { CharacterSkillAction, ConversationQueueEntry, JsonObject, WorkMessage } from '@dsh-cyber/contracts'

import { applyInstalledPromptTransforms } from '../installed-package-runtime.js'
import { registerConversationQueueRoutes } from '../routes/conversation-queue-routes.js'
import type { Router } from '../http/router.js'
import type { WorldAccessService } from './world-access-service.js'
import { factualRuntimeSource, type TurnAwareApprovalContinuationService } from './turn-aware-approval-continuation-service.js'
import type { EmployeeActivityProjectionService } from './employee-activity-projection-service.js'
import type { WorldTraceService } from './world-trace-service.js'
import type { RuntimeStreamHub } from '../streams/runtime-stream-hub.js'
import type { WorldRuntimeService } from '../world-runtime-service.js'
import { ConversationQueueService } from './conversation-queue-service.js'
import type { GroupTaskCollaborationService } from './group-task-collaboration-service.js'
import type { WorkSystemService } from './work-system-service.js'
import type { GroupTaskRoutingResult } from './group-task-router.js'
import type { WorldPackageInstanceService } from './world-package-instance-service.js'
import type { WorldRuntimePromptComposer } from './world-runtime-context-composer.js'
import type { CharacterSkillRuntime } from './character-skill-runtime.js'
import { preparedGroupTurnPlannerFor } from '../composition/compose-group-turn-planner.js'

export function composeConversationControl(options: {
  store: SqliteStore
  router: Router
  worldAccess: WorldAccessService
  orchestrator: ConversationOrchestrator
  continuations: TurnAwareApprovalContinuationService
  employeeActivity: EmployeeActivityProjectionService
  worldRuntime: WorldRuntimeService
  worldTrace: WorldTraceService
  runtimeStreamHub: RuntimeStreamHub
  groupTasks: GroupTaskCollaborationService
  worldPackages: WorldPackageInstanceService
  runtimeContext: Pick<WorldRuntimePromptComposer, 'composeGroupRuntimePrompt'>
  skillRuntime: Pick<CharacterSkillRuntime, 'prepare'>
  /** Looked up only to see whether a settled turn is the source of a draft. */
  work: Pick<WorkSystemService, 'taskForSourceTurn'>
}): { queue: ConversationQueueService; start(): void; close(): Promise<void> } {
  const queue = new ConversationQueueService({
    store: options.store,
    orchestrator: options.orchestrator,
    continuations: options.continuations,
    runner: async (entry) => {
      if (entry.conversationKind === 'direct') return options.continuations.runQueuedDirect(entry.workTurnId)
      return runQueuedGroup(entry, options)
    },
    onSettled: async (entry) => {
      // Queue employeeIds is the reservation set for groups. Only actual
      // executors are projected; silent room members remain available.
      for (const employeeId of entry.employeeIds) options.employeeActivity.project(employeeId)
      options.worldRuntime.publishCurrent(entry.worldId)
      if (options.store.getWorkTurn(entry.workTurnId)?.status === 'waiting-approval') {
        options.worldRuntime.publishDecisionChanged(entry.worldId, { workTurnId: entry.workTurnId, status: 'waiting-approval' })
      }
      // A queued instruction records its draft while the turn is still waiting
      // in line, and the task shows that turn's execution. The turn has just
      // ended, so a panel that is already open is displaying a state that is
      // no longer true. Nothing about the task itself changed — a draft stays
      // a draft — this only says "re-read the row".
      const sourceTask = options.work.taskForSourceTurn(entry.workTurnId)
      if (sourceTask !== undefined) {
        options.worldRuntime.publishTaskChanged(entry.worldId, { taskId: sourceTask.id, status: sourceTask.status, source: 'conversation' })
      }
      const trace = await options.worldTrace.list(entry.worldId, { limit: 50 })
      options.runtimeStreamHub.publishTrace(entry.worldId, trace.items.filter((item) => item.workTurnId === entry.workTurnId))
    },
  })
  options.continuations.setGroupContinuationHandler(async (turn, actions) => {
    const entry = options.store.getConversationQueueEntryByWorkTurn(turn.worldId, turn.id)
    if (entry === undefined) throw new Error('Group approval queue entry is unavailable')
    const resumed = await runQueuedGroup(entry, options, actions)
    if (resumed.result === undefined) return undefined
    return { ...resumed.result, workTurnId: turn.id, waitingForApproval: false }
  })
  registerConversationQueueRoutes(options.router, {
    store: options.store,
    worldAccess: options.worldAccess,
    queue,
  })
  return {
    queue,
    start() { queue.start() },
    close() { return queue.close() },
  }
}

async function runQueuedGroup(
  entry: ConversationQueueEntry,
  options: Pick<Parameters<typeof composeConversationControl>[0],
    'store' | 'orchestrator' | 'groupTasks' | 'worldPackages' | 'runtimeContext' | 'skillRuntime'>,
  preparedActions?: CharacterSkillAction[],
): Promise<{ waitingForApproval?: boolean; result?: ConversationResult }> {
  const turn = options.store.getWorkTurn(entry.workTurnId)
  const session = options.store.getSession(entry.sessionId)
  const message = currentTurnUserMessage(options.store.listMessages(entry.sessionId), entry.workTurnId)
  if (turn === undefined || session === undefined || message === undefined || session.kind !== 'group') {
    throw new Error('Queued group conversation is unavailable')
  }
  // WorkSession membership and runtime reservation are intentionally different
  // concepts. The session continues to contain everyone in the room, while the
  // queue row reserves lanes only for the employees selected by the persisted
  // plan. Orchestrator validates the former and executes the latter through the
  // seeded discussion plan / task assignments.
  const participantIds = stringArray(message.metadata.participantIds)
  const groupEmployeeIds = participantIds.length >= 2 ? participantIds : entry.employeeIds
  const prompt = message.content
  const executionPrompt = attachmentAwareQueuedPrompt(prompt, message.metadata)
  const transformedPrompt = await applyInstalledPromptTransforms(await options.worldPackages.listRuntimePackages(entry.worldId), executionPrompt)
  const actions = preparedActions ?? await prepareGroupSkillActions(entry, executionPrompt, options.skillRuntime, message.metadata)
  if (actions.some((action) => action.status === 'waiting-for-approval')) {
    options.store.waitWorkTurnForApproval(entry.workTurnId)
    return { waitingForApproval: true }
  }
  const factualPrompt = factualRuntimeSource(transformedPrompt, actions)
  if ((entry.collaborationMode ?? session.collaborationMode ?? 'discussion') === 'task') {
    const coordinatorEmployeeId = stringMetadata(message.metadata, 'coordinatorEmployeeId')
    const preplannedRouting = taskRoutingFromMetadata(message.metadata, entry.employeeIds)
    return { result: await options.groupTasks.run({
      workspaceId: entry.workspaceId,
      worldId: entry.worldId,
      employeeIds: groupEmployeeIds,
      prompt,
      transformedPrompt: factualPrompt,
      metadata: message.metadata,
      sessionId: entry.sessionId,
      existingWorkTurnId: entry.workTurnId,
      ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
      ...(entry.permissionMode === undefined ? {} : { permissionMode: entry.permissionMode }),
      ...(coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId }),
      ...(preplannedRouting === undefined ? {} : { preplannedRouting }),
    }) }
  }

  const preparedPlan = groupTurnPlanFromMetadata(message.metadata)
  if (preparedPlan !== undefined) {
    preparedGroupTurnPlannerFor(options.store)?.seed({
      workspaceId: entry.workspaceId,
      worldId: entry.worldId,
      sessionId: entry.sessionId,
      prompt,
    }, preparedPlan)
  }
  return { result: await options.orchestrator.group({
    workspaceId: entry.workspaceId,
    worldId: entry.worldId,
    employeeIds: groupEmployeeIds,
    prompt,
    metadata: message.metadata,
    collaborationMode: 'discussion',
    sessionId: entry.sessionId,
    existingWorkTurnId: entry.workTurnId,
    runtimePrompt: await options.runtimeContext.composeGroupRuntimePrompt(entry.worldId, factualPrompt),
    ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
    ...(entry.permissionMode === undefined ? {} : { permissionMode: entry.permissionMode }),
  }) }
}

/**
 * Prepare at most one host action per actual executor. The old loop returned
 * the first matching action in room order, which meant an unrelated first
 * member could perform the browser/audio/etc action for the employee who was
 * actually assigned the work. Total actions stay bounded for cost/safety.
 *
 * In task mode a coordinator may be reserved only so it can synthesize the
 * final answer. It must not steal an external action from a step assignee, so
 * persisted task routing narrows action preparation to actual step owners.
 */
async function prepareGroupSkillActions(
  entry: ConversationQueueEntry,
  prompt: string,
  skillRuntime: Pick<CharacterSkillRuntime, 'prepare'>,
  metadata: JsonObject,
): Promise<CharacterSkillAction[]> {
  const taskRouting = taskRoutingFromMetadata(metadata, entry.employeeIds)
  const actionEmployees = taskRouting === undefined
    ? entry.employeeIds
    : [...new Set(taskRouting.steps.flatMap((step) => step.assignedEmployeeIds))]
  const actions: CharacterSkillAction[] = []
  for (const characterId of actionEmployees) {
    const prepared = await skillRuntime.prepare({
      workspaceId: entry.workspaceId,
      worldId: entry.worldId,
      sessionId: entry.sessionId,
      workTurnId: entry.workTurnId,
      characterId,
      prompt,
      maxActions: 1,
    })
    actions.push(...prepared.actions)
    if (actions.length >= 4) break
  }
  return actions.slice(0, 4)
}

function currentTurnUserMessage(messages: WorkMessage[], workTurnId: string): WorkMessage | undefined {
  return messages.findLast((message) => message.kind === 'user' && message.metadata.workTurnId === workTurnId)
}

function stringMetadata(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function groupTurnPlanFromMetadata(metadata: JsonObject): GroupTurnPlan | undefined {
  const raw = metadata.groupTurnPlan
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const object = raw as Record<string, unknown>
  if (object.source !== 'heuristic' && object.source !== 'model' && object.source !== 'explicit') return undefined
  if (!Array.isArray(object.waves)) return undefined
  const waves = object.waves.flatMap((rawWave) => {
    if (rawWave === null || typeof rawWave !== 'object' || Array.isArray(rawWave)) return []
    const rawSpeakers = (rawWave as { speakers?: unknown }).speakers
    if (!Array.isArray(rawSpeakers)) return []
    const speakers = rawSpeakers.flatMap((rawSpeaker) => {
      if (rawSpeaker === null || typeof rawSpeaker !== 'object' || Array.isArray(rawSpeaker)) return []
      const item = rawSpeaker as { employeeId?: unknown; brief?: unknown }
      if (typeof item.employeeId !== 'string' || !item.employeeId.trim()) return []
      return [{
        employeeId: item.employeeId.trim(),
        ...(typeof item.brief === 'string' && item.brief.trim() ? { brief: item.brief.trim() } : {}),
      }]
    })
    return speakers.length === 0 ? [] : [{ speakers }]
  })
  if (waves.length === 0) return undefined
  return {
    source: object.source,
    waves,
    ...(typeof object.rationale === 'string' && object.rationale.trim() ? { rationale: object.rationale.trim() } : {}),
  }
}

function taskRoutingFromMetadata(metadata: JsonObject, reservationEmployeeIds: readonly string[]): GroupTaskRoutingResult | undefined {
  const raw = metadata.taskRouting
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const object = raw as Record<string, unknown>
  const coordinatorEmployeeId = typeof object.coordinatorEmployeeId === 'string' ? object.coordinatorEmployeeId.trim() : ''
  if (!coordinatorEmployeeId || !reservationEmployeeIds.includes(coordinatorEmployeeId) || !Array.isArray(object.steps)) return undefined
  const reservation = new Set(reservationEmployeeIds)
  const steps = object.steps.flatMap((rawStep, index) => {
    if (rawStep === null || typeof rawStep !== 'object' || Array.isArray(rawStep)) return []
    const item = rawStep as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const assignedEmployeeIds = stringArray(item.assignedEmployeeIds).filter((id) => reservation.has(id))
    if (!id || assignedEmployeeIds.length === 0) return []
    const executionMode = item.executionMode === 'sequential' ? 'sequential' as const : 'parallel' as const
    return [{
      id,
      ordinal: typeof item.ordinal === 'number' && Number.isSafeInteger(item.ordinal) && item.ordinal > 0 ? item.ordinal : index + 1,
      requiredSkills: stringArray(item.requiredSkills),
      assignedEmployeeIds,
      dependsOn: stringArray(item.dependsOn),
      executionMode,
      status: 'pending' as const,
    }]
  })
  if (steps.length === 0) return undefined
  return {
    coordinatorEmployeeId,
    steps,
    requiredSkillIds: [...new Set(steps.flatMap((step) => step.requiredSkills))],
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
}

function attachmentAwareQueuedPrompt(prompt: string, metadata: JsonObject): string {
  const raw = metadata.attachments
  if (!Array.isArray(raw) || raw.length === 0) return prompt
  const inventory = raw.flatMap((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim() : ''
    const assetId = typeof item.assetId === 'string' ? item.assetId.trim() : ''
    return name && mimeType && assetId ? [`- ${name} (${mimeType}, asset ${assetId})`] : []
  })
  return inventory.length === 0
    ? prompt
    : `${prompt}\n\n用户随消息附加了以下本地文件：\n${inventory.join('\n')}\n请在回复中明确说明你如何使用这些附件；无法读取内容时不要臆测。`
}
