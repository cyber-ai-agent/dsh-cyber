import { randomUUID } from 'node:crypto'

import {
  parseKnowledgeExtraction,
  type KnowledgeExtraction,
  type KnowledgeExtractionEvidence,
  type KnowledgeExtractionPort,
  type KnowledgeExtractionPortResult,
  type KnowledgeExtractionRequest,
  type KnowledgeModelInteraction,
} from './knowledge-extraction.js'
import type {
  KnowledgeEvidenceSourceType,
  KnowledgeGraphRepositoryPort,
} from './world-knowledge-graph-service.js'

export const KNOWLEDGE_CONSOLIDATION_THRESHOLDS = {
  visibleMessages: 6,
  characters: 4_000,
  idleMs: 60_000,
  maxMessages: 40,
  maxCharacters: 16_000,
} as const

export type KnowledgeConsolidationJobStatus = 'queued' | 'running' | 'completed' | 'failed'
export type KnowledgeAutomaticSourceType = Exclude<KnowledgeEvidenceSourceType, 'manual'>

export interface KnowledgeConsolidationJob {
  id: string
  workspaceId: string
  worldId: string
  sourceType: KnowledgeAutomaticSourceType
  sourceId: string
  fromCursor?: number
  toCursor?: number
  status: KnowledgeConsolidationJobStatus
  attempt: number
  errorCode?: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeConsolidationCursor {
  workspaceId: string
  worldId: string
  sourceType: KnowledgeEvidenceSourceType
  sourceId: string
  processedThroughSequence: number
  updatedAt: string
}

export interface KnowledgeConsolidationSettings {
  worldId: string
  retrievalEnabled: boolean
  autoConsolidationMode: 'off' | 'balanced'
  extractionModelProfileId?: string
  updatedAt: string
}

export interface KnowledgeVisibleSourceItem {
  /** source is used for document, artifact and owner-confirmed manual text. */
  kind: 'user' | 'assistant' | 'source'
  text: string
  evidence: KnowledgeExtractionEvidence
}

export interface KnowledgeSourceBatch {
  workspaceId: string
  worldId: string
  sourceType: KnowledgeEvidenceSourceType
  sourceId: string
  fromCursor?: number
  toCursor?: number
  items: readonly KnowledgeVisibleSourceItem[]
}

export interface KnowledgeSourceLoader {
  load(input: { workspaceId: string; worldId: string; sourceType: KnowledgeEvidenceSourceType; sourceId: string; fromCursor?: number; toCursor?: number }): Promise<KnowledgeSourceBatch>
}

export interface KnowledgeConsolidationRepository extends KnowledgeGraphRepositoryPort {
  createConsolidationJob(input: Omit<KnowledgeConsolidationJob, 'status' | 'attempt' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: string }): KnowledgeConsolidationJob | Promise<KnowledgeConsolidationJob>
  claimConsolidationJob(jobId: string): KnowledgeConsolidationJob | undefined | Promise<KnowledgeConsolidationJob | undefined>
  completeConsolidationJob(input: { jobId: string; toCursor?: number; completedAt?: string }): KnowledgeConsolidationJob | Promise<KnowledgeConsolidationJob>
  failConsolidationJob(input: { jobId: string; errorCode: string }): KnowledgeConsolidationJob | Promise<KnowledgeConsolidationJob>
  listConsolidationJobs?(input: { status?: KnowledgeConsolidationJobStatus; worldId?: string; limit: number }): readonly KnowledgeConsolidationJob[] | Promise<readonly KnowledgeConsolidationJob[]>
  getConsolidationJob?(worldId: string, jobId: string): KnowledgeConsolidationJob | undefined | Promise<KnowledgeConsolidationJob | undefined>
  requeueConsolidationJob?(worldId: string, jobId: string): KnowledgeConsolidationJob | Promise<KnowledgeConsolidationJob>
  applyKnowledgeExtraction(input: {
    jobId: string
    workspaceId: string
    worldId: string
    extraction: KnowledgeExtraction
    evidence: readonly KnowledgeExtractionEvidence[]
    sourceType: KnowledgeEvidenceSourceType
    sourceId: string
    now: string
  }): Promise<void> | void
  /** Manual runs do not use the persisted automatic-job source contract. */
  applyManualKnowledgeExtraction?(input: {
    workspaceId: string
    worldId: string
    extraction: KnowledgeExtraction
    evidence: readonly KnowledgeExtractionEvidence[]
    sourceId: string
    now: string
  }): Promise<void> | void
  recoverRunningConsolidationJobs?(): number | Promise<number>
  getKnowledgeConsolidationSettings?(worldId: string): KnowledgeConsolidationSettings | undefined | Promise<KnowledgeConsolidationSettings | undefined>
  getKnowledgeConsolidationCursor?(input: { worldId: string; sourceType: KnowledgeEvidenceSourceType; sourceId: string }): KnowledgeConsolidationCursor | undefined | Promise<KnowledgeConsolidationCursor | undefined>
}

