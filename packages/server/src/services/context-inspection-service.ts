import type {
  ContextBudgetPlan,
  ContextCacheInspection,
  ContextEnvelope,
  ContextInspection,
  ContextLayer,
  ContextLayerInspection,
  ContextMemoryHitInspection,
  EmployeeMemoryIndexHit,
} from '@dsh-cyber/contracts'
import { contextEnvelopeLayers } from '@dsh-cyber/contracts'

import { TraceSanitizer } from '../world-trace/trace-sanitizer.js'
import type { ContextConversationLane, ContextCoverage } from './conversation-context-composer.js'

/**
 * The Context Inspector's record of what a turn was actually given.
 *
 * The product complaint this answers is literal: someone used an Agent for
 * weeks and never knew what was in its context. So this records the envelope
 * the composer built for a turn, not a re-derivation of it — a re-derivation
 * would silently disagree with the real turn about the persona, the permission
 * mode and the retrieval ranking, and an inspector that disagrees with reality
 * is worse than none.
 *
 * Three properties are load-bearing:
 *
 * - It records, it does not own. Nothing here is a durable business fact;
 *   SQLite remains the source of truth and the record is deliberately dropped
 *   on restart rather than becoming a second copy of the conversation.
 * - It redacts on the way *in*. The projection is built once, at record time,
 *   and the raw layer bodies are never retained. A credential a user pasted
 *   into a chat therefore cannot be read back out of the inspector later.
 * - It never claims to show reasoning. Every field describes the context this
 *   product assembled and sent; nothing comes from a provider's internals.
 */

/** Conversations kept in the record before the oldest is dropped. */
const MAX_TRACKED_CONVERSATIONS = 64

/** Characters of one layer's redacted excerpt. */
const MAX_LAYER_PREVIEW_CHARS = 800
/** Lines of one layer's redacted excerpt. */
const MAX_LAYER_PREVIEW_LINES = 24
/** Characters kept per line before the excerpt truncates it. */
const MAX_PREVIEW_LINE_CHARS = 240
const MAX_MEMORY_SUMMARY_CHARS = 220
const MAX_MEMORY_HITS = 12
const MAX_MATCH_TERMS = 6

const TRUNCATION_NOTICE = '…'

/**
 * An assignment that looks like an exported credential.
 *
 * The shared trace sanitizer keys off the bare words (`token`, `secret`), which
 * a word boundary hides inside `DEEPSEEK_API_KEY` or `MY_SESSION_SECRET`. Env
 * shaped names are exactly how a credential reaches a chat message in practice,
 * so the inspector redacts that shape too rather than assuming it cannot occur.
 */
const ENVIRONMENT_CREDENTIAL = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)\s*[:=]\s*\S+/g
const REDACTED = '[已隐藏敏感信息]'

export interface ContextInspectionCapture {
  conversationId: string
  employeeId: string
  employeeName: string
  lane: ContextConversationLane
  workTurnId?: string
  /** The AgentRun this context was composed for, when the turn had one. */
  agentRunId?: string
  envelope: ContextEnvelope
  memoryHits: readonly EmployeeMemoryIndexHit[]
  coverage: ContextCoverage
  /** The turn's resolved allocation, when one was planned for it. */
  budget?: ContextBudgetPlan
  /**
   * Prompt-cache statistics for this turn.
   *
   * This is the seam the prompt-cache slice fills. While it is absent the
   * inspector reports `unavailable` and shows no hit rate at all, because a
   * fabricated cache number is worse than an honest blank.
   */
  cache?: ContextCacheInspection
  /** Injected only by tests; production reads the clock. */
  capturedAt?: string
}

export class ContextInspectionService {
  readonly #byConversation = new Map<string, ContextInspection>()
  /**
   * The same records, addressable by run.
   *
   * The trace links a run card to its context, and a conversation's latest
   * record is the wrong answer for any run but the newest. Bounded like the
   * conversation map, so a busy world cannot grow it without limit.
   */
  readonly #byRun = new Map<string, ContextInspection>()
  readonly #sanitizer = new TraceSanitizer()
  readonly #limit: number

  constructor(options: { maxConversations?: number } = {}) {
    const limit = options.maxConversations
    this.#limit = Number.isSafeInteger(limit) && limit! > 0 ? limit! : MAX_TRACKED_CONVERSATIONS
  }

  /** Projects and stores one turn's context. Never throws into the turn. */
  record(capture: ContextInspectionCapture): void {
    const conversationId = capture.conversationId.trim()
    if (!conversationId) return
    const inspection = this.#project(conversationId, capture)
    // Re-inserting moves the conversation to the end, so eviction drops the
    // conversation nobody has looked at for longest, not an active one.
    this.#byConversation.delete(conversationId)
    this.#byConversation.set(conversationId, inspection)
    while (this.#byConversation.size > this.#limit) {
      const oldest = this.#byConversation.keys().next()
      if (oldest.done === true) break
      this.#byConversation.delete(oldest.value)
    }
    const agentRunId = capture.agentRunId?.trim()
    if (agentRunId === undefined || agentRunId === '') return
    this.#byRun.delete(agentRunId)
    this.#byRun.set(agentRunId, inspection)
    while (this.#byRun.size > this.#limit) {
      const oldest = this.#byRun.keys().next()
      if (oldest.done === true) break
      this.#byRun.delete(oldest.value)
    }
  }

  /** The most recent composed context, or `undefined` when none was recorded. */
  latest(conversationId: string): ContextInspection | undefined {
    return this.#byConversation.get(conversationId.trim())
  }

