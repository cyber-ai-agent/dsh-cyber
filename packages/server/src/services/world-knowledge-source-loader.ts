import type {
  KnowledgeChunk,
  KnowledgeDocument,
  WorkMessage,
  WorkSession,
} from '@dsh-cyber/contracts'

import type {
  KnowledgeExtractionEvidence,
} from './knowledge-extraction.js'
import type {
  KnowledgeEvidenceSourceType,
} from './world-knowledge-graph-service.js'
import type {
  KnowledgeSourceBatch,
  KnowledgeSourceLoader,
  KnowledgeVisibleSourceItem,
} from './world-knowledge-consolidation-service.js'

/**
 * The source loader is deliberately a small host-side adapter.  It reads the
 * durable source of truth for a batch, checks the world/workspace boundary,
 * and projects only user-visible text into the extractor.  It never reads
 * runtime logs, prompts, tool arguments, or model responses.
 */

export interface KnowledgeConversationSourceStore {
  getSession(sessionId: string): Pick<WorkSession, 'id' | 'workspaceId' | 'worldId'> | undefined
  listMessagesPage(sessionId: string, input: {
    limit?: number
    afterSequence?: number
    beforeSequence?: number
    chatOnly?: boolean
  }): { items: readonly WorkMessage[]; nextAfter?: number; nextBefore?: number }
}

export interface KnowledgeDocumentSourceStore {
  getDocument(worldId: string, documentId: string): KnowledgeDocument | undefined
  listChunks(worldId: string, documentId: string): readonly KnowledgeChunk[]
}

export interface KnowledgeArtifactSourceReader {
  /** The implementation must enforce world ownership before returning bytes. */
  read(input: { workspaceId: string; worldId: string; artifactId: string; artifactVersion?: string }): Promise<{
    workspaceId: string
    worldId: string
    artifactId: string
    version: number
    title?: string
    body: string | Uint8Array
  } | undefined>
}

/** Bridges the trusted artifact host service without coupling the loader to its implementation. */
export interface KnowledgeArtifactPreviewPort {
  preview(worldId: string, artifactId: string, versionNumber?: number): Promise<{
    artifact: { id: string; workspaceId: string; worldId: string; title: string }
    version: { artifactId: string; version: number }
    body: Uint8Array
  }>
}

export function createKnowledgeArtifactSourceReader(previewPort: KnowledgeArtifactPreviewPort): KnowledgeArtifactSourceReader {
  return {
    async read(input) {
      const versionNumber = input.artifactVersion === undefined ? undefined : parseArtifactVersion(input.artifactVersion)
      const preview = await previewPort.preview(input.worldId, input.artifactId, versionNumber)
      if (preview.artifact.workspaceId !== input.workspaceId || preview.artifact.worldId !== input.worldId || preview.artifact.id !== input.artifactId) return undefined
      if (preview.version.artifactId !== input.artifactId) return undefined
      return {
        workspaceId: preview.artifact.workspaceId,
        worldId: preview.artifact.worldId,
        artifactId: preview.artifact.id,
        version: preview.version.version,
        title: preview.artifact.title,
        body: preview.body,
      }
    },
  }
}

export interface KnowledgeManualSourceReader {
  load(input: { workspaceId: string; worldId: string; sourceId: string }): Promise<KnowledgeSourceBatch | undefined>
}

export interface WorldKnowledgeSourceLoaderOptions {
  conversations?: KnowledgeConversationSourceStore
  documents?: KnowledgeDocumentSourceStore
  artifacts?: KnowledgeArtifactSourceReader
  manual?: KnowledgeManualSourceReader
  /** Keep excerpts bounded even when a repository returns a very large field. */
  excerptChars?: number
  /** Keep a single source batch bounded before the consolidation service validates it. */
  maxItems?: number
}

const DEFAULT_EXCERPT_CHARS = 1_200
const DEFAULT_MAX_ITEMS = 40
const MAX_TEXT_CHARS = 16_000

export class WorldKnowledgeSourceLoader implements KnowledgeSourceLoader {
  readonly #conversations: KnowledgeConversationSourceStore | undefined
  readonly #documents: KnowledgeDocumentSourceStore | undefined
  readonly #artifacts: KnowledgeArtifactSourceReader | undefined
  readonly #manual: KnowledgeManualSourceReader | undefined
  readonly #excerptChars: number
  readonly #maxItems: number