export interface KnowledgeConsolidationServiceOptions {
  repository: KnowledgeConsolidationRepository
  extractor: KnowledgeExtractionPort
  sources: KnowledgeSourceLoader
  clock?: () => string
  idFactory?: () => string
  onChanged?: (worldId: string, payload: Record<string, unknown>) => void
  onModelInteraction?: (interaction: KnowledgeModelInteraction) => void
}

export class WorldKnowledgeConsolidationService {
  readonly #repository: KnowledgeConsolidationRepository
  readonly #extractor: KnowledgeExtractionPort
  readonly #sources: KnowledgeSourceLoader
  readonly #clock: () => string
  readonly #idFactory: () => string
  readonly #onChanged?: KnowledgeConsolidationServiceOptions['onChanged']
  readonly #onModelInteraction?: KnowledgeConsolidationServiceOptions['onModelInteraction']
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false

  constructor(options: KnowledgeConsolidationServiceOptions) {
    this.#repository = options.repository
    this.#extractor = options.extractor
    this.#sources = options.sources
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
    this.#onChanged = options.onChanged
    this.#onModelInteraction = options.onModelInteraction
  }

  async enqueue(input: {
    workspaceId: string
    worldId: string
    sourceType: KnowledgeAutomaticSourceType
    sourceId: string
    fromCursor?: number
    toCursor?: number
  }): Promise<KnowledgeConsolidationJob> {
    const now = this.#clock()
    if (input.fromCursor !== undefined && (!Number.isSafeInteger(input.fromCursor) || input.fromCursor < 0)) throw invalid('knowledge_cursor_invalid', '知识游标无效')
    if (input.toCursor !== undefined && (!Number.isSafeInteger(input.toCursor) || input.toCursor < 0)) throw invalid('knowledge_cursor_invalid', '知识游标无效')
    if (input.fromCursor !== undefined && input.toCursor !== undefined && input.toCursor < input.fromCursor) throw invalid('knowledge_cursor_invalid', '知识游标范围无效')
    const job = await this.#repository.createConsolidationJob({ ...input, id: this.#idFactory(), createdAt: now })
    this.#onChanged?.(job.worldId, { type: 'knowledge.consolidation.changed', jobId: job.id, status: job.status })
    return job
  }

  enqueueConversation(input: { workspaceId: string; worldId: string; sessionId: string; fromCursor?: number; toCursor?: number }): Promise<KnowledgeConsolidationJob> {
    return this.enqueue({ ...input, sourceType: 'conversation', sourceId: input.sessionId })
  }
  enqueueDocument(input: { workspaceId: string; worldId: string; documentId: string }): Promise<KnowledgeConsolidationJob> {
    return this.enqueue({ ...input, sourceType: 'document', sourceId: input.documentId })
  }
  enqueueArtifact(input: { workspaceId: string; worldId: string; artifactId: string; artifactVersion?: string }): Promise<KnowledgeConsolidationJob> {
    return this.enqueue({ ...input, sourceType: 'artifact', sourceId: input.artifactId })
  }

