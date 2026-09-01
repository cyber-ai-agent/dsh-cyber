import type {
  ContextEnvelope,
  ContextLayer,
  ContextSourceRef,
  ConversationHistoryEntry,
  EmployeeInstance,
  EmployeeMemoryIndexHit,
  EmployeeMemoryScope,
  TaskCollaborationPlan,
  WorkMessage,
  WorkSession,
} from '@dsh-cyber/contracts'
import { composeContextEnvelope, composeContextLayer, estimateTextTokens } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import {
  composeMemoryLayers,
  MEMORY_CONTEXT_FOOTER,
  MEMORY_CONTEXT_HEADER,
  visibleMemoryScopes,
  type CharacterMemoryContextPort,
  type MemoryContextLayers,
  type MemorySourceHydration,
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
/**
 * How many of this character's index entries are consulted when deciding which
 * of the older turns are recoverable. It matches the repository's own listing
 * cap; running past it can only make the composer keep *more* raw history, so
 * the bound fails towards replay, never towards a dropped turn.
 */
const MAX_COVERAGE_MEMORIES = 500

export type ContextConversationLane = 'direct' | 'group' | 'task' | 'unknown'

export interface ConversationMemoryLayersPort extends CharacterMemoryContextPort {
  memoryContextLayers?(input: {
    employeeId: string
    conversationId: string
    prompt: string
    limit?: number
  }): MemoryContextLayers | undefined
  hydrateMemorySources?(input: {
    employeeId: string
    conversationId: string
    hits: readonly EmployeeMemoryIndexHit[]
    budgetTokens: number
    excludeMessageIds?: readonly string[]
  }): MemorySourceHydration | undefined
}

type ContextComposerStore = Pick<SqliteStore, 'getSession'>
  & Partial<Pick<
    SqliteStore,
    'getLatestTaskCollaborationPlanForSession' | 'listMessages' | 'listEmployeeMemoryIndex'
  >>

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
  /**
   * Entries the bounded window would have dropped but had to keep raw, because
   * nothing ever indexed them and retrieval could therefore never bring them back.
   */
  unrememberedRawEntryCount: number
  /** Retrieved memories whose raw source messages were put back in front of the model. */
  hydratedMemoryCount: number
  hydratedSourceMessageCount: number
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
    const trimmed = memoryLayers === undefined
      ? undefined
      : withinBudget(input.employee.id, memoryLayers, budgetTokens)
    const retrievedMemoryCount = trimmed === undefined ? 0 : countMemoryRefs(trimmed.memoryIndex)

    // The durable messages are read once and serve both questions that need
    // them: which older turns an indexed memory can still bring back, and which
    // rows the raw window is about to replay verbatim anyway.
    const durableMessages = trimmed === undefined || session === undefined
      ? undefined
      : this.#store.listMessages?.(session.id)

    const window = rawWindow({
      lane,
      history: input.history,
      observedThroughSequence: input.observedThroughSequence,
      retrievedMemoryCount,
      ...(session === undefined || lane !== 'direct' || retrievedMemoryCount === 0
        ? {}
        : { rememberedSequences: this.#rememberedSequences(input.employee.id, session, durableMessages) }),
    })
    const recentHistory = input.history.slice(window.startIndex)

    // Hydration is funded out of the memory budget the summaries already had,
    // never on top of it, and it never re-fetches what the raw window is about
    // to replay verbatim anyway.
    const hydration = trimmed === undefined
      ? undefined
      : this.#memory?.hydrateMemorySources?.({
          employeeId: input.employee.id,
          conversationId: input.conversationId,
          hits: trimmed.hits,
          budgetTokens: budgetTokens - estimateTextTokens(renderMemory(trimmed)),
          excludeMessageIds: rawWindowMessageIds(durableMessages, recentHistory),
        })
    const composedMemory = trimmed === undefined || hydration === undefined
      ? trimmed
      : withHydratedSources(trimmed, hydration)

    // Retrieval is not lossless. When it produced nothing the old full replay
    // is still the only thing that can answer a question about an older turn,
    // so the composer keeps it rather than shipping a silent regression.
    const memoryText = composedMemory === undefined
      ? await this.#memory?.compose({
          employeeId: input.employee.id,
          conversationId: input.conversationId,
          prompt: input.prompt,
          budgetTokens,
        })
      : renderMemory(composedMemory)

    const plan = session === undefined
      ? undefined
      : this.#store.getLatestTaskCollaborationPlanForSession?.(session.id)
    const taskContext = plan === undefined || session === undefined
      ? undefined
      : composeTaskContextLayer(session, plan, input.employee.id, composedMemory?.retrievedMemories)

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
      ...(composedMemory === undefined
        ? {}
        : { memoryIndex: composedMemory.memoryIndex, retrievedMemories: composedMemory.retrievedMemories }),
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
        unrememberedRawEntryCount: window.unrememberedRawEntryCount,
        hydratedMemoryCount: hydration?.memoryCount ?? 0,
        hydratedSourceMessageCount: hydration?.messageCount ?? 0,
        rawWindowApplied: window.rawWindowApplied,
        fullReplayFallback: window.fullReplayFallback,
      },
    }
  }

  /**
   * The sequences in this conversation that an indexed memory can bring back.
   *
   * `undefined` means the store cannot answer the question at all, and the
   * window then treats every older entry as unrecoverable rather than guessing.
   */
  #rememberedSequences(
    employeeId: string,
    session: WorkSession,
    durableMessages: readonly WorkMessage[] | undefined,
  ): Set<number> | undefined {
    const listIndex = this.#store.listEmployeeMemoryIndex
    if (durableMessages === undefined || listIndex === undefined) return undefined
    const indexed = new Set(
      listIndex
        .call(this.#store, employeeId, visibleMemoryScopes(session), MAX_COVERAGE_MEMORIES)
        .flatMap((entry) => entry.sourceMessageIds),
    )
    const sequences = new Set<number>()
    for (const message of durableMessages) {
      if (indexed.has(message.id)) sequences.add(message.sequence)
    }
    return sequences
  }
}

