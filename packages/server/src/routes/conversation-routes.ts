import type { ChatAttachment, JsonObject, ReasoningEffort } from '@dsh-cyber/contracts'
import type {
  ConversationOrchestrator,
  DirectConversationInput,
} from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
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
import type { PeerCollaborationService } from '../services/peer-collaboration-service.js'
import type { RuntimeStreamHub } from '../streams/runtime-stream-hub.js'
import type { WorldRuntimeService } from '../world-runtime-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldFileService } from '../services/world-file-service.js'
import type { WorldSettingsService } from '../services/world-settings-service.js'
import { ServiceError } from '../services/service-error.js'

export interface ConversationRoutesDependencies {
  store: SqliteStore
  orchestrator: ConversationOrchestrator
  peerCollaboration: PeerCollaborationService
  runtimeStreamHub: RuntimeStreamHub
  worldRuntime: WorldRuntimeService
  worldAccess: WorldAccessService
  worldFiles: WorldFileService
  worldSettings: WorldSettingsService
}

export function registerConversationRoutes(router: Router, dependencies: ConversationRoutesDependencies): void {
  const {
    store,
    orchestrator,
    peerCollaboration,
    runtimeStreamHub,
    worldRuntime,
    worldAccess,
    worldFiles,
    worldSettings,
  } = dependencies

  router.post(/^\/api\/worlds\/([^/]+)\/chat$/, async ({ request, response, params }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const prompt = requiredString(body, 'prompt')
    const attachments = await validatedChatAttachments(body.attachments, store, world.workspaceId, world.id, worldFiles)
    const attachmentPrompt = attachments.length === 0 ? prompt : attachmentAwarePrompt(prompt, attachments)
    const transformedPrompt = await applyInstalledPromptTransforms(store.listInstalledPackages(world.workspaceId), attachmentPrompt)
    const worldSettingsValue = await worldSettings.get(world.id)
    const requestedReasoning = body.reasoningEffort === undefined
      ? worldSettingsValue.model.reasoningEffort
      : requiredEnum<ReasoningEffort>(body, 'reasoningEffort', ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    const explicitIds = optionalStringArray(body.employeeIds)
    const employeeIds = explicitIds.length > 0 ? explicitIds : mentionedEmployeeIds(prompt, store.listEmployees(world.id))
    if (employeeIds.length === 0) throw new HttpError(422, 'agent_required', '请选择或 @ 至少一个角色')
    const metadata: JsonObject = {
      participantIds: employeeIds,
      ...(attachments.length === 0 ? {} : { attachments: attachments.map(chatAttachmentJson) }),
    }
    const title = optionalString(body.title)
    const sessionId = optionalString(body.sessionId)
    let result
    if (employeeIds.length === 1) {
      const character = store.getEmployee(employeeIds[0]!)
      if (character === undefined || character.worldId !== world.id) {
        throw new HttpError(422, 'character_unavailable', '所选角色不属于当前世界')
      }
      const directInput: DirectConversationInput = {
        workspaceId: world.workspaceId,
        worldId: world.id,
        employeeId: character.id,
        prompt,
        metadata,
        runtimePrompt: await worldSettings.composeRuntimePrompt(world.id, character, transformedPrompt),
        ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
      }
      if (sessionId !== undefined) directInput.sessionId = sessionId
      if (title !== undefined) directInput.title = title
      result = await orchestrator.direct(directInput)
    } else {
      result = await orchestrator.group({
        workspaceId: world.workspaceId,
        worldId: world.id,
        employeeIds,
        prompt,
        metadata,
        runtimePrompt: await worldSettings.composeGroupRuntimePrompt(world.id, transformedPrompt),
        ...(requestedReasoning === 'auto' ? {} : { reasoningEffort: requestedReasoning }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(title === undefined ? {} : { title }),
      })
    }
    worldRuntime.publishCurrent(world.id)
    writeJson(response, 200, result)
  })

  router.post(/^\/api\/worlds\/([^/]+)\/peer-conversations$/, async ({ request, response, params }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const initiatorId = requiredString(body, 'initiatorId')
    const participantIds = optionalStringArray(body.participantIds)
    const purpose = requiredString(body, 'purpose')
    if (purpose.length > 2_000) {
      throw new HttpError(422, 'purpose_too_long', '角色协作目标不能超过 2000 个字符')
    }
    const maxRounds = optionalPositiveInteger(body.maxRounds) ?? 1
    if (maxRounds > 3) {
      throw new HttpError(422, 'invalid_rounds', '角色协作最多进行 3 轮')
    }
    const settings = await worldSettings.get(world.id)
    const requestedReasoning = body.reasoningEffort === undefined
      ? settings.model.reasoningEffort
      : requiredEnum<ReasoningEffort>(body, 'reasoningEffort', ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    const transformedPurpose = await applyInstalledPromptTransforms(
      store.listInstalledPackages(world.workspaceId),
      purpose,
    )
    const peerTitle = optionalString(body.title)
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
    writeJson(response, 200, { items: store.listMessages(session.id, nonNegativeInteger(url.searchParams.get('after'))) })
  })

  router.get(/^\/api\/sessions\/([^/]+)\/participants$/, async ({ request, response, params }) => {
    const session = store.getSession(params[0]!)
    if (session === undefined) throw new HttpError(404, 'session_not_found', 'Session not found')
    await worldAccess.assertUnlocked(session.worldId, request)
    writeJson(response, 200, { items: store.listParticipants(session.id) })
  })
}

async function validatedChatAttachments(value: unknown, store: SqliteStore, workspaceId: string, worldId: string, worldFiles: WorldFileService): Promise<ChatAttachment[]> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) {
    throw new HttpError(422, 'invalid_attachments', 'Attachments must be an array with at most 8 items')
  }
  return Promise.all(value.map(async (item) => {
    const input = record(item)
    if (input === undefined) throw new HttpError(422, 'invalid_attachment', 'Invalid attachment')
    const assetId = requiredString(input, 'assetId')
    const asset = store.getLocalAsset(assetId)
    if (asset !== undefined) {
      if (asset.workspaceId !== workspaceId || asset.kind !== 'attachment') {
        throw new HttpError(422, 'attachment_unavailable', 'Attachment does not belong to this workspace')
      }
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
      if (error instanceof ServiceError && error.code === 'asset_not_found') {
        throw new HttpError(422, 'attachment_unavailable', 'Attachment does not belong to this workspace')
      }
      if (error instanceof ServiceError) {
        throw new HttpError(422, 'invalid_attachment', '附件已损坏或无法读取，请重新上传')
      }
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
