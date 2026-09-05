import type { WorkSession } from '@dsh-cyber/contracts'

import {
  KNOWLEDGE_CONSOLIDATION_THRESHOLDS,
  shouldConsolidate,
  type KnowledgeConsolidationCursor,
  type KnowledgeConsolidationSettings,
  type KnowledgeConsolidationJob,
  type KnowledgeSourceVersionState,
  type WorldKnowledgeConsolidationService,
} from './world-knowledge-consolidation-service.js'
import type { KnowledgeConversationSourceStore } from './world-knowledge-source-loader.js'

/** A world reference is resolved by the host, never supplied by a chat client. */
export interface KnowledgeScanWorld {
  workspaceId: string
  worldId: string
}

export interface KnowledgeBalancedScanRepository {
  listWorlds(): readonly KnowledgeScanWorld[] | Promise<readonly KnowledgeScanWorld[]>
  listSessions(worldId: string): readonly WorkSession[] | Promise<readonly WorkSession[]>
  getKnowledgeConsolidationSettings?(worldId: string): KnowledgeConsolidationSettings | undefined | Promise<KnowledgeConsolidationSettings | undefined>
  getKnowledgeConsolidationCursor?(input: { worldId: string; sourceType: 'conversation'; sourceId: string }): KnowledgeConsolidationCursor | undefined | Promise<KnowledgeConsolidationCursor | undefined>
  getConsolidationSourceJob?(worldId: string, sourceType: 'conversation' | 'document' | 'artifact', sourceId: string): KnowledgeConsolidationJob | undefined | Promise<KnowledgeConsolidationJob | undefined>
  listSources?(worldId: string): readonly { sourceType: 'document' | 'artifact'; sourceId: string; updatedAt: string }[] | Promise<readonly { sourceType: 'document' | 'artifact'; sourceId: string; updatedAt: string }[]>
  /**
   * How far the source's *live* content has been walked. Must report nothing
   * when the recorded version no longer matches what the source holds today,
   * so a stale watermark can never make the scan skip unread chunks.
   */
  getKnowledgeSourceProgress?(input: { worldId: string; sourceType: 'document' | 'artifact'; sourceId: string }): KnowledgeSourceVersionState | undefined | Promise<KnowledgeSourceVersionState | undefined>
}

export interface WorldKnowledgeConsolidationSchedulerOptions {
  repository: KnowledgeBalancedScanRepository
  messages: Pick<KnowledgeConversationSourceStore, 'listMessagesPage'>
  service: Pick<WorldKnowledgeConsolidationService, 'enqueueConversation'> & Partial<Pick<WorldKnowledgeConsolidationService, 'retryJob' | 'enqueue'>>
  clockMs?: () => number
  intervalMs?: number
  /** Avoid queueing excessively many sessions in one scheduler tick. */
  maxJobsPerScan?: number
  onError?: (error: unknown) => void
}

/**
 * Balanced mode is intentionally a cheap database scan. It only creates a
 * durable queued job; the consolidation service owns model extraction in its
 * separate worker loop. This keeps chat and HTTP request latency independent
 * from the model provider.
 *
 * Direct conversations are employee-private continuity. They are deliberately
 * excluded here: the employee memory projection owns them, and promoting them
 * automatically to a world-wide graph would let an unrelated character search
 * facts the owner only told one employee. Group/project visibility will move
 * to an explicit visibility contract in Real Collaboration V2; this guard is
 * the non-negotiable private-chat boundary for V1.
 */
export class WorldKnowledgeConsolidationScheduler {
  readonly #repository: KnowledgeBalancedScanRepository
  readonly #messages: Pick<KnowledgeConversationSourceStore, 'listMessagesPage'>
  readonly #service: WorldKnowledgeConsolidationSchedulerOptions['service']
  readonly #clockMs: () => number
  readonly #intervalMs: number
  readonly #maxJobsPerScan: number
  readonly #onError: ((error: unknown) => void) | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #scanning = false

