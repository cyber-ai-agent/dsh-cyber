import type { ConversationOrchestrator, ConversationResult } from '@dsh-cyber/orchestration'
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
import type { WorldPackageInstanceService } from './world-package-instance-service.js'
import type { WorldRuntimePromptComposer } from './world-runtime-context-composer.js'
import type { CharacterSkillRuntime } from './character-skill-runtime.js'

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
      for (const employeeId of entry.employeeIds) options.employeeActivity.project(employeeId)
      options.worldRuntime.publishCurrent(entry.worldId)
      if (options.store.getWorkTurn(entry.workTurnId)?.status === 'waiting-approval') {
        options.worldRuntime.publishDecisionChanged(entry.worldId, { workTurnId: entry.workTurnId, status: 'waiting-approval' })
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
  options: Pick<Parameters<typeof composeConversationControl>[0], 'store' | 'orchestrator' | 'groupTasks' | 'worldPackages' | 'runtimeContext' | 'skillRuntime'>,
  preparedActions?: CharacterSkillAction[],
): Promise<{ waitingForApproval?: boolean; result?: ConversationResult }> {
  const turn = options.store.getWorkTurn(entry.workTurnId)
  const session = options.store.getSession(entry.sessionId)
  const message = currentTurnUserMessage(options.store.listMessages(entry.sessionId), entry.workTurnId)
  if (turn === undefined || session === undefined || message === undefined || session.kind !== 'group') {
    throw new Error('Queued group conversation is unavailable')
  }
  const prompt = message.content
  const executionPrompt = attachmentAwareQueuedPrompt(prompt, message.metadata)
  const transformedPrompt = await applyInstalledPromptTransforms(await options.worldPackages.listRuntimePackages(entry.worldId), executionPrompt)
  const actions = preparedActions ?? await prepareGroupSkillActions(entry, executionPrompt, options.skillRuntime)
  if (actions.some((action) => action.status === 'waiting-for-approval')) {
    options.store.waitWorkTurnForApproval(entry.workTurnId)
    return { waitingForApproval: true }
  }
  const factualPrompt = factualRuntimeSource(transformedPrompt, actions)
  if ((entry.collaborationMode ?? session.collaborationMode ?? 'discussion') === 'task') {
    const coordinatorEmployeeId = stringMetadata(message.metadata, 'coordinatorEmployeeId')
    return { result: await options.groupTasks.run({
      workspaceId: entry.workspaceId,
      worldId: entry.worldId,
      employeeIds: entry.employeeIds,
      prompt,
      transformedPrompt: factualPrompt,
      metadata: message.metadata,
      sessionId: entry.sessionId,
      existingWorkTurnId: entry.workTurnId,
      ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
      ...(entry.permissionMode === undefined ? {} : { permissionMode: entry.permissionMode }),
      ...(coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId }),
    }) }
  }
  return { result: await options.orchestrator.group({
    workspaceId: entry.workspaceId,
    worldId: entry.worldId,
    employeeIds: entry.employeeIds,
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

async function prepareGroupSkillActions(
  entry: ConversationQueueEntry,
  prompt: string,
  skillRuntime: Pick<CharacterSkillRuntime, 'prepare'>,
): Promise<CharacterSkillAction[]> {
  for (const characterId of entry.employeeIds) {
    const prepared = await skillRuntime.prepare({
      workspaceId: entry.workspaceId,
      worldId: entry.worldId,
      sessionId: entry.sessionId,
      workTurnId: entry.workTurnId,
      characterId,
      prompt,
      maxActions: 1,
    })
    if (prepared.actions.length > 0) return prepared.actions
  }
  return []
}

function currentTurnUserMessage(messages: WorkMessage[], workTurnId: string): WorkMessage | undefined {
  return messages.findLast((message) => message.kind === 'user' && message.metadata.workTurnId === workTurnId)
}

function stringMetadata(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
