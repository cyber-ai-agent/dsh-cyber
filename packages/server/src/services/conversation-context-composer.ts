import type {
  ContextEnvelope,
  ContextLayer,
  ContextSourceRef,
  ConversationHistoryEntry,
  EmployeeInstance,
  EmployeeMemoryScope,
  TaskCollaborationPlan,
  WorkSession,
} from '@dsh-cyber/contracts'
import { composeContextEnvelope, composeContextLayer, estimateTextTokens } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import {
  MEMORY_CONTEXT_FOOTER,
  MEMORY_CONTEXT_HEADER,
  visibleMemoryScopes,
  type CharacterMemoryContextPort,
} from './employee-conversation-memory-service.js'

/**
 * The one place that decides what a character turn actually sees.
 *
 * Before this composer the decision was split in two: `CharacterProfileRuntime`
 * produced persona plus a memory block, and the Harness adapter separately
 * replayed the recovered conversation in front of it. Nothing owned the whole
 * picture, so nothing could bound it either — a long conversation replayed
 * every message on every turn.
 *
 * The composer keeps a bounded window of the newest turns in their RAW form and
 * stops replaying the rest. Older episodes come back on demand through the
 * memory index instead, which is derived from the durable milestones and is
 * scoped: a group or task conversation can never reach a private memory.
 *
 * Two responsibilities stay outside on purpose:
 *
 * - World context is still contributed by `WorldRuntimeContextComposer` before
 *   the runtime sees the prompt, so this composer leaves that layer empty.
 * - The *rendering* of the recent-conversation layer stays with the runtime
 *   lane, because only the lane knows what its live Agent session has already
 *   observed. The composer decides which turns are eligible; the lane may send
 *   a suffix of them. `recentConversation.text` is therefore what a fresh lane
 *   receives, and a live lane always receives a suffix of it — never more.
 */

/** How many of the newest user turns stay in their raw conversational form. */
export const RAW_TURN_WINDOW = 6

const MAX_RETRIEVED_MEMORIES = 8
const DEFAULT_MEMORY_BUDGET_TOKENS = 2_000

export type ContextConversationLane = 'direct' | 'group' | 'task' | 'unknown'

export interface ConversationMemoryLayersPort extends CharacterMemoryContextPort {
  memoryContextLayers?(input: {
    employeeId: string
    conversationId: string
    prompt: string
    limit?: number
  }): { memoryIndex: ContextLayer; retrievedMemories: ContextLayer } | undefined
}

type ContextComposerStore = Pick<SqliteStore, 'getSession'>
  & Partial<Pick<SqliteStore, 'getLatestTaskCollaborationPlanForSession'>>

export interface ComposeTurnContextInput {
  employee: EmployeeInstance
  /** The persona this turn will actually run with, already fully composed. */
  persona: string
  personaRevision?: number
  conversationId: string
  prompt: string
  history: readonly ConversationHistoryEntry[]
  /** Durable cursor of this employee's own last statement, or 0. */
  observedThroughSequence: number
  workTurnId?: string
  memoryBudgetTokens?: number
}

/**
 * What the composer decided, and what it could not cover.
 *
 * `fullReplayFallback` is the honest escape hatch: retrieval is not lossless,
 * so when it returns nothing at all the composer refuses to drop history and
 * replays the conversation the way the old path did.
 */
export interface ContextCoverage {
  lane: ContextConversationLane
  memoryScopes: EmployeeMemoryScope[]
  retrievedMemoryCount: number
  /** Entries kept in raw conversational form this turn. */
  rawEntryCount: number
  /** Entries older than the raw window that were not replayed this turn. */
  droppedOlderEntryCount: number
  /** True once this lane is on the bounded window instead of full replay. */
  rawWindowApplied: boolean
  fullReplayFallback: boolean
}

export interface ComposedTurnContext {
  envelope: ContextEnvelope
  /** Prompt text for every layer the runtime lane does not render itself. */
  prompt: string
  /** Turns the lane may replay raw. Always a suffix of the durable history. */
  recentHistory: ConversationHistoryEntry[]
  coverage: ContextCoverage
}

