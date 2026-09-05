import type { JsonObject } from '@dsh-cyber/contracts'
import {
  WorldKnowledgeGraphRepository,
  type SqliteStore,
  type WorldKnowledgeRepository,
} from '@dsh-cyber/persistence'

import type { KnowledgeExtractionPort } from './knowledge-extraction.js'
import type { ModelCredentialService } from './model-credential-service.js'
import type { ModelInteractionService } from './model-interaction-service.js'
import { ModelProfileKnowledgeExtractionPort } from './model-profile-knowledge-extraction-port.js'
import type { RuntimeContextContributor } from './world-runtime-context-composer.js'
import type { WorldArtifactService } from './world-artifact-service.js'
import { WorldKnowledgeConsolidationScheduler } from './world-knowledge-consolidation-scheduler.js'
import { WorldKnowledgeConsolidationService } from './world-knowledge-consolidation-service.js'
import { WorldKnowledgeEvidenceInvalidationService } from './world-knowledge-evidence-invalidation-service.js'
import {
  createKnowledgeGraphAdminPort,
  createKnowledgeGraphRepositoryPort,
  WorldKnowledgeGraphRetrievalService,
  WorldKnowledgeGraphService,
} from './world-knowledge-graph-service.js'
import { createKnowledgeArtifactSourceReader, WorldKnowledgeSourceLoader } from './world-knowledge-source-loader.js'

export interface WorldKnowledgeGraphRuntimeOptions {
  store: SqliteStore
  libraryRepository: WorldKnowledgeRepository
  artifacts: WorldArtifactService
  credentials: ModelCredentialService
  interactions: ModelInteractionService
  extractionPort?: KnowledgeExtractionPort
  publish(worldId: string, payload: JsonObject): void
}