  constructor(options: WorldKnowledgeSourceLoaderOptions) {
    this.#conversations = options.conversations
    this.#documents = options.documents
    this.#artifacts = options.artifacts
    this.#manual = options.manual
    this.#excerptChars = boundedPositiveInteger(options.excerptChars, DEFAULT_EXCERPT_CHARS, 4_000)
    this.#maxItems = boundedPositiveInteger(options.maxItems, DEFAULT_MAX_ITEMS, DEFAULT_MAX_ITEMS)
  }

  async load(input: {
    workspaceId: string
    worldId: string
    sourceType: KnowledgeEvidenceSourceType
    sourceId: string
    fromCursor?: number
    toCursor?: number
    artifactVersion?: string
  }): Promise<KnowledgeSourceBatch> {
    if (!nonEmpty(input.workspaceId) || !nonEmpty(input.worldId) || !nonEmpty(input.sourceId)) {
      throw invalid('knowledge_source_scope_invalid', '知识来源边界无效')
    }
    assertCursorRange(input.fromCursor, input.toCursor)
    switch (input.sourceType) {
      case 'conversation':
        return this.#loadConversation(input)
      case 'document':
        return this.#loadDocument(input)
      case 'artifact':
        return this.#loadArtifact(input)
      case 'manual':
        return this.#loadManual(input)
    }
  }

