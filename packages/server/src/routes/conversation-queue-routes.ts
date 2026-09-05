import type { AgentPermissionMode, JsonObject, ReasoningEffort } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { agentTurnFailureMessage } from '../http/errors.js'
import type { AgentTurnFailureKind } from '@dsh-cyber/orchestration'
import { requireWorldAcceptingWork } from '../services/world-work-guard.js'
import { optionalString, readJson, requiredString } from '../http/request.js'
import type { Router } from '../http/router.js'
import { writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import { ConversationQueueService } from '../services/conversation-queue-service.js'

export interface ConversationQueueRoutesDependencies {
  store: SqliteStore
  worldAccess: WorldAccessService
  queue: ConversationQueueService
}

export function registerConversationQueueRoutes(router: Router, dependencies: ConversationQueueRoutesDependencies): void {
  const { store, worldAccess, queue } = dependencies

  router.post(/^\/api\/worlds\/([^/]+)\/(?:chat\/(?:queue|queued)|chat-queue)$/, async ({ request, response, params }) => {
    const world = requireWorldAcceptingWork(store, params[0]!)
    await worldAccess.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const prompt = requiredString(body, 'prompt')
    const employeeIds = Array.isArray(body.employeeIds)
      ? body.employeeIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
      : []
    if (employeeIds.length !== 1) throw new HttpError(422, 'queued_direct_requires_one_employee', 'Queued direct chat requires one employee')
    const employee = store.getEmployee(employeeIds[0]!)
    if (employee === undefined || employee.worldId !== world.id || employee.status === 'archived') {
      throw new HttpError(422, 'character_unavailable', '所选角色不属于当前世界或已归档')
    }
    const requestedSessionId = optionalString(body.sessionId)
    const session = requestedSessionId === undefined
      ? store.createSession({
          workspaceId: world.workspaceId,
          worldId: world.id,
          kind: 'direct',
          title: optionalString(body.title) ?? `与 ${employee.displayName} 对话`,
          participants: [
            { participantId: 'owner', kind: 'owner' },
            { participantId: employee.id, kind: 'employee' },
          ],
          actorId: 'owner',
        })
      : store.getSession(requestedSessionId)
    if (session === undefined || session.worldId !== world.id || session.kind !== 'direct') {
      throw new HttpError(422, 'session_unavailable', '所选会话不可用于排队')
    }
    const permissionMode = parsePermissionMode(body.permissionMode)
    const reasoningEffort = parseReasoningEffort(body.reasoningEffort)
    const clientTurnId = optionalString(body.clientTurnId)
    const metadata: JsonObject = {
      interactionKind: 'chat',
      queueEmployeeId: employee.id,
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
    }
    const queuePosition = optionalString(body.queuePosition)
    if (queuePosition !== undefined && queuePosition !== 'normal' && queuePosition !== 'next') {
      throw new HttpError(422, 'invalid_queue_position', 'queuePosition must be normal or next')
    }
    const queued = queue.enqueueDirect({
      workspaceId: world.workspaceId,
      worldId: world.id,
      employeeId: employee.id,
      prompt,
      // The queue stores the raw user message. Runtime package transforms are
      // evaluated exactly once by the dispatcher after the durable claim.
      transformedPrompt: prompt,
      skillPrompt: prompt,
      metadata,
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      sessionId: session.id,
    }, queuePosition === 'next')
    writeJson(response, 202, queued)
  })

  router.get(/^\/api\/worlds\/([^/]+)\/(?:conversation-queue|chat-queue)$/, async ({ request, response, params, url }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const sessionId = optionalString(url.searchParams.get('sessionId'))
    const status = optionalString(url.searchParams.get('status'))
    const validStatus = status === undefined || ['queued', 'running', 'waiting-approval', 'completed', 'failed', 'interrupted', 'cancelled'].includes(status)
    if (!validStatus) throw new HttpError(422, 'invalid_queue_status', 'Unsupported queue status')
    const visible = queue.list(world.id, sessionId, status as never)
      .filter((item) => status !== undefined || item.status === 'queued' || item.status === 'running' || item.status === 'waiting-approval')
    const items = visible.map((item) => {
      const session = store.getSession(item.sessionId)
      const userMessage = store.listMessages(item.sessionId)
        .findLast((message) => message.kind === 'user' && message.metadata.workTurnId === item.workTurnId)
      const clientTurnId = typeof userMessage?.metadata.clientTurnId === 'string'
        ? userMessage.metadata.clientTurnId
        : undefined
      return {
        ...item,
        id: clientTurnId ?? item.id,
        serverQueueId: item.id,
        queueKey: session?.kind === 'direct' && item.employeeIds[0] !== undefined
          ? `direct:${item.employeeIds[0]}`
          : `session:${item.sessionId}`,
        title: session?.title ?? '对话任务',
        ...(userMessage?.content === undefined ? {} : { content: userMessage.content }),
        createdAt: item.enqueuedAt,
        ...(item.errorCode === undefined ? {} : { error: queueErrorMessage(item.errorCode) }),
      }
    })
    writeJson(response, 200, { items })
  })

  router.post(/^\/api\/queue\/([^/]+)\/stop$/, async ({ request, response, params }) => {
    const entry = store.getConversationQueueEntry(params[0]!)
    if (entry === undefined) throw new HttpError(404, 'queue_entry_not_found', 'Queue entry not found')
    await worldAccess.assertUnlocked(entry.worldId, request)
    const result = await queue.stop(entry.id)
    writeJson(response, 200, result)
  })

  router.post(/^\/api\/queue\/([^/]+)\/cancel$/, async ({ request, response, params }) => {
    const entry = store.getConversationQueueEntry(params[0]!)
    if (entry === undefined) throw new HttpError(404, 'queue_entry_not_found', 'Queue entry not found')
    await worldAccess.assertUnlocked(entry.worldId, request)
    if (entry.status !== 'queued') throw new HttpError(409, 'queue_entry_not_queued', 'Only queued entries can be cancelled')
    writeJson(response, 200, { entry: queue.remove(entry.id, entry.revision) })
  })

  router.patch(/^\/api\/worlds\/([^/]+)\/chat-queue\/([^/]+)$/, async ({ request, response, params }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const entry = store.getConversationQueueEntry(params[1]!)
    if (entry === undefined || entry.worldId !== world.id) throw new HttpError(404, 'queue_entry_not_found', 'Queue entry not found')
    const body = await readJson(request)
    if (body.queueMode !== 'next') throw new HttpError(422, 'invalid_queue_mode', 'Only queueMode=next is supported')
    writeJson(response, 200, { queueItem: queue.promote(entry.id, entry.revision) })
  })

  router.delete(/^\/api\/worlds\/([^/]+)\/chat-queue\/([^/]+)$/, async ({ request, response, params }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const entry = store.getConversationQueueEntry(params[1]!)
    if (entry === undefined || entry.worldId !== world.id) throw new HttpError(404, 'queue_entry_not_found', 'Queue entry not found')
    if (entry.status !== 'queued') throw new HttpError(409, 'queue_entry_not_queued', 'Only queued entries can be cancelled')
    writeJson(response, 200, { queueItem: queue.remove(entry.id, entry.revision) })
  })

  router.post(/^\/api\/(?:turns|work-turns)\/([^/]+)\/(?:stop|abort)$/, async ({ request, response, params }) => {
    const turn = store.getWorkTurn(params[0]!)
    if (turn === undefined) throw new HttpError(404, 'turn_not_found', 'Turn not found')
    await worldAccess.assertUnlocked(turn.worldId, request)
    const entry = store.listConversationQueue(turn.worldId).find((item) => item.workTurnId === turn.id)
    const result = entry === undefined
      ? await queue.stopWorkTurn(turn.id)
      : await queue.stop(entry.id)
    writeJson(response, 200, result)
  })

  router.delete(/^\/api\/worlds\/([^/]+)\/(?:conversation-queue|chat-queue)$/, async ({ request, response, params, url }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const sessionId = optionalString(url.searchParams.get('sessionId'))
    writeJson(response, 200, { removed: queue.clear(world.id, world.workspaceId, sessionId) })
  })
}

function queueErrorMessage(errorCode: string): string {
  if (!errorCode.startsWith('runtime-')) return errorCode
  const kind = errorCode.slice('runtime-'.length)
  if (!isAgentTurnFailureKind(kind)) return errorCode
  return agentTurnFailureMessage(kind)
}

function isAgentTurnFailureKind(value: string): value is AgentTurnFailureKind {
  return value === 'context-limit'
    || value === 'authentication'
    || value === 'model-not-found'
    || value === 'rate-limited'
    || value === 'timeout'
    || value === 'unreachable'
    || value === 'unknown'
}

function parsePermissionMode(value: unknown): AgentPermissionMode | undefined {
  if (value === undefined) return undefined
  if (value === 'read-only' || value === 'workspace-write') return value
  throw new HttpError(422, 'invalid_permission_mode', 'Queued chat only supports read-only or workspace-write')
}

function parseReasoningEffort(value: unknown): Exclude<ReasoningEffort, 'auto'> | undefined {
  if (value === undefined || value === 'auto') return undefined
  if (value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value
  throw new HttpError(422, 'invalid_reasoning_effort', 'Unsupported reasoning effort')
}
