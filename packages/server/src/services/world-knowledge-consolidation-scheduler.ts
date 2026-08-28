import type { WorkSession } from '@dsh-cyber/contracts'

import {
  KNOWLEDGE_CONSOLIDATION_THRESHOLDS,
  shouldConsolidate,
  type KnowledgeConsolidationCursor,
  type KnowledgeConsolidationSettings,
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
}

export interface WorldKnowledgeConsolidationSchedulerOptions {
  repository: KnowledgeBalancedScanRepository
  messages: Pick<KnowledgeConversationSourceStore, 'listMessagesPage'>
  service: Pick<WorldKnowledgeConsolidationService, 'enqueueConversation'>
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
  readonly #service: Pick<WorldKnowledgeConsolidationService, 'enqueueConversation'>
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

  async scanOnce(): Promise<{ worlds: number; sessions: number; queued: number }> {
    if (this.#scanning) return { worlds: 0, sessions: 0, queued: 0 }
    this.#scanning = true
    let worlds = 0
    let sessions = 0
    let queued = 0
    try {
      const worldRefs = await this.#repository.listWorlds()
      worlds = worldRefs.length
      for (const world of worldRefs) {
        if (queued >= this.#maxJobsPerScan) break
        const settings = this.#repository.getKnowledgeConsolidationSettings === undefined
          ? undefined
          : await this.#repository.getKnowledgeConsolidationSettings(world.worldId)
        if (settings?.autoConsolidationMode === 'off') continue
        const worldSessions = await this.#repository.listSessions(world.worldId)
        for (const session of worldSessions) {
          if (queued >= this.#maxJobsPerScan) break
          if (session.workspaceId !== world.workspaceId || session.worldId !== world.worldId) continue
          // Private employee memory is not world knowledge. A direct chat may
          // still be promoted manually by the owner through the explicit
          // knowledge flow, but balanced background scanning never does it.
          if (session.kind === 'direct') continue
          sessions += 1
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
}

function messageTime(message: { createdAt: string }): string { return message.createdAt }

function parseTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : Date.now()
}
