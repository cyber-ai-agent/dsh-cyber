import { randomUUID } from 'node:crypto'

import type { AgentRuntimePort, AgentTurnRequest, AgentTurnResult, JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { ImageGenerationService } from './image-generation-service.js'
import { isImageGenerationModel } from './image-generation-service.js'
import type { ModelCredentialService } from './model-credential-service.js'
import type { ModelInteractionService } from './model-interaction-service.js'
import { ServiceError } from './service-error.js'
import type { WorldArtifactService } from './world-artifact-service.js'
import type { WorldFileService } from './world-file-service.js'

export interface ImageTurnRuntimeDependencies {
  inner: AgentRuntimePort
  store: SqliteStore
  credentials: ModelCredentialService
  images: ImageGenerationService
  worldFiles: WorldFileService
  worldArtifacts: WorldArtifactService
  interactions: ModelInteractionService
}

/**
 * A chat turn whose resolved model is an image generator is not a conversation
 * with that model - it is a request for a picture. This port answers exactly
 * that: the user's message becomes the prompt, the generated image becomes an
 * attachment on the assistant message AND a durable Artifact, and the ordinary
 * runtime event sequence (turn.started / assistant.message / turn.completed)
 * keeps every downstream projection - trace, SSE, completion jobs - unchanged.
 *
 * The chat pipeline normally sends system prompt + tools + history; image
 * models reject that shape entirely (the usage log's context-window and
 * invalid-request failures). Routing before the inner runtime is the one place
 * both facts meet cheaply.
 */
export function createImageAwareRuntime(deps: ImageTurnRuntimeDependencies): AgentRuntimePort {
  const runTurn = async (request: AgentTurnRequest): Promise<AgentTurnResult> => {
    const profileId = request.modelProfileId
    const profile = profileId === undefined ? undefined : deps.store.getModelProfile(profileId)
    if (profile === undefined || !isImageGenerationModel(profile)) return deps.inner.runTurn(request)

    const employee = request.agent
    const startedAt = Date.now()
    const provider = profileDisplayName(profile)
    const emit = (kind: 'turn.started' | 'assistant.message' | 'turn.completed' | 'turn.failed', extra?: { content?: string; metadata?: JsonObject }): void => {
      request.onEvent?.({ kind, source: 'image-generation', sourceSessionId: request.conversationId, metadata: {}, ...extra })
    }
    emit('turn.started', { metadata: { modelProfileId: profile.id } })
    try {
      const key = resolveKey(deps.credentials, profile)
      const image = await deps.images.generate({
        baseUrl: profile.baseUrl,
        ...(key === undefined ? {} : { apiKey: key }),
        model: profile.modelId,
        prompt: request.prompt,
        ...(typeof profile.settings.imageSize === 'string' ? { size: profile.settings.imageSize } : {}),
      })
      const fileName = `生成图片-${shortTime(new Date())}`
      const attachment = await deps.worldFiles.saveGeneratedImage(employee.worldId, {
        bytes: image.bytes,
        mimeType: image.mimeType,
        name: `${fileName}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'}`,
      })
      const publication = await deps.worldArtifacts.publishGeneratedImage({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        bytes: image.bytes,
        mimeType: image.mimeType,
        title: fileName,
        createdById: employee.id,
        sessionId: request.conversationId,
        ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
        ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
        ...(request.agentRunId === undefined ? {} : { idempotencyKey: `generated-image:${request.agentRunId}` }),
      })
      const caption = '图片已经生成，点击可以放大查看；它也已存入本世界的产物。'
      const metadata: JsonObject = {
        attachments: [{
          assetId: attachment.assetId,
          name: attachment.name,
          mimeType: attachment.mimeType,
          byteLength: attachment.byteLength,
          url: attachment.url,
        }],
        artifactRefs: [{ artifactId: publication.artifact.id, title: publication.artifact.title, kind: 'image' }],
        imageModel: profile.modelId,
        generatedImage: true,
      }
      emit('assistant.message', { content: caption, metadata })
      emit('turn.completed')
      deps.interactions.recordTurn({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        sessionId: request.conversationId,
        employeeId: employee.id,
        ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
        ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
        modelId: profile.modelId,
        provider,
        status: 'success',
        prompt: request.prompt,
        responseCharCount: caption.length,
        toolCallCount: 0,
        durationMs: Date.now() - startedAt,
      })
      return {
        agentSessionId: `image:${request.agentRunId ?? randomUUID()}`,
        finalResponse: caption,
        eventCount: 3,
      }
    } catch (cause) {
      // Surface the failure through the same turn.failed channel the chat
      // pipeline already classifies (rate limit, timeout, auth...), so the
      // usage log, trace and UI all learn about an image attempt exactly like
      // any other model call - the error message keeps the 'HTTP 429' style
      // markers classifyRuntimeFailure looks for.
      const message = cause instanceof Error ? cause.message : '图片生成失败'
      emit('turn.failed', { metadata: { error: message, ...(cause instanceof ServiceError ? { errorCode: cause.code } : {}) } })
      deps.interactions.recordTurn({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        sessionId: request.conversationId,
        employeeId: employee.id,
        ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
        ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
        modelId: profile.modelId,
        provider,
        status: 'failed',
        ...(cause instanceof ServiceError ? { errorCode: cause.code } : {}),
        ...(cause instanceof ServiceError && cause.httpStatus !== undefined ? { httpStatus: cause.httpStatus } : {}),
        errorMessage: message.slice(0, 400),
        prompt: request.prompt,
        durationMs: Date.now() - startedAt,
      })
      return {
        agentSessionId: `image:${request.agentRunId ?? randomUUID()}`,
        finalResponse: '',
        eventCount: 2,
      }
    }
  }

  return {
    runTurn,
    ...(deps.inner.decideApproval === undefined ? {} : { decideApproval: (agentRunId: string, approvalRequestId: string, decision: 'approved' | 'rejected') => deps.inner.decideApproval!(agentRunId, approvalRequestId, decision) }),
    ...(deps.inner.abortRun === undefined ? {} : { abortRun: (agentRunId: string) => deps.inner.abortRun!(agentRunId) }),
    ...(deps.inner.closeAgent === undefined ? {} : { closeAgent: (agentId: string) => deps.inner.closeAgent!(agentId) }),
    close: () => deps.inner.close(),
  }
}

function resolveKey(credentials: ModelCredentialService, profile: { id: string; providerId?: string; credentialEnvName?: string }): string | undefined {
  const direct = credentials.resolve(profile.id)
  if (direct !== undefined) return direct
  // A profile imported through the hub shares its provider connection's key;
  // the vault is keyed by either id, and the env reference is the fallback.
  if (profile.providerId !== undefined) {
    const viaProvider = credentials.resolve(profile.providerId)
    if (viaProvider !== undefined) return viaProvider
  }
  return profile.credentialEnvName === undefined ? undefined : process.env[profile.credentialEnvName]
}

function profileDisplayName(profile: { displayName: string; modelId: string }): string {
  return profile.displayName || profile.modelId
}

function shortTime(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}-${randomUUID().slice(0, 4)}`
}
