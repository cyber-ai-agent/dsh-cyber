import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  AgentTurnResult,
  JsonObject,
  WorkMessage,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

const OBSERVED_THROUGH_KEY = 'contextObservedThroughSequence'
const OBSERVATION_VERSION_KEY = 'contextObservationVersion'

/**
 * Corrects a subtle group-chat continuity bug without coupling the runtime to
 * the group planner.
 *
 * The legacy caller approximates what a character has seen by using the
 * sequence of that character's own latest reply. In a concurrent wave A and B
 * start from the same snapshot; if B commits first and A commits second, A's
 * own message has the later sequence even though A never saw B. Treating that
 * sequence as an observation cursor silently drops B from A's next context.
 *
 * This wrapper stores the *input snapshot* on the assistant message metadata.
 * On the next turn it restores that durable cursor and asks the Harness layer
 * to replay everything after it. Under-counting is intentionally preferred to
 * over-counting: a later-wave statement may be replayed twice, but a peer's
 * fact is never skipped.
 */
export class EmployeeObservationRuntime implements AgentRuntimePort {
  readonly #inner: AgentRuntimePort
  readonly #store: Pick<SqliteStore, 'listMessages'>

  constructor(inner: AgentRuntimePort, store: Pick<SqliteStore, 'listMessages'>) {
    this.#inner = inner
    this.#store = store
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const messages = this.#store.listMessages(request.conversationId)
    const durableObserved = lastDurableObservation(messages, request.agent.id)
    const snapshotSequence = contextSnapshotSequence(messages, request)
    let sawAssistantMessage = false

    const originalOnEvent = request.onEvent
    const onEvent = originalOnEvent === undefined
      ? undefined
      : (event: AgentRuntimeEvent) => {
          if (event.kind === 'assistant.message' && event.content?.trim()) sawAssistantMessage = true
          originalOnEvent(withObservation(event, snapshotSequence))
        }

    const result = await this.#inner.runTurn({
      ...request,
      observedThroughSequence: durableObserved ?? request.observedThroughSequence,
      ...(onEvent === undefined ? {} : { onEvent }),
    })

    // Some providers only expose a final response and never emit an assembled
    // assistant.message notification. Emit one host-owned assembled event so
    // the orchestrator persists both the answer and the observation cursor in
    // one normal completion transaction. It is suppressed when the provider
    // already emitted an assistant message.
    if (!sawAssistantMessage && result.finalResponse.trim() && originalOnEvent !== undefined) {
      originalOnEvent({
        kind: 'assistant.message',
        source: 'host-context-observation',
        sourceSessionId: result.agentSessionId,
        content: result.finalResponse,
        metadata: observationMetadata({}, snapshotSequence),
      })
    }

    return result
  }

  abortRun(agentRunId: string): Promise<void> {
    return this.#inner.abortRun?.(agentRunId) ?? Promise.resolve()
  }

  decideApproval(agentRunId: string, approvalRequestId: string, decision: 'approved' | 'rejected'): Promise<void> {
    return this.#inner.decideApproval?.(agentRunId, approvalRequestId, decision)
      ?? Promise.reject(new Error('当前运行时未提供动作审批能力'))
  }

  closeAgent(agentId: string): Promise<void> {
    return this.#inner.closeAgent?.(agentId) ?? Promise.resolve()
  }

  close(): Promise<void> {
    return this.#inner.close()
  }
}

export function lastDurableObservation(messages: readonly WorkMessage[], employeeId: string): number | undefined {
  let latestMessageSequence = -1
  let observed: number | undefined
  for (const message of messages) {
    if (message.kind !== 'assistant' || message.senderId !== employeeId) continue
    const value = numberMetadata(message.metadata, OBSERVED_THROUGH_KEY)
    if (value === undefined || message.sequence < latestMessageSequence) continue
    latestMessageSequence = message.sequence
    observed = value
  }
  return observed
}

/**
 * The live request is explicitly supplied outside recovered history, so the
 * current user message is part of the snapshot the character observes. The
 * workTurn id is the stable boundary that excludes same-wave replies which may
 * race into SQLite before another runtime process actually starts.
 */
export function contextSnapshotSequence(messages: readonly WorkMessage[], request: AgentTurnRequest): number {
  if (request.workTurnId !== undefined) {
    const current = messages
      .filter((message) => message.kind === 'user' && message.metadata.workTurnId === request.workTurnId)
      .reduce<WorkMessage | undefined>((latest, message) => latest === undefined || message.sequence > latest.sequence ? message : latest, undefined)
    if (current !== undefined) return current.sequence
  }
  return request.history.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0)
}

function withObservation(event: AgentRuntimeEvent, sequence: number): AgentRuntimeEvent {
  return {
    ...event,
    metadata: observationMetadata(event.metadata, sequence),
  }
}

function observationMetadata(metadata: JsonObject, sequence: number): JsonObject {
  return {
    ...metadata,
    [OBSERVED_THROUGH_KEY]: sequence,
    [OBSERVATION_VERSION_KEY]: 1,
  }
}

function numberMetadata(metadata: JsonObject, key: string): number | undefined {
  const value = metadata[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