export class ConversationContextComposer {
  readonly #store: ContextComposerStore
  readonly #memory: ConversationMemoryLayersPort | undefined

  constructor(store: ContextComposerStore, memory?: ConversationMemoryLayersPort) {
    this.#store = store
    this.#memory = memory
  }

  async compose(input: ComposeTurnContextInput): Promise<ComposedTurnContext> {
    const session = this.#store.getSession(input.conversationId)
    const lane = conversationLane(session)
    const memoryScopes = session === undefined ? [] : visibleMemoryScopes(session)
    const budgetTokens = normalizeBudget(input.memoryBudgetTokens)

    // Scope is derived from the durable session, never from the caller. This is
    // the boundary a group turn must not be able to argue its way past.
    const memoryLayers = session === undefined
      ? undefined
      : this.#memory?.memoryContextLayers?.({
          employeeId: input.employee.id,
          conversationId: input.conversationId,
          prompt: input.prompt,
          limit: MAX_RETRIEVED_MEMORIES,
        })
    const trimmed = memoryLayers === undefined ? undefined : withinBudget(memoryLayers, budgetTokens)
    const retrievedMemoryCount = trimmed === undefined ? 0 : countMemoryRefs(trimmed.memoryIndex)

    // Retrieval is not lossless. When it produced nothing the old full replay
    // is still the only thing that can answer a question about an older turn,
    // so the composer keeps it rather than shipping a silent regression.
    const memoryText = trimmed === undefined
      ? await this.#memory?.compose({
          employeeId: input.employee.id,
          conversationId: input.conversationId,
          prompt: input.prompt,
          budgetTokens,
        })
      : renderMemory(trimmed)

    const plan = session === undefined
      ? undefined
      : this.#store.getLatestTaskCollaborationPlanForSession?.(session.id)
    const taskContext = plan === undefined || session === undefined
      ? undefined
      : composeTaskContextLayer(session, plan, input.employee.id, trimmed?.retrievedMemories)

    const window = rawWindow({
      lane,
      history: input.history,
      observedThroughSequence: input.observedThroughSequence,
      retrievedMemoryCount,
    })
    const recentHistory = input.history.slice(window.startIndex)

    const sections: string[] = []
    if (taskContext !== undefined) sections.push(taskContext.text)
    if (memoryText !== undefined && memoryText.trim()) sections.push(memoryText)
    const prompt = sections.length === 0
      ? input.prompt
      : `${sections.join('\n\n')}\n\n[当前请求]\n${input.prompt}`

    const envelope = composeContextEnvelope({
      stableIdentity: composeContextLayer({
        id: `identity:${input.employee.id}`,
        kind: 'stable-identity',
        text: input.persona,
        ...(input.personaRevision === undefined ? {} : { revision: String(input.personaRevision) }),
        sourceRefs: [
          { kind: 'employee', id: input.employee.id },
          {
            kind: 'employee-revision',
            id: input.employee.id,
            revision: String(input.personaRevision ?? input.employee.currentRevision),
          },
        ],
      }),
      ...(taskContext === undefined ? {} : { taskContext }),
      ...(trimmed === undefined ? {} : { memoryIndex: trimmed.memoryIndex, retrievedMemories: trimmed.retrievedMemories }),
      ...(recentHistory.length === 0
        ? {}
        : { recentConversation: composeRecentConversationLayer(input.conversationId, recentHistory) }),
      currentRequest: composeContextLayer({
        id: `request:${input.workTurnId ?? input.conversationId}`,
        kind: 'current-request',
        text: input.prompt,
        sourceRefs: [
          { kind: 'request', id: input.workTurnId ?? input.conversationId },
          { kind: 'session', id: input.conversationId },
        ],
      }),
    })

    return {
      envelope,
      prompt,
      recentHistory,
      coverage: {
        lane,
        memoryScopes,
        retrievedMemoryCount,
        rawEntryCount: recentHistory.length,
        droppedOlderEntryCount: window.startIndex,
        rawWindowApplied: window.rawWindowApplied,
        fullReplayFallback: window.fullReplayFallback,
      },
    }
  }
}