  async #loadConversation(input: LoaderInput): Promise<KnowledgeSourceBatch> {
    if (this.#conversations === undefined) throw invalid('knowledge_conversation_source_unavailable', '会话知识来源暂不可用')
    const session = this.#conversations.getSession(input.sourceId)
    if (session === undefined) throw invalid('knowledge_session_not_found', '会话不存在')
    assertScope(session.workspaceId, session.worldId, input)
    const page = this.#conversations.listMessagesPage(input.sourceId, {
      limit: this.#maxItems,
      ...(input.fromCursor === undefined ? {} : { afterSequence: input.fromCursor }),
      ...(input.toCursor === undefined ? {} : { beforeSequence: input.toCursor + 1 }),
      chatOnly: true,
    })
    const items = page.items
      .filter((message) => message.sessionId === input.sourceId)
      .filter((message) => message.kind === 'user' || message.kind === 'assistant')
      .filter((message) => input.fromCursor === undefined || message.sequence > input.fromCursor)
      .filter((message) => input.toCursor === undefined || message.sequence <= input.toCursor)
      .filter((message) => message.content.trim().length > 0)
      .slice(0, this.#maxItems)
      .map((message) => this.#conversationItem(input, message))
    const lastSequence = items.length === 0 ? input.fromCursor : items[items.length - 1]!.evidence.sequence
    return {
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
      ...(lastSequence === undefined ? {} : { toCursor: lastSequence }),
      items,
    }
  }

  #conversationItem(input: LoaderInput, message: WorkMessage): KnowledgeVisibleSourceItem {
    const text = boundText(message.content, MAX_TEXT_CHARS)
    const evidence: KnowledgeExtractionEvidence = {
      evidenceId: `conversation:${input.sourceId}:${message.id}`,
      sourceType: 'conversation',
      sourceId: input.sourceId,
      excerpt: excerpt(text, this.#excerptChars),
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: input.sourceId,
      messageId: message.id,
      sequence: message.sequence,
    }
    return { kind: message.kind === 'user' ? 'user' : 'assistant', text, evidence }
  }

  async #loadDocument(input: LoaderInput): Promise<KnowledgeSourceBatch> {
    if (this.#documents === undefined) throw invalid('knowledge_document_source_unavailable', '文档知识来源暂不可用')
    const document = this.#documents.getDocument(input.worldId, input.sourceId)
    if (document === undefined) throw invalid('knowledge_document_not_found', '文档不存在')
    assertScope(document.workspaceId, document.worldId, input)
    if (document.status !== 'indexed') throw invalid('knowledge_document_not_indexed', '文档尚未完成索引')
    const chunks = this.#documents.listChunks(input.worldId, input.sourceId)
      .filter((chunk) => chunk.worldId === input.worldId && chunk.documentId === input.sourceId)
      .slice(0, this.#maxItems)
    const items = chunks
      .filter((chunk) => chunk.content.trim().length > 0)
      .map((chunk) => this.#documentItem(input, document, chunk))
    return {
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      items,
    }
  }

  #documentItem(input: LoaderInput, document: KnowledgeDocument, chunk: KnowledgeChunk): KnowledgeVisibleSourceItem {
    const text = boundText(chunk.content, MAX_TEXT_CHARS)
    const evidence: KnowledgeExtractionEvidence = {
      evidenceId: `document:${document.id}:${chunk.id}`,
      sourceType: 'document',
      sourceId: document.id,
      excerpt: excerpt(text, this.#excerptChars),
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      documentId: document.id,
      chunkId: chunk.id,
    }
    return { kind: 'source', text, evidence }
  }

  async #loadArtifact(input: LoaderInput): Promise<KnowledgeSourceBatch> {
    if (this.#artifacts === undefined) throw invalid('knowledge_artifact_source_unavailable', '产物知识来源暂不可用')
    const artifact = await this.#artifacts.read({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      artifactId: input.sourceId,
      ...(input.artifactVersion === undefined ? {} : { artifactVersion: input.artifactVersion }),
    })
    if (artifact === undefined) throw invalid('knowledge_artifact_not_found', '产物不存在')
    assertScope(artifact.workspaceId, artifact.worldId, input)
    if (!Number.isSafeInteger(artifact.version) || artifact.version < 1) throw invalid('knowledge_artifact_version_invalid', '产物版本无效')
    const text = boundText(toText(artifact.body), MAX_TEXT_CHARS)
    const evidence: KnowledgeExtractionEvidence = {
      evidenceId: `artifact:${artifact.artifactId}:v${artifact.version}`,
      sourceType: 'artifact',
      sourceId: artifact.artifactId,
      excerpt: excerpt(text, this.#excerptChars),
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      artifactId: artifact.artifactId,
      artifactVersion: String(artifact.version),
    }
    return {
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      items: text.length === 0 ? [] : [{ kind: 'source', text, evidence }],
    }
  }

  async #loadManual(input: LoaderInput): Promise<KnowledgeSourceBatch> {
    if (this.#manual === undefined) throw invalid('knowledge_manual_source_unavailable', '手动知识来源暂不可用')
    const batch = await this.#manual.load({ workspaceId: input.workspaceId, worldId: input.worldId, sourceId: input.sourceId })
    if (batch === undefined) throw invalid('knowledge_manual_source_not_found', '手动知识来源不存在')
    if (batch.workspaceId !== input.workspaceId || batch.worldId !== input.worldId || batch.sourceType !== 'manual' || batch.sourceId !== input.sourceId) {
      throw invalid('knowledge_source_scope_mismatch', '手动知识来源不属于当前世界')
    }
    return {
      ...batch,
      items: batch.items.slice(0, this.#maxItems).map((item) => {
        if (item.evidence.sourceType !== 'manual' || item.evidence.createdBy !== 'owner') {
          throw invalid('knowledge_manual_author_required', '手动知识必须来自当前世界所有者确认的内容')
        }
        return {
          ...item,
          text: boundText(item.text, MAX_TEXT_CHARS),
          evidence: { ...item.evidence, excerpt: excerpt(item.evidence.excerpt, this.#excerptChars) },
        }
      }),
    }
  }
}

type LoaderInput = {
  workspaceId: string
  worldId: string
  sourceType: KnowledgeEvidenceSourceType
  sourceId: string
  fromCursor?: number
  toCursor?: number
  artifactVersion?: string
}

function assertScope(workspaceId: string, worldId: string, input: LoaderInput): void {
  if (workspaceId !== input.workspaceId || worldId !== input.worldId) throw invalid('knowledge_source_scope_mismatch', '知识来源不属于当前世界')
}

function assertCursorRange(fromCursor: number | undefined, toCursor: number | undefined): void {
  for (const cursor of [fromCursor, toCursor]) {
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw invalid('knowledge_cursor_invalid', '知识游标无效')
  }
  if (fromCursor !== undefined && toCursor !== undefined && toCursor < fromCursor) throw invalid('knowledge_cursor_invalid', '知识游标范围无效')
}

function nonEmpty(value: string): boolean { return typeof value === 'string' && value.trim().length > 0 }

function boundText(value: string, max: number): string {
  const normalized = value.normalize('NFC').trim()
  return Array.from(normalized).slice(0, max).join('')
}

function excerpt(value: string, max: number): string { return Array.from(value).slice(0, max).join('') }

function toText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value)
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(value)))
}

function parseArtifactVersion(value: string): number {
  if (!/^\d+$/.test(value)) throw invalid('knowledge_artifact_version_invalid', '产物版本无效')
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 1) throw invalid('knowledge_artifact_version_invalid', '产物版本无效')
  return version
}

function invalid(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}