  async listJobs(worldId: string, status: KnowledgeConsolidationJobStatus | undefined, limit: number): Promise<readonly KnowledgeConsolidationJob[]> {
    if (this.#repository.listConsolidationJobs === undefined) return []
    return await this.#repository.listConsolidationJobs({ worldId, ...(status === undefined ? {} : { status }), limit })
  }

  async getJob(worldId: string, jobId: string): Promise<KnowledgeConsolidationJob | undefined> {
    if (this.#repository.getConsolidationJob === undefined) return undefined
    return await this.#repository.getConsolidationJob(worldId, jobId)
  }

  async retryJob(worldId: string, jobId: string): Promise<KnowledgeConsolidationJob> {
    if (this.#repository.getConsolidationJob === undefined || this.#repository.requeueConsolidationJob === undefined) {
      throw invalid('knowledge_consolidation_retry_unavailable', '知识整理重试暂不可用')
    }
    const current = await this.#repository.getConsolidationJob(worldId, jobId)
    if (current === undefined) throw invalid('knowledge_consolidation_job_not_found', '知识整理任务不存在')
    if (current.status !== 'failed') throw invalid('knowledge_consolidation_job_not_failed', '只有失败的知识整理任务可以重试')
    const queued = await this.#repository.requeueConsolidationJob(worldId, jobId)
    this.#onChanged?.(worldId, { type: 'knowledge.consolidation.changed', jobId, status: queued.status })
    return queued
  }
  /**
   * Manual consolidation is an immediate, owner-triggered operation.  It is
   * deliberately not queued as an automatic job because the durable job
   * contract is limited to conversation/document/artifact sources.
   */
  async consolidateManual(input: { workspaceId: string; worldId: string; sourceId: string }): Promise<{ worldId: string; sourceId: string; changed: boolean }> {
    if (this.#repository.applyManualKnowledgeExtraction === undefined) {
      throw invalid('knowledge_manual_persistence_unavailable', '手动知识整理暂不可用')
    }
    const startedAt = Date.now()
    let request: KnowledgeExtractionRequest | undefined
    try {
      const batch = await this.#sources.load({ ...input, sourceType: 'manual' })
      validateBatch(batch, {
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sourceType: 'manual',
        sourceId: input.sourceId,
      })
      const visibleText = batch.items.slice(0, KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxMessages)
        .map((item) => item.kind + ': ' + item.text.trim())
        .join('\n')
        .slice(0, KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxCharacters)
      if (!visibleText) return { worldId: input.worldId, sourceId: input.sourceId, changed: false }
      const evidence = batch.items.slice(0, KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxMessages).map((item) => item.evidence)
      const settings = this.#repository.getKnowledgeConsolidationSettings === undefined
        ? undefined
        : await this.#repository.getKnowledgeConsolidationSettings(input.worldId)
      const modelProfileId = settings?.extractionModelProfileId
      request = {
        ...input,
        sourceType: 'manual',
        inputChars: visibleText.length,
        visibleText,
        evidence,
        ...(modelProfileId === undefined ? {} : { modelProfileId }),
      }
      const rawResult = await this.#extractParse(request, { sourceType: 'manual', sourceId: input.sourceId, evidence })
      const { result, extraction } = rawResult
      await this.#repository.applyManualKnowledgeExtraction({ workspaceId: input.workspaceId, worldId: input.worldId, extraction, evidence, sourceId: input.sourceId, now: this.#clock() })
      this.#onModelInteraction?.({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        ...(request.modelProfileId === undefined ? {} : { modelProfileId: request.modelProfileId }),
        ...(result.usage?.model === undefined ? {} : { model: result.usage.model }),
        durationMs: Date.now() - startedAt,
        inputChars: request.inputChars,
        outputChars: outputChars(result.payload),
        ...(result.usage?.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage?.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
      })
      this.#onChanged?.(input.worldId, { type: 'knowledge.graph.changed', sourceType: 'manual', sourceId: input.sourceId })
      return { worldId: input.worldId, sourceId: input.sourceId, changed: true }
    } catch (error) {
      this.#onModelInteraction?.({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        ...(request?.modelProfileId === undefined ? {} : { modelProfileId: request.modelProfileId }),
        durationMs: Date.now() - startedAt,
        inputChars: request?.inputChars ?? 0,
        outputChars: 0,
        errorCode: safeErrorCode(error),
      })
      throw error
    }
  }

  /**
   * A scheduler calls this method from the background. The HTTP request only
   * creates a queued row and never waits for model extraction.
   */
  start(intervalMs = 1_000): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => { void this.runNext() }, Math.max(250, intervalMs))
    const timer = this.#timer as { unref?: () => void }
    timer.unref?.()
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async recover(): Promise<number> {
    return this.#repository.recoverRunningConsolidationJobs === undefined
      ? 0
      : await this.#repository.recoverRunningConsolidationJobs()
  }

  async runNext(): Promise<KnowledgeConsolidationJob | undefined> {
    if (this.#running) return undefined
    this.#running = true
    try {
      const jobs = this.#repository.listConsolidationJobs === undefined
        ? []
        : await this.#repository.listConsolidationJobs({ status: 'queued', limit: 1 })
      const first = jobs[0]
      if (first === undefined) return undefined
      return await this.runJob(first.id)
    } finally {
      this.#running = false
    }
  }

  async runJob(jobId: string): Promise<KnowledgeConsolidationJob | undefined> {
    const claimed = await this.#repository.claimConsolidationJob(jobId)
    if (claimed === undefined) return undefined
    const startedAt = Date.now()
    let request: KnowledgeExtractionRequest | undefined
    try {
      const batch = await this.#sources.load({
        workspaceId: claimed.workspaceId,
        worldId: claimed.worldId,
        sourceType: claimed.sourceType,
        sourceId: claimed.sourceId,
        ...(claimed.fromCursor === undefined ? {} : { fromCursor: claimed.fromCursor }),
        ...(claimed.toCursor === undefined ? {} : { toCursor: claimed.toCursor }),
      })
      validateBatch(batch, claimed)
      const visibleText = batch.items.slice(0, KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxMessages)
        .map((item) => item.kind + '：' + item.text.trim())
        .join('\n')
        .slice(0, KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxCharacters)
      if (!visibleText) {
        return await this.#repository.completeConsolidationJob({ jobId: claimed.id, ...(batch.toCursor === undefined ? {} : { toCursor: batch.toCursor }), completedAt: this.#clock() })
      }
      const evidence = batch.items.slice(0, KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxMessages).map((item) => item.evidence)
      const settings = this.#repository.getKnowledgeConsolidationSettings === undefined
        ? undefined
        : await this.#repository.getKnowledgeConsolidationSettings(claimed.worldId)
      const modelProfileId = settings?.extractionModelProfileId
      request = {
        workspaceId: claimed.workspaceId,
        worldId: claimed.worldId,
        sourceType: claimed.sourceType,
        sourceId: claimed.sourceId,
        inputChars: visibleText.length,
        visibleText,
        evidence,
        ...(modelProfileId === undefined ? {} : { modelProfileId }),
      }
      const rawResult = await this.#extractParse(request, { sourceType: claimed.sourceType, sourceId: claimed.sourceId, evidence })
      const { result, extraction } = rawResult
      await this.#repository.applyKnowledgeExtraction({
        jobId: claimed.id,
        workspaceId: claimed.workspaceId,
        worldId: claimed.worldId,
        extraction,
        evidence,
        sourceType: claimed.sourceType,
        sourceId: claimed.sourceId,
        now: this.#clock(),
      })
      this.#onModelInteraction?.({
        workspaceId: claimed.workspaceId,
        worldId: claimed.worldId,
        ...(request.modelProfileId === undefined ? {} : { modelProfileId: request.modelProfileId }),
        ...(result.usage?.model === undefined ? {} : { model: result.usage.model }),
        durationMs: Date.now() - startedAt,
        inputChars: request.inputChars,
        outputChars: outputChars(result.payload),
        ...(result.usage?.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage?.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
      })
      const completed = await this.#repository.completeConsolidationJob({ jobId: claimed.id, ...(batch.toCursor === undefined ? {} : { toCursor: batch.toCursor }), completedAt: this.#clock() })
      this.#onChanged?.(claimed.worldId, { type: 'knowledge.graph.changed', jobId: claimed.id })
      this.#onChanged?.(claimed.worldId, { type: 'knowledge.consolidation.changed', jobId: claimed.id, status: completed.status })
      return completed
    } catch (error) {
      const code = safeErrorCode(error)
      this.#onModelInteraction?.({
        workspaceId: claimed.workspaceId,
        worldId: claimed.worldId,
        ...(request?.modelProfileId === undefined ? {} : { modelProfileId: request.modelProfileId }),
        durationMs: Date.now() - startedAt,
        inputChars: request?.inputChars ?? 0,
        outputChars: 0,
        errorCode: code,
      })
      const failed = await this.#repository.failConsolidationJob({ jobId: claimed.id, errorCode: code })
      this.#onChanged?.(claimed.worldId, { type: 'knowledge.consolidation.changed', jobId: claimed.id, status: failed.status, errorCode: code })
      return failed
    }
  }

  /**
   * One model answer, then exactly one corrective retry when the answer came
   * back but was unusable: unparseable content, invented shapes, or a gateway
   * that returned HTTP 200 with empty text. Transport failures (timeout,
   * unreachable) are never retried here so a slow or dead gateway cannot
   * double the latency of every task.
   */
  async #extractParse(
    request: KnowledgeExtractionRequest,
    context: { sourceType: KnowledgeEvidenceSourceType; sourceId: string; evidence: readonly KnowledgeExtractionEvidence[] },
  ): Promise<{ result: KnowledgeExtractionPortResult; extraction: KnowledgeExtraction }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = normalizePortResult(await this.#extractor.extract(attempt === 1 ? request : { ...request, attemptHint: true }))
        return { result, extraction: parseKnowledgeExtraction(result.payload, context) }
      } catch (error) {
        if (attempt >= 2 || !isRetryableExtractionFailure(error)) throw error
      }
    }
  }
}

function isRetryableExtractionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return false
  // Parse-level refusals and the empty-200 answer some gateways return;
  // never the timeout/unreachable class.
  return error.code.startsWith('extraction_') || error.code === 'knowledge_model_response_invalid'
}

export function shouldConsolidate(input: { visibleMessages: number; characters: number; idleMs: number; mode: 'off' | 'balanced' }): boolean {
  if (input.mode === 'off') return false
  return input.visibleMessages >= KNOWLEDGE_CONSOLIDATION_THRESHOLDS.visibleMessages ||
    input.characters >= KNOWLEDGE_CONSOLIDATION_THRESHOLDS.characters ||
    input.idleMs >= KNOWLEDGE_CONSOLIDATION_THRESHOLDS.idleMs
}

function validateBatch(batch: KnowledgeSourceBatch, job: Pick<KnowledgeConsolidationJob, 'workspaceId' | 'worldId' | 'sourceId'> & { sourceType: KnowledgeEvidenceSourceType }): void {
  if (batch.workspaceId !== job.workspaceId || batch.worldId !== job.worldId || batch.sourceType !== job.sourceType || batch.sourceId !== job.sourceId) throw invalid('knowledge_source_scope_mismatch', '知识来源不属于当前世界')
  if (batch.items.length > KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxMessages) throw invalid('knowledge_batch_too_large', '知识批次消息数量超过限制')
  const seenEvidence = new Set<string>()
  for (const item of batch.items) {
    if (item.kind !== 'user' && item.kind !== 'assistant' && item.kind !== 'source') throw invalid('knowledge_hidden_content_rejected', '隐藏推理或工具内容不能进入知识图谱')
    if (!item.text.trim() || item.text.length > KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxCharacters) throw invalid('knowledge_batch_content_invalid', '知识批次内容无效')
    const evidence = item.evidence
    if (evidence.workspaceId !== job.workspaceId || evidence.worldId !== job.worldId || evidence.sourceType !== job.sourceType || evidence.sourceId !== job.sourceId) throw invalid('knowledge_evidence_scope_mismatch', '证据不属于当前知识来源')
    if (job.sourceType === 'manual' && evidence.createdBy !== 'owner') throw invalid('knowledge_manual_author_required', '手动知识必须由世界所有者确认')
    if (seenEvidence.has(evidence.evidenceId)) throw invalid('knowledge_evidence_duplicate', '知识证据重复')
    seenEvidence.add(evidence.evidenceId)
  }
}

function normalizePortResult(value: unknown | KnowledgeExtractionPortResult): KnowledgeExtractionPortResult {
  if (isPortResult(value)) return value
  return { payload: value }
}
function isPortResult(value: unknown): value is KnowledgeExtractionPortResult {
  return value !== null && typeof value === 'object' && 'payload' in value
}
function outputChars(value: unknown): number {
  try { return JSON.stringify(value).length } catch { return 0 }
}
function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code.slice(0, 80)
  if (error instanceof Error && error.name) return error.name.slice(0, 80)
  return 'knowledge_consolidation_failed'
}
function invalid(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}