  constructor(options: WorldKnowledgeConsolidationSchedulerOptions) {
    this.#repository = options.repository
    this.#messages = options.messages
    this.#service = options.service
    this.#clockMs = options.clockMs ?? Date.now
    this.#intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? 10_000))
    this.#maxJobsPerScan = Math.max(1, Math.floor(options.maxJobsPerScan ?? 32))
    this.#onError = options.onError
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => { void this.scanOnce().catch((error) => this.#onError?.(error)) }, this.#intervalMs)
    const timer = this.#timer as { unref?: () => void }
    timer.unref?.()
    void this.scanOnce().catch((error) => this.#onError?.(error))
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async scanOnce(worldId?: string): Promise<{ worlds: number; sessions: number; queued: number }> {
    if (this.#scanning) return { worlds: 0, sessions: 0, queued: 0 }
    this.#scanning = true
    let worlds = 0
    let sessions = 0
    let queued = 0
    try {
      const worldRefs = (await this.#repository.listWorlds()).filter((world) => worldId === undefined || world.worldId === worldId)
      worlds = worldRefs.length
      for (const world of worldRefs) {
        if (queued >= this.#maxJobsPerScan) break
        const settings = this.#repository.getKnowledgeConsolidationSettings === undefined
          ? undefined
          : await this.#repository.getKnowledgeConsolidationSettings(world.worldId)
        if (settings?.autoConsolidationMode === 'off') continue
        // Imported documents and published files are durable sources too.
        // Scanning their revision also recovers an event lost during shutdown.
        const sources = await this.#repository.listSources?.(world.worldId) ?? []
        for (const source of sources) {
          if (queued >= this.#maxJobsPerScan || this.#service.enqueue === undefined) break
          const revision = Date.parse(source.updatedAt)
          if (!Number.isSafeInteger(revision) || revision < 0 || this.#clockMs() - revision < 15_000) continue
          const job = await this.#repository.getConsolidationSourceJob?.(world.worldId, source.sourceType, source.sourceId)
          if (job?.status === 'queued' || job?.status === 'running') continue
          // A completed job means one chunk window finished, never that the
          // whole source did. The watermark of the live content decides: when
          // it has reached the last chunk there is nothing to do whatever the
          // revision timestamp says, and otherwise the next window starts
          // exactly where the last one stopped. A host that keeps no watermark
          // at all cannot tell, so it keeps the older, less precise rule
          // rather than re-walking every source on every scan.
          const tracksChunks = this.#repository.getKnowledgeSourceProgress !== undefined
          const progress = await this.#repository.getKnowledgeSourceProgress?.({ worldId: world.worldId, sourceType: source.sourceType, sourceId: source.sourceId })
          if (progress !== undefined && progress.processedChunks >= progress.chunkTotal) continue
          if (job?.toCursor === revision) {
            if (job.status === 'completed') {
              if (!tracksChunks) continue
            } else {
              const blocked = await this.#resumeSource(job)
              if (blocked !== undefined) { queued += blocked; continue }
            }
          }
          const fromCursor = progress === undefined ? 0 : Math.min(progress.processedChunks, progress.chunkTotal)
          // A window that completed without moving the watermark would be
          // re-queued forever. Leave the source visibly incomplete instead of
          // spinning on it; the truth is already on the row.
          if (job?.status === 'completed' && job.toCursor === revision && job.fromCursor === fromCursor) continue
          const enqueued = await this.#service.enqueue({ workspaceId: world.workspaceId, worldId: world.worldId, sourceType: source.sourceType, sourceId: source.sourceId, fromCursor, toCursor: revision })
          // Enqueue is idempotent per window, so it can hand back a window that
          // already failed. That is a retry decision, not a fresh queue entry:
          // let the same bounded backoff own it instead of silently reporting
          // work that will never run.
          if (enqueued?.status === 'failed') {
            queued += await this.#resumeSource(enqueued) ?? 0
            continue
          }
          queued += 1
        }
        const worldSessions = await this.#repository.listSessions(world.worldId)
        for (const session of worldSessions) {
          if (queued >= this.#maxJobsPerScan) break
          if (session.workspaceId !== world.workspaceId || session.worldId !== world.worldId) continue
          // Private employee memory is not world knowledge. A direct chat may
          // still be promoted manually by the owner through the explicit
          // knowledge flow, but balanced background scanning never does it.
          if (session.kind === 'direct') continue
          sessions += 1
          const sourceJob = await this.#repository.getConsolidationSourceJob?.(world.worldId, 'conversation', session.id)
          // A changing toCursor must not create overlapping jobs while the same
          // source is being extracted. New messages remain behind its cursor.
          const blocked = await this.#resumeSource(sourceJob)
          if (blocked !== undefined) { queued += blocked; continue }
          const cursor = this.#repository.getKnowledgeConsolidationCursor === undefined
            ? undefined
            : await this.#repository.getKnowledgeConsolidationCursor({ worldId: world.worldId, sourceType: 'conversation', sourceId: session.id })
          const fromCursor = Math.max(0, cursor?.processedThroughSequence ?? 0)
          const page = this.#messages.listMessagesPage(session.id, { limit: KNOWLEDGE_CONSOLIDATION_THRESHOLDS.maxMessages, afterSequence: fromCursor, chatOnly: true })
          const visible = page.items
            .filter((message) => message.sessionId === session.id)
            .filter((message) => message.kind === 'user' || message.kind === 'assistant')
            .filter((message) => message.sequence > fromCursor && message.content.trim().length > 0)
          const latest = visible[visible.length - 1]
          if (latest === undefined) continue
          const toCursor = latest.sequence
          if (toCursor <= fromCursor) continue
          const characters = visible.reduce((total, message) => total + Array.from(message.content).length, 0)
          const idleMs = Math.max(0, this.#clockMs() - parseTime(messageTime(latest)))
          if (!shouldConsolidate({ visibleMessages: visible.length, characters, idleMs, mode: settings?.autoConsolidationMode ?? 'balanced' })) continue
          await this.#service.enqueueConversation({
            workspaceId: world.workspaceId,
            worldId: world.worldId,
            sessionId: session.id,
            fromCursor,
            toCursor,
          })
          queued += 1
        }
      }
      return { worlds, sessions, queued }
    } finally {
      this.#scanning = false
    }
  }

  /** undefined means ready; zero/one means blocked or a queued retry. */
  async #resumeSource(job: KnowledgeConsolidationJob | undefined): Promise<number | undefined> {
    if (job?.status === 'queued' || job?.status === 'running') return 0
    if (job?.status !== 'failed') return undefined
    const transient = ['knowledge_model_timeout', 'knowledge_model_unreachable', 'knowledge_model_rate_limited', 'knowledge_model_upstream_error'].includes(job.errorCode ?? '')
    const delayMs = 30_000 * 2 ** Math.max(0, job.attempt - 1)
    if (transient && job.attempt < 3 && this.#clockMs() - parseTime(job.updatedAt) >= delayMs && this.#service.retryJob !== undefined) {
      await this.#service.retryJob(job.worldId, job.id)
      return 1
    }
    return 0
  }
}

function messageTime(message: { createdAt: string }): string { return message.createdAt }

function parseTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : Date.now()
}