/**
 * Builds a composer for a store that carries the durable rows it needs.
 *
 * A narrower store (legacy embedders, unit tests with a stub) simply gets no
 * composer and keeps the previous behaviour.
 */
export function defaultConversationContextComposer(
  store: Partial<ContextComposerStore> & Record<string, unknown>,
  memory: ConversationMemoryLayersPort | undefined,
): ConversationContextComposer | undefined {
  if (typeof store.getSession !== 'function') return undefined
  return new ConversationContextComposer(store as ContextComposerStore, memory)
}

export function conversationLane(session: WorkSession | undefined): ContextConversationLane {
  if (session === undefined) return 'unknown'
  if (session.kind === 'direct') return 'direct'
  if (session.kind === 'task' || session.collaborationMode === 'task') return 'task'
  return 'group'
}

/**
 * The turns that stay raw.
 *
 * Only the direct lane is switched to a bounded window in this slice. Group and
 * task lanes still replay in full: their retrieval coverage is thinner, because
 * a group episode is only remembered for the employee that actually produced an
 * AgentRun, and peers' statements are not indexed for this character at all.
 */
function rawWindow(input: {
  lane: ContextConversationLane
  history: readonly ConversationHistoryEntry[]
  observedThroughSequence: number
  retrievedMemoryCount: number
}): { startIndex: number; rawWindowApplied: boolean; fullReplayFallback: boolean } {
  // Not migrated yet, not a fallback: these lanes still replay in full by design.
  if (input.lane !== 'direct') return { startIndex: 0, rawWindowApplied: false, fullReplayFallback: false }
  // Retrieval covered nothing, so full replay is the only thing that can still
  // answer a question about an older turn.
  if (input.retrievedMemoryCount === 0) return { startIndex: 0, rawWindowApplied: false, fullReplayFallback: true }

  let start = 0
  let userTurns = 0
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    if (input.history[index]!.role !== 'user') continue
    userTurns += 1
    if (userTurns > RAW_TURN_WINDOW) {
      start = index + 1
      break
    }
  }
  if (start === 0) return { startIndex: 0, rawWindowApplied: true, fullReplayFallback: false }

  // A positive cursor means this character already holds a durable position in
  // the conversation, and everything after it is genuinely new to it. That set
  // is bounded by ordinary conversation flow, so it is always kept raw. A zero
  // cursor means the character never spoke here, which is exactly the case the
  // window exists to bound.
  if (input.observedThroughSequence > 0) {
    const firstUnobserved = input.history.findIndex((entry) => entry.sequence > input.observedThroughSequence)
    if (firstUnobserved >= 0) start = Math.min(start, firstUnobserved)
  }
  return { startIndex: start, rawWindowApplied: true, fullReplayFallback: false }
}

function composeRecentConversationLayer(
  conversationId: string,
  entries: readonly ConversationHistoryEntry[],
): ContextLayer {
  return composeContextLayer({
    id: `recent-conversation:${conversationId}`,
    kind: 'recent-conversation',
    text: entries
      .map((entry) => `${entry.sequence} · ${entry.speakerName}：${entry.content}`)
      .join('\n'),
    sourceRefs: [{ kind: 'session', id: conversationId }],
  })
}

/**
 * The routed task as its own layer.
 *
 * Goal, plan, dependencies and completed steps are structured fields of the
 * durable `TaskCollaborationPlan`; they are rendered as such instead of being
 * flattened into a chat summary where the model has to re-infer them.
 */