  /** The context composed for one run, or `undefined` when this process never recorded it. */
  forRun(agentRunId: string): ContextInspection | undefined {
    return this.#byRun.get(agentRunId.trim())
  }

  #project(conversationId: string, capture: ContextInspectionCapture): ContextInspection {
    const layers = contextEnvelopeLayers(capture.envelope).map((layer) => this.#layer(layer))
    return {
      conversationId,
      employeeId: capture.employeeId,
      employeeName: capture.employeeName,
      capturedAt: capture.capturedAt ?? new Date().toISOString(),
      lane: capture.lane,
      ...(capture.workTurnId === undefined ? {} : { workTurnId: capture.workTurnId }),
      ...(capture.agentRunId === undefined ? {} : { agentRunId: capture.agentRunId }),
      usedTokens: capture.envelope.totalTokenEstimate,
      budget: capture.budget === undefined ? {} : {
        contextWindow: capture.budget.contextWindow,
        inputBudgetTokens: capture.budget.inputBudgetTokens,
        memoryTokens: capture.budget.memoryTokens,
        historyTokens: capture.budget.historyTokens,
      },
      layers,
      memoryHits: capture.memoryHits.slice(0, MAX_MEMORY_HITS).map((hit) => this.#memoryHit(hit)),
      cache: {
        ...(capture.cache ?? { state: 'unavailable' as const }),
        stableContextHash: capture.envelope.stableContextHash,
      },
      coverage: {
        memoryScopes: [...capture.coverage.memoryScopes],
        rawEntryCount: capture.coverage.rawEntryCount,
        droppedOlderEntryCount: capture.coverage.droppedOlderEntryCount,
        unrememberedRawEntryCount: capture.coverage.unrememberedRawEntryCount,
        hydratedMemoryCount: capture.coverage.hydratedMemoryCount,
        hydratedSourceMessageCount: capture.coverage.hydratedSourceMessageCount,
        rawWindowApplied: capture.coverage.rawWindowApplied,
        fullReplayFallback: capture.coverage.fullReplayFallback,
      },
    }
  }

  #layer(layer: ContextLayer): ContextLayerInspection {
    const preview = this.#preview(layer.text, MAX_LAYER_PREVIEW_CHARS, MAX_LAYER_PREVIEW_LINES)
    return {
      kind: layer.kind,
      id: layer.id,
      revision: layer.revision,
      contentHash: layer.contentHash,
      tokenEstimate: layer.tokenEstimate,
      sourceCount: layer.sourceRefs.length,
      preview: preview.text,
      previewTruncated: preview.truncated,
    }
  }

  #memoryHit(hit: EmployeeMemoryIndexHit): ContextMemoryHitInspection {
    const entry = hit.entry
    return {
      memoryId: entry.memoryId,
      scope: entry.scope,
      score: hit.score,
      reason: this.#reason(hit),
      occurredAt: entry.occurredAt,
      sourceMessageCount: entry.sourceMessageIds.length,
      artifactCount: entry.artifactRefs.length,
      summary: this.#preview(entry.summary, MAX_MEMORY_SUMMARY_CHARS, 4).text,
    }
  }

  /**
   * Why retrieval chose this memory, in the user's own vocabulary.
   *
   * The matched terms come from the user's messages, so they are redacted like
   * any other recovered text before they are named back to them.
   */
  #reason(hit: EmployeeMemoryIndexHit): string {
    const parts: string[] = []
    const keywords = this.#terms(hit.matchedKeywords)
    const entities = this.#terms(hit.matchedEntities)
    if (keywords) parts.push(`关键词命中：${keywords}`)
    if (entities) parts.push(`实体命中：${entities}`)
    if (parts.length === 0) parts.push('按检索排序进入本轮')
    parts.push(`记忆重要度 ${hit.entry.importance.toFixed(2)}`)
    return parts.join('｜')
  }

  #terms(values: readonly string[]): string {
    return values
      .slice(0, MAX_MATCH_TERMS)
      .map((value) => this.#redact(value, 40))
      .filter((value) => value.length > 0)
      .join('、')
  }

  /**
   * A redacted, bounded excerpt that keeps the layer's line structure.
   *
   * The shared sanitizer collapses every run of whitespace, which turns a
   * seven-line world rule into one unreadable ribbon. Redacting per line keeps
   * the same guarantees and keeps the shape a reader recognizes.
   */
  #preview(text: string, maxCharacters: number, maxLines: number): { text: string; truncated: boolean } {
    const lines = text.split('\n')
    const kept: string[] = []
    let used = 0
    let truncated = lines.length > maxLines
    for (const line of lines.slice(0, maxLines)) {
      const redacted = this.#redact(line, MAX_PREVIEW_LINE_CHARS)
      if (redacted.endsWith(TRUNCATION_NOTICE)) truncated = true
      const remaining = maxCharacters - used
      if (remaining <= 0) {
        truncated = true
        break
      }
      if (redacted.length > remaining) {
        kept.push(`${redacted.slice(0, remaining)}${TRUNCATION_NOTICE}`)
        truncated = true
        break
      }
      kept.push(redacted)
      used += redacted.length + 1
    }
    return { text: kept.join('\n').trim(), truncated }
  }

  #redact(value: string, maxCharacters: number): string {
    return this.#sanitizer.text(value.replace(ENVIRONMENT_CREDENTIAL, REDACTED), maxCharacters)
  }
}