/** Composition boundary for the durable knowledge graph and its background worker. */
export function createWorldKnowledgeGraphRuntime(options: WorldKnowledgeGraphRuntimeOptions) {
  const repository = new WorldKnowledgeGraphRepository(options.store.database)
  const listGraphWorlds = () => options.store.listWorkspaces().flatMap((workspace) =>
    options.store.listWorlds(workspace.id).map((world) => ({ workspaceId: workspace.id, worldId: world.id })))
  const graph = new WorldKnowledgeGraphService({ repository: createKnowledgeGraphRepositoryPort(repository) })
  const admin = createKnowledgeGraphAdminPort(repository)
  const retrieval = new WorldKnowledgeGraphRetrievalService({ graph })
  const sources = new WorldKnowledgeSourceLoader({
    conversations: options.store,
    documents: options.libraryRepository,
    artifacts: createKnowledgeArtifactSourceReader({
      preview: (worldId, artifactId, versionNumber) => options.artifacts.preview(worldId, artifactId, versionNumber),
    }),
  })
  const consolidation = new WorldKnowledgeConsolidationService({
    repository,
    extractor: options.extractionPort ?? new ModelProfileKnowledgeExtractionPort({ store: options.store, credentials: options.credentials }),
    sources,
    onChanged: (worldId, payload) => options.publish(worldId, payload as JsonObject),
    onModelInteraction: (interaction) => {
      const profile = interaction.modelProfileId === undefined ? undefined : options.store.getModelProfile(interaction.modelProfileId)
      options.interactions.recordKnowledge({
        workspaceId: interaction.workspaceId,
        worldId: interaction.worldId,
        modelId: interaction.model ?? profile?.modelId ?? 'world-default',
        provider: profile?.displayName ?? '世界知识模型',
        status: interaction.errorCode === undefined ? 'success' : 'failed',
        ...(interaction.errorCode === undefined ? {} : { errorCode: interaction.errorCode }),
        promptCharCount: interaction.inputChars,
        responseCharCount: interaction.outputChars,
        durationMs: interaction.durationMs,
        ...(interaction.inputTokens === undefined ? {} : { tokensPrompt: interaction.inputTokens }),
        ...(interaction.outputTokens === undefined ? {} : { tokensCompletion: interaction.outputTokens }),
      })
    },
  })
  const scheduler = new WorldKnowledgeConsolidationScheduler({
    repository: {
      // Consolidation is background world work; an archived world stays
      // dormant and its knowledge is left exactly as the owner archived it.
      listWorlds: () => listGraphWorlds(),
      listSessions: (worldId) => options.store.listSessions(worldId),
      getKnowledgeConsolidationSettings: (worldId) => repository.getKnowledgeConsolidationSettings(worldId),
      getKnowledgeConsolidationCursor: (input) => repository.getKnowledgeConsolidationCursor(input),
      getConsolidationSourceJob: (worldId, sourceType, sourceId) => repository.getConsolidationSourceJob(worldId, sourceType, sourceId),
      getKnowledgeSourceProgress: (input) => repository.getKnowledgeSourceProgress(input),
      listSources: (worldId) => {
        const documents = options.libraryRepository.listDocuments(worldId, { status: 'indexed' })
        const importedArtifacts = new Set(documents.map((document) => document.artifactId).filter(Boolean))
        return [
          ...documents.map((document) => ({ sourceType: 'document' as const, sourceId: document.id, updatedAt: document.updatedAt })),
          ...options.artifacts.list(worldId, { status: 'active' })
            .filter((artifact) => {
              if (importedArtifacts.has(artifact.id) || artifact.kind === 'project') return false
              const version = options.artifacts.get(worldId, artifact.id).versions.find((version) => version.version === artifact.currentVersion)
              const mime = version?.mimeType?.split(';')[0]?.trim().toLowerCase() ?? ''
              // Binary artifacts require an explicit library import/parser;
              // decoding PDF/Office/image bytes as UTF-8 is not extraction.
              return mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mime)
            })
            .map((artifact) => ({ sourceType: 'artifact' as const, sourceId: artifact.id, updatedAt: artifact.updatedAt })),
        ]
      },
    },
    messages: options.store,
    service: consolidation,
    onError: (error) => console.warn('[dsh-cyber] 自动知识整理扫描失败，已等待下一次扫描：', error instanceof Error ? error.message : String(error)),
  })
  // Superseding a source version records that its content is gone; deciding
  // what that means for the claims extracted from it is this pass, and it runs
  // on its own timer so it never competes with extraction cadence.
  const invalidation = new WorldKnowledgeEvidenceInvalidationService({
    repository: {
      listWorlds: listGraphWorlds,
      retireRemovedKnowledgeSources: (worldId, limit) => repository.retireRemovedKnowledgeSources(worldId, limit),
      reinstateCurrentKnowledgeSourceVersions: (worldId) => repository.reinstateCurrentKnowledgeSourceVersions(worldId),
      listPendingKnowledgeSourceInvalidations: (worldId, limit) => repository.listPendingKnowledgeSourceInvalidations(worldId, limit),
      invalidateKnowledgeSourceVersion: (input) => repository.invalidateKnowledgeSourceVersion(input),
    },
    onChanged: (worldId, payload) => options.publish(worldId, payload as JsonObject),
    onError: (error) => console.warn('[dsh-cyber] 知识证据失效检查失败，已等待下一轮：', error instanceof Error ? error.message : String(error)),
  })
  const contributor: RuntimeContextContributor = {
    id: 'world-knowledge-graph',
    async contribute(input) {
      if (!repository.getWorldKnowledgeSettings(input.worldId).retrievalEnabled) return undefined
      const context = await retrieval.retrieve({ worldId: input.worldId, query: input.prompt, limit: 6, budgetChars: 6_000 })
      return context === undefined ? undefined : {
        id: 'world-knowledge-graph',
        text: context.text,
        trust: 'internal-knowledge',
        order: 70,
      }
    },
  }

  return {
    repository,
    graph,
    admin,
    retrieval,
    consolidation,
    scheduler,
    invalidation,
    contributor,
    async start() {
      await consolidation.recover()
      consolidation.start()
      scheduler.start()
      invalidation.start()
    },
    stop() {
      scheduler.stop()
      consolidation.stop()
      invalidation.stop()
    },
  }
}