function composeTaskContextLayer(
  session: WorkSession,
  plan: TaskCollaborationPlan,
  employeeId: string,
  retrievedMemories: ContextLayer | undefined,
): ContextLayer {
  const steps = [...plan.steps].sort((left, right) => left.ordinal - right.ordinal)
  const completed = steps.filter((step) => step.status === 'completed').map((step) => step.id)
  const artifacts = [...new Set((retrievedMemories?.sourceRefs ?? [])
    .filter((ref) => ref.kind === 'artifact')
    .map((ref) => ref.id))]
  const lines = [
    '[任务上下文]',
    `目标：${session.title.trim() || '未命名任务'}`,
    `任务编号：${plan.taskId}`,
    `计划状态：${plan.status}（第 ${plan.revision} 版）`,
    '步骤：',
    ...steps.map((step) => [
      `- ${step.ordinal} ${step.id} [${step.status}]`,
      `技能：${step.requiredSkills.length === 0 ? '无' : step.requiredSkills.join('、')}`,
      `负责：${step.assignedEmployeeIds.includes(employeeId) ? '本人' : `其他角色（${step.assignedEmployeeIds.length}）`}`,
      `依赖：${step.dependsOn.length === 0 ? '无' : step.dependsOn.join('、')}`,
      `执行：${step.executionMode}`,
    ].join('｜')),
  ]
  if (completed.length > 0) lines.push(`已完成步骤：${completed.join('、')}`)
  if (artifacts.length > 0) lines.push(`相关产物：${artifacts.join('、')}`)

  return composeContextLayer({
    id: `task-context:${plan.id}`,
    kind: 'task-context',
    revision: String(plan.revision),
    text: lines.join('\n'),
    sourceRefs: [
      { kind: 'session', id: session.id },
      { kind: 'work-turn', id: plan.workTurnId },
      ...artifacts.map((id): ContextSourceRef => ({ kind: 'artifact', id })),
    ],
  })
}

/**
 * Renders the two memory layers with the same data-only framing the previous
 * memory block carried. The summaries are recovered conversation text, so the
 * framing is a safety boundary, not decoration.
 */
function renderMemory(layers: { memoryIndex: ContextLayer; retrievedMemories: ContextLayer }): string {
  return [
    ...MEMORY_CONTEXT_HEADER,
    '[记忆索引]',
    layers.memoryIndex.text,
    '[可用记忆]',
    layers.retrievedMemories.text,
    MEMORY_CONTEXT_FOOTER,
  ].join('\n')
}

/**
 * Drops the lowest-ranked retrieved memories until the rendered block fits the
 * memory budget. Ranking already put the most relevant hit first, so trimming
 * from the tail loses the least.
 */
function withinBudget(
  layers: { memoryIndex: ContextLayer; retrievedMemories: ContextLayer },
  budgetTokens: number,
): { memoryIndex: ContextLayer; retrievedMemories: ContextLayer } | undefined {
  const indexLines = layers.memoryIndex.text.split('\n').filter((line) => line.trim())
  const memoryLines = layers.retrievedMemories.text.split('\n').filter((line) => line.trim())
  if (memoryLines.length === 0) return undefined
  for (let kept = memoryLines.length; kept >= 1; kept -= 1) {
    const candidate = {
      memoryIndex: composeContextLayer({
        id: layers.memoryIndex.id,
        kind: 'memory-index',
        text: indexLines.slice(0, kept).join('\n'),
        sourceRefs: layers.memoryIndex.sourceRefs.slice(0, kept),
      }),
      retrievedMemories: composeContextLayer({
        id: layers.retrievedMemories.id,
        kind: 'retrieved-memories',
        text: memoryLines.slice(0, kept).join('\n'),
        sourceRefs: layers.retrievedMemories.sourceRefs.slice(0, kept),
      }),
    }
    if (estimateTextTokens(renderMemory(candidate)) <= budgetTokens) return candidate
  }
  return undefined
}

function countMemoryRefs(layer: ContextLayer): number {
  return layer.sourceRefs.filter((ref) => ref.kind === 'memory').length
}

function normalizeBudget(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 128 ? Math.min(16_384, value!) : DEFAULT_MEMORY_BUDGET_TOKENS
}