/** Durable message ids behind the entries this turn is already replaying raw. */
function rawWindowMessageIds(
  durableMessages: readonly WorkMessage[] | undefined,
  recentHistory: readonly ConversationHistoryEntry[],
): string[] {
  if (durableMessages === undefined || recentHistory.length === 0) return []
  const sequences = new Set(recentHistory.map((entry) => entry.sequence))
  return durableMessages.filter((message) => sequences.has(message.sequence)).map((message) => message.id)
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
  /** Sequences an indexed memory can bring back; `undefined` when unknown. */
  rememberedSequences?: Set<number> | undefined
}): {
  startIndex: number
  unrememberedRawEntryCount: number
  rawWindowApplied: boolean
  fullReplayFallback: boolean
} {
  // Not migrated yet, not a fallback: these lanes still replay in full by design.
  if (input.lane !== 'direct') {
    return { startIndex: 0, unrememberedRawEntryCount: 0, rawWindowApplied: false, fullReplayFallback: false }
  }
  // Retrieval covered nothing, so full replay is the only thing that can still
  // answer a question about an older turn.
  if (input.retrievedMemoryCount === 0) {
    return { startIndex: 0, unrememberedRawEntryCount: 0, rawWindowApplied: false, fullReplayFallback: true }
  }

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
  if (start === 0) {
    return { startIndex: 0, unrememberedRawEntryCount: 0, rawWindowApplied: true, fullReplayFallback: false }
  }

  // A turn that produced no completed AgentRun - it failed, it was interrupted
  // or aborted, or the owner spoke and never got a reply - is never written to
  // `employee_milestones` and therefore never indexed. Retrieval can bring back
  // an indexed episode; it can never bring back one that does not exist. So an
  // entry nothing remembers must not be dropped, or it becomes permanently
  // invisible, which full replay never was.
  //
  // The window is widened to the earliest such entry rather than splicing the
  // survivors together: a conversation with holes in it reads as a different
  // conversation. In the worst case that degenerates to exactly today's full
  // replay, which is the honest floor - the rule can lose compaction, never a turn.
  let unrememberedRawEntryCount = 0
  let earliestUnremembered = -1
  for (let index = 0; index < start; index += 1) {
    if (input.rememberedSequences?.has(input.history[index]!.sequence) === true) continue
    if (earliestUnremembered < 0) earliestUnremembered = index
    unrememberedRawEntryCount += 1
  }
  if (earliestUnremembered >= 0) start = earliestUnremembered

  // A positive cursor means this character already holds a durable position in
  // the conversation, and everything after it is genuinely new to it. That set
  // is bounded by ordinary conversation flow, so it is always kept raw. A zero
  // cursor means the character never spoke here, which is exactly the case the
  // window exists to bound.
  if (input.observedThroughSequence > 0) {
    const firstUnobserved = input.history.findIndex((entry) => entry.sequence > input.observedThroughSequence)
    if (firstUnobserved >= 0) start = Math.min(start, firstUnobserved)
  }
  return { startIndex: start, unrememberedRawEntryCount, rawWindowApplied: true, fullReplayFallback: false }
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
 *
 * Trimming re-renders the surviving hits instead of slicing rendered lines.
 * Slicing looked equivalent and was not: the retrieved layer's source refs are
 * one memory ref per hit followed by its message and artifact refs, so cutting
 * the ref list to the number of surviving lines threw away every pointer back
 * to the durable rows - the very thing that lets a memory be relocated.
 */
function withinBudget(
  employeeId: string,
  layers: MemoryContextLayers,
  budgetTokens: number,
): MemoryContextLayers | undefined {
  if (layers.hits.length === 0) return undefined
  for (let kept = layers.hits.length; kept >= 1; kept -= 1) {
    const hits = layers.hits.slice(0, kept)
    const candidate: MemoryContextLayers = { ...composeMemoryLayers(employeeId, hits), hits }
    if (estimateTextTokens(renderMemory(candidate)) <= budgetTokens) return candidate
  }
  return undefined
}

/**
 * Folds recovered source messages into the retrieved-memory layer.
 *
 * Hydration is not a new layer: it is the same retrieved memories, described
 * more faithfully. Keeping it inside `retrieved-memories` means it travels
 * with the same budget, the same ordering and the same source refs.
 */
function withHydratedSources(
  layers: MemoryContextLayers,
  hydration: MemorySourceHydration,
): MemoryContextLayers {
  return {
    memoryIndex: layers.memoryIndex,
    hits: layers.hits,
    retrievedMemories: composeContextLayer({
      id: layers.retrievedMemories.id,
      kind: 'retrieved-memories',
      text: `${layers.retrievedMemories.text}\n${hydration.text}`,
      sourceRefs: [...layers.retrievedMemories.sourceRefs, ...hydration.sourceRefs],
    }),
  }
}

function countMemoryRefs(layer: ContextLayer): number {
  return layer.sourceRefs.filter((ref) => ref.kind === 'memory').length
}

function normalizeBudget(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 128 ? Math.min(16_384, value!) : DEFAULT_MEMORY_BUDGET_TOKENS
}
