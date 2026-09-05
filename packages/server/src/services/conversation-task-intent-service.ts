import type { JsonObject, WorkTask } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { ConversationTaskIntentPort, ConversationTaskProposal } from './conversation-task-intent-classifier.js'
import { ServiceError } from './service-error.js'
import type { WorkSystemService } from './work-system-service.js'

/**
 * The one place a conversation turn can become a task.
 *
 * Split in two on purpose. `propose` starts the classification at ingress,
 * before the characters run, so the decision overlaps the turn instead of
 * being charged to it; `attach` records the answer once the turn owns an id.
 * Between them the host has learned nothing it can act on — a proposal is a
 * suggestion until a real WorkTurn exists to own it.
 *
 * Both are total. A classification outage, a refused answer, a world that
 * archived mid-turn: each ends with no task and, where the owner already looks
 * for execution failures, one trace entry saying so. Neither call ever throws,
 * because the conversation turn is not allowed to fail over this.
 *
 * Recording is all this does. The draft is created through the Work System's
 * own idempotent `createFromSource`, and running it stays an explicit action:
 * no queue is touched, no Run is started, no second executor exists.
 */

export type ConversationTaskIntentOutcome =
  | { kind: 'none' }
  | { kind: 'proposed'; proposal: ConversationTaskProposal }
  | { kind: 'failed'; code: string; message: string }

export interface ConversationTaskIntentServiceOptions {
  store: Pick<SqliteStore, 'appendDomainEvent'>
  work: Pick<WorkSystemService, 'createFromSource'>
  classifier: ConversationTaskIntentPort
  /** Wakes an open task list. Optional so the service works headless. */
  runtime?: { publishTaskChanged(worldId: string, payload: JsonObject): void }
}

export class ConversationTaskIntentService {
  readonly #store: ConversationTaskIntentServiceOptions['store']
  readonly #work: ConversationTaskIntentServiceOptions['work']
  readonly #classifier: ConversationTaskIntentPort
  readonly #runtime: ConversationTaskIntentServiceOptions['runtime']

  constructor(options: ConversationTaskIntentServiceOptions) {
    this.#store = options.store
    this.#work = options.work
    this.#classifier = options.classifier
    this.#runtime = options.runtime
  }

  /** Asks whether this message is an instruction. Never throws. */
  async propose(input: { workspaceId: string; worldId: string; prompt: string }): Promise<ConversationTaskIntentOutcome> {
    try {
      const proposal = await this.#classifier.classify(input)
      return proposal === undefined ? { kind: 'none' } : { kind: 'proposed', proposal }
    } catch (error) {
      return {
        kind: 'failed',
        code: error instanceof ServiceError ? error.code : 'work_task_intent_unreachable',
        message: error instanceof Error ? error.message : '任务意图判定失败。',
      }
    }
  }

  /**
   * Records the proposal against the turn that asked for it, and returns the
   * task the owner will see. Never throws.
   *
   * A turn owns at most one task, so a resend, the pass after a restart and a
   * retry of the same turn all land on the row that already exists — with the
   * title and status it has now, not the ones this classification produced.
   * Only the create announces itself: a replay changed nothing, so it publishes
   * nothing and records nothing.
   */
  attach(
    outcome: ConversationTaskIntentOutcome,
    input: { workspaceId: string; worldId: string; workTurnId: string; sessionId?: string },
  ): WorkTask | undefined {
    if (outcome.kind === 'none') return undefined
    if (outcome.kind === 'failed') {
      this.#record(input, 'work.task.proposal.failed', { code: outcome.code, reason: outcome.message })
      return undefined
    }
    try {
      const result = this.#work.createFromSource({
        worldId: input.worldId,
        workTurnId: input.workTurnId,
        title: outcome.proposal.title,
        description: outcome.proposal.description,
        priority: outcome.proposal.priority,
      })
      if (!result.created) return result.task
      this.#record(input, 'work.task.proposed', { taskId: result.task.id, title: result.task.title, priority: result.task.priority })
      this.#runtime?.publishTaskChanged(input.worldId, { taskId: result.task.id, status: result.task.status, source: 'conversation' })
      return result.task
    } catch (error) {
      this.#record(input, 'work.task.proposal.failed', {
        code: error instanceof ServiceError ? error.code : 'work_task_intent_record_failed',
        reason: error instanceof Error ? error.message : '任务记录失败。',
      })
      return undefined
    }
  }

  #record(
    input: { workspaceId: string; worldId: string; workTurnId: string; sessionId?: string },
    type: 'work.task.proposed' | 'work.task.proposal.failed',
    payload: JsonObject,
  ): void {
    try {
      this.#store.appendDomainEvent({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        type,
        actorId: 'owner',
        actorKind: 'owner',
        correlationId: input.workTurnId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        payload: { ...payload, workTurnId: input.workTurnId },
      })
    } catch {
      // The trace is an auxiliary read model. Losing one entry must not cost
      // the task that was already recorded, nor the conversation turn.
    }
  }
}
