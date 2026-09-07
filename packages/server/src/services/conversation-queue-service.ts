import { randomUUID } from 'node:crypto'

import type {
  ConversationQueueEntry,
  ConversationQueueEntryStatus,
  WorkTurn,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import {
  AgentTurnFailedError,
  type ConversationControlEnvelope,
  type ConversationOrchestrator,
  type ConversationResult,
  type GroupConversationInput,
} from '@dsh-cyber/orchestration'
import type { TurnAwareApprovalContinuationService, TurnAwareDirectInput } from './turn-aware-approval-continuation-service.js'

type QueueStore = Pick<SqliteStore,
  | 'listWorkspaces'
  | 'listWorlds'
  | 'getConversationQueueEntry'
  | 'listConversationQueue'
  | 'enqueueConversationTurn'
  | 'enqueueNextConversationTurn'
  | 'claimConversationQueueEntry'
  | 'renewConversationQueueLease'
  | 'recoverConversationQueueLeases'
  | 'waitConversationQueueEntryForApproval'
  | 'resumeConversationQueueEntryAfterApproval'
  | 'completeConversationQueueEntry'
  | 'failConversationQueueEntry'
  | 'interruptConversationQueueEntry'
  | 'removeConversationQueueEntry'
  | 'clearConversationQueue'
  | 'getWorkTurn'
  | 'getSession'
  | 'listWorkTurnsByStatus'
  | 'listMessages'
  | 'interruptWorkTurn'
  | 'promoteConversationQueueEntry'
> & {
  getConversationQueueEntryByWorkTurn?: (worldId: string, workTurnId: string) => ConversationQueueEntry | undefined
  getConversationQueueEntryByTurn?: (worldId: string, workTurnId: string) => ConversationQueueEntry | undefined
  getWorkTurnByClientTurnId?: (workspaceId: string, worldId: string, clientTurnId: string) => WorkTurn | undefined
}

export interface ConversationQueueServiceOptions {
  store: QueueStore
  orchestrator: ConversationOrchestrator
  continuations?: TurnAwareApprovalContinuationService
  /** Provider-neutral runner seam for tests or future group/task continuations. */
  runner?: (entry: ConversationQueueEntry) => Promise<{ waitingForApproval?: boolean } | void>
  pollIntervalMs?: number
  leaseDurationMs?: number
  leaseOwner?: string
  /** Maximum time to let local runners settle during shutdown. */
  closeDrainTimeoutMs?: number
  /** Maximum time to wait for the runtime abort before recording a stop fact. */
  stopTimeoutMs?: number
  /** Maximum wait before a queued entry outranks newer priority inserts. */
  priorityAgingThresholdMs?: number
  /** Test seam for durable queue aging decisions. */
  clock?: () => number
  onSettled?: (entry: ConversationQueueEntry) => void | Promise<void>
}

export interface ConversationQueueRunResult {
  entry?: ConversationQueueEntry
  workTurn?: WorkTurn
  waitingForApproval?: boolean
  control?: ConversationControlEnvelope
}

export interface QueuedDirectServiceResult {
  session: ConversationResult['session']
  workTurnId: string
  queueEntry: ConversationQueueEntry
  queueItem: ConversationQueueEntry
  status: 'queued'
}

export type QueuedGroupServiceResult = QueuedDirectServiceResult

/**
 * Durable queue dispatcher for conversation WorkTurns.
 *
 * Queue state is owned by SQLite; the in-memory set only prevents this
 * process from claiming the same entry twice. A restart therefore discovers
 * queued rows again and runs the original WorkTurn/user message rather than
 * constructing a replacement conversation.
 *
 * For groups, `employeeIds` on the queue row is the planned reservation set,
 * not the whole room membership. The complete member list remains durable on
 * WorkSession + the user message metadata. This means an idle observer in a
 * ten-person room cannot block a turn that only needs one engineer.
 */
export class ConversationQueueService implements AsyncDisposable {
  readonly #store: QueueStore
  readonly #orchestrator: ConversationOrchestrator
  readonly #continuations: TurnAwareApprovalContinuationService | undefined
  readonly #runner: ((entry: ConversationQueueEntry) => Promise<{ waitingForApproval?: boolean } | void>) | undefined
  readonly #active = new Set<string>()
  readonly #pollIntervalMs: number
  readonly #leaseDurationMs: number
  readonly #leaseOwner: string
  readonly #closeDrainTimeoutMs: number
  readonly #stopTimeoutMs: number
  readonly #priorityAgingThresholdMs: number
  readonly #clock: () => number
  readonly #onSettled: ConversationQueueServiceOptions['onSettled']
  readonly #activeRuns = new Map<string, Promise<void>>()
  #timer: NodeJS.Timeout | undefined
  #wakeTimer: NodeJS.Timeout | undefined
  #dispatching = false
  #closed = false
  #closePromise: Promise<void> | undefined

  constructor(options: ConversationQueueServiceOptions) {
    if (options.runner === undefined && options.continuations === undefined) {
      throw new Error('Conversation queue requires a durable turn runner')
    }
    this.#store = options.store
    this.#orchestrator = options.orchestrator
    this.#continuations = options.continuations
    this.#runner = options.runner
    this.#pollIntervalMs = Math.max(250, Math.floor(options.pollIntervalMs ?? 2_000))
    this.#leaseDurationMs = Math.max(1_000, Math.floor(options.leaseDurationMs ?? 30_000))
    this.#leaseOwner = options.leaseOwner?.trim() || `conversation-worker-${randomUUID()}`
    this.#closeDrainTimeoutMs = boundedTimeout(options.closeDrainTimeoutMs, 5_000)
    this.#stopTimeoutMs = boundedTimeout(options.stopTimeoutMs, 5_000)
    this.#priorityAgingThresholdMs = boundedTimeout(options.priorityAgingThresholdMs, 30_000)
    this.#clock = options.clock ?? Date.now
    this.#onSettled = options.onSettled
  }

  enqueue(input: Parameters<QueueStore['enqueueConversationTurn']>[0]): ConversationQueueEntry {
    const entry = this.#store.enqueueConversationTurn(input)
    this.wake()
    return entry
  }

  enqueueNext(input: Parameters<QueueStore['enqueueNextConversationTurn']>[0]): ConversationQueueEntry {
    const entry = this.#store.enqueueNextConversationTurn(input)
    this.wake()
    return entry
  }

  enqueueDirect(input: TurnAwareDirectInput, next = false): QueuedDirectServiceResult {
    if (this.#continuations === undefined) throw new Error('Queued direct continuation is unavailable')
    const clientTurnId = stringMetadata(input.metadata, 'clientTurnId')
    const existingByClient = clientTurnId === undefined
      ? undefined
      : this.#store.getWorkTurnByClientTurnId?.(input.workspaceId, input.worldId, clientTurnId)
    if (existingByClient !== undefined) {
      const session = this.#store.getSession(existingByClient.sessionId)
      const existingEntry = this.#entryForTurn(input.worldId, existingByClient.id)
      if (session !== undefined && existingEntry !== undefined) {
        const entry = next && existingEntry.status === 'queued' ? this.promote(existingEntry.id, existingEntry.revision) : existingEntry
        return { session, workTurnId: existingByClient.id, queueEntry: entry, queueItem: entry, status: 'queued' }
      }
      if (session !== undefined && existingByClient.status === 'queued') {
        const queueEntry = next
          ? this.enqueueNext(this.#queueInput(input, session, existingByClient.id))
          : this.enqueue(this.#queueInput(input, session, existingByClient.id))
        return { session, workTurnId: existingByClient.id, queueEntry, queueItem: queueEntry, status: 'queued' }
      }
    }
    if (input.sessionId !== undefined && clientTurnId !== undefined) {
      const session = this.#store.getSession(input.sessionId)
      const existingMessage = session === undefined
        ? undefined
        : this.#store.listMessages(session.id).find((message) => message.kind === 'user' && stringMetadata(message.metadata, 'clientTurnId') === clientTurnId)
      const existingWorkTurnId = stringMetadata(existingMessage?.metadata, 'workTurnId')
      if (session !== undefined && existingMessage !== undefined && existingWorkTurnId !== undefined) {
        const existingEntry = this.#entryForTurn(session.worldId, existingWorkTurnId)
        if (existingEntry !== undefined) {
          const entry = next && existingEntry.status === 'queued' ? this.promote(existingEntry.id, existingEntry.revision) : existingEntry
          return { session, workTurnId: existingWorkTurnId, queueEntry: entry, queueItem: entry, status: 'queued' }
        }
        const existingTurn = this.#store.getWorkTurn(existingWorkTurnId)
        if (existingTurn?.status === 'queued') {
          const queueEntry = next
            ? this.enqueueNext(this.#queueInput(input, session, existingWorkTurnId))
            : this.enqueue(this.#queueInput(input, session, existingWorkTurnId))
          return { session, workTurnId: existingWorkTurnId, queueEntry, queueItem: queueEntry, status: 'queued' }
        }
      }
    }
    const queued = this.#continuations.enqueueDirect(input)
    const queueInput = this.#queueInput(input, queued.session, queued.workTurnId)
    const queueEntry = next ? this.enqueueNext(queueInput) : this.enqueue(queueInput)
    return { session: queued.session, workTurnId: queued.workTurnId, queueEntry, queueItem: queueEntry, status: 'queued' }
  }

  enqueueGroup(input: GroupConversationInput, next = false): QueuedGroupServiceResult {
    const clientTurnId = stringMetadata(input.metadata, 'clientTurnId')
    const existingByClient = clientTurnId === undefined
      ? undefined
      : this.#store.getWorkTurnByClientTurnId?.(input.workspaceId, input.worldId, clientTurnId)
    if (existingByClient !== undefined) {
      const session = this.#store.getSession(existingByClient.sessionId)
      const existingEntry = this.#entryForTurn(input.worldId, existingByClient.id)
      if (session !== undefined && existingEntry !== undefined) {
        const entry = next && existingEntry.status === 'queued' ? this.promote(existingEntry.id, existingEntry.revision) : existingEntry
        return { session, workTurnId: existingByClient.id, queueEntry: entry, queueItem: entry, status: 'queued' }
      }
      if (session !== undefined && existingByClient.status === 'queued') {
        const queueEntry = next
          ? this.enqueueNext(this.#groupQueueInput(input, session, existingByClient.id))
          : this.enqueue(this.#groupQueueInput(input, session, existingByClient.id))
        return { session, workTurnId: existingByClient.id, queueEntry, queueItem: queueEntry, status: 'queued' }
      }
    }
    if (input.sessionId !== undefined && clientTurnId !== undefined) {
      const session = this.#store.getSession(input.sessionId)
      const existingMessage = session === undefined
        ? undefined
        : this.#store.listMessages(session.id).find((message) => message.kind === 'user' && stringMetadata(message.metadata, 'clientTurnId') === clientTurnId)
      const existingWorkTurnId = stringMetadata(existingMessage?.metadata, 'workTurnId')
      if (session !== undefined && existingWorkTurnId !== undefined) {
        const existingEntry = this.#entryForTurn(session.worldId, existingWorkTurnId)
        if (existingEntry !== undefined) {
          const entry = next && existingEntry.status === 'queued' ? this.promote(existingEntry.id, existingEntry.revision) : existingEntry
          return { session, workTurnId: existingWorkTurnId, queueEntry: entry, queueItem: entry, status: 'queued' }
        }
      }
    }
    const begun = this.#orchestrator.beginGroupQueued(input)
    const queueInput = this.#groupQueueInput(input, begun.session, begun.workTurn.id)
    const queueEntry = next ? this.enqueueNext(queueInput) : this.enqueue(queueInput)
    return { session: begun.session, workTurnId: begun.workTurn.id, queueEntry, queueItem: queueEntry, status: 'queued' }
  }

  list(worldId: string, sessionId?: string, status?: ConversationQueueEntryStatus): ConversationQueueEntry[] {
    return this.#store.listConversationQueue(worldId, sessionId, status)
  }

  remove(queueEntryId: string, expectedRevision?: number): ConversationQueueEntry {
    return this.#store.removeConversationQueueEntry({
      queueEntryId,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    })
  }

  promote(queueEntryId: string, expectedRevision?: number): ConversationQueueEntry {
    return this.#store.promoteConversationQueueEntry(queueEntryId, expectedRevision)
  }

  clear(worldId: string, workspaceId?: string, sessionId?: string): number {
    return this.#store.clearConversationQueue({
      worldId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    })
  }

  async stop(queueEntryId: string, expectedRevision?: number): Promise<ConversationQueueRunResult> {
    const entry = this.#store.getConversationQueueEntry(queueEntryId)
    if (entry === undefined) throw new Error(`Conversation queue entry not found: ${queueEntryId}`)
    if (entry.status === 'queued') return { entry: this.remove(queueEntryId, expectedRevision) }
    if (entry.status !== 'running' && entry.status !== 'waiting-approval') return { entry }
    if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
      throw new Error('Conversation queue entry changed concurrently')
    }

    // Reconcile a terminal WorkTurn that won the race before the Stop command
    // arrived; never turn a completed/failed turn into a fake interruption.
    const terminalTurn = this.#store.getWorkTurn(entry.workTurnId)
    if (terminalTurn?.status === 'completed') {
      try {
        return { entry: this.#store.completeConversationQueueEntry({ queueEntryId, expectedRevision: entry.revision }) }
      } catch { return { entry } }
    }
    if (terminalTurn?.status === 'failed') {
      try {
        return { entry: this.#store.failConversationQueueEntry({ queueEntryId, expectedRevision: entry.revision, errorCode: terminalTurn.errorCode ?? 'turn-failed' }) }
      } catch { return { entry } }
    }
    if (terminalTurn?.status === 'interrupted') {
      try {
        return { entry: this.#store.interruptConversationQueueEntry({ queueEntryId, expectedRevision: entry.revision, errorCode: terminalTurn.errorCode ?? 'interrupted' }) }
      } catch { return { entry } }
    }

    const interruption = Promise.resolve()
      .then(() => this.#orchestrator.interruptWorkTurn(entry.workTurnId))
    const completed = await settleWithin(interruption, this.#stopTimeoutMs)
    const current = this.#store.getConversationQueueEntry(queueEntryId)
    if (current === undefined) return { entry }
    if (current.status !== 'running' && current.status !== 'waiting-approval') return { entry: current }
    const interrupted = this.#interruptQueueEntryAfterStop(current, completed ? 'interrupted' : 'stop-timeout-unknown-result')
    const workTurn = this.#store.getWorkTurn(entry.workTurnId)
    return { entry: interrupted, ...(workTurn === undefined ? {} : { workTurn }) }
  }

  async stopWorkTurn(workTurnId: string): Promise<ConversationQueueRunResult> {
    const turn = this.#store.getWorkTurn(workTurnId)
    if (turn === undefined) throw new Error(`Work turn not found: ${workTurnId}`)
    const entry = this.#entryForTurn(turn.worldId, workTurnId)
    if (entry !== undefined) return this.stop(entry.id, entry.revision)
    let control: ConversationControlEnvelope | undefined
    const interruption = Promise.resolve()
      .then(() => this.#orchestrator.interruptWorkTurn(workTurnId))
      .then((result) => { control = result })
    const completed = await settleWithin(interruption, this.#stopTimeoutMs)
    let current = this.#store.getWorkTurn(workTurnId)
    if (current !== undefined && ['queued', 'running', 'waiting-approval'].includes(current.status)) {
      try {
        current = this.#store.interruptWorkTurn(workTurnId, completed ? 'interrupted' : 'stop-timeout-unknown-result')
      } catch {
        current = this.#store.getWorkTurn(workTurnId)
      }
    }
    return { ...(current === undefined ? {} : { workTurn: current }), ...(control === undefined ? {} : { control }) }
  }

  start(): void {
    if (this.#closed) return
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => void this.dispatchOnce(), this.#pollIntervalMs)
    this.#timer.unref()
    void this.recover().then(() => this.dispatchOnce()).catch(() => undefined)
  }

  wake(): void {
    if (this.#closed) return
    if (this.#wakeTimer !== undefined) return
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = undefined
      void this.dispatchOnce()
    }, 0)
    this.#wakeTimer.unref()
  }

  async recover(): Promise<{ repaired: number; interrupted: number }> {
    let repaired = 0
    let interrupted = 0
    const queuedTurns = this.#store.listWorkTurnsByStatus('queued')
    for (const turn of queuedTurns) {
      const existing = this.#entryForTurn(turn.worldId, turn.id) !== undefined
      if (existing) continue
      const session = this.#store.getSession(turn.sessionId)
      const message = session === undefined
        ? undefined
        : this.#store.listMessages(session.id).find((item) => item.kind === 'user' && item.metadata.workTurnId === turn.id)
      const employeeIds = queueEmployeeIds(message?.metadata)
      if (session === undefined || employeeIds.length === 0 || session.worldId !== turn.worldId) {
        try { this.#store.interruptWorkTurn(turn.id, 'queued-turn-invalid') } catch { /* another recovery worker won */ }
        interrupted += 1
        continue
      }
      try {
        this.#store.enqueueConversationTurn({
          workspaceId: turn.workspaceId,
          worldId: turn.worldId,
          sessionId: session.id,
          workTurnId: turn.id,
          employeeIds,
          conversationKind: session.kind,
          ...(session.collaborationMode === undefined ? {} : { collaborationMode: session.collaborationMode }),
          ...(queueReasoningEffort(message?.metadata) === undefined ? {} : { reasoningEffort: queueReasoningEffort(message?.metadata) }),
          ...(queuePermissionMode(message?.metadata) === undefined ? {} : { permissionMode: queuePermissionMode(message?.metadata) }),
        })
        repaired += 1
      } catch {
        try { this.#store.interruptWorkTurn(turn.id, 'queued-turn-invalid') } catch { /* another recovery worker won */ }
        interrupted += 1
      }
    }
    return { repaired, interrupted }
  }

  async dispatchOnce(): Promise<number> {
    if (this.#closed || this.#dispatching) return 0
    this.#dispatching = true
    try {
      this.#store.recoverConversationQueueLeases()
      await this.reconcileWaiting()
      const queued = this.#listQueuedEntries()
      const { employeeLoads: loads, occupiedSessions } = this.#durableScheduleState()
      let claimed = 0
      for (const entry of queued) {
        if (this.#active.has(entry.id)) continue
        // A conversation is ordered even when the employee has a second lane
        // available. Only separate conversations may run concurrently.
        if (occupiedSessions.has(entry.sessionId)) continue
        if (entry.employeeIds.some((employeeId) => (loads.get(employeeId) ?? 0) >= 2)) continue
        let claimedEntry: ConversationQueueEntry
        try {
          claimedEntry = this.#store.claimConversationQueueEntry({
            queueEntryId: entry.id,
            expectedRevision: entry.revision,
            leaseOwner: this.#leaseOwner,
            leaseDurationMs: this.#leaseDurationMs,
          })
        } catch {
          continue
        }
        claimed += 1
        this.#active.add(entry.id)
        occupiedSessions.add(entry.sessionId)
        for (const employeeId of entry.employeeIds) loads.set(employeeId, (loads.get(employeeId) ?? 0) + 1)
        this.#trackClaimed(claimedEntry, this.#runClaimed(claimedEntry))
      }
      return claimed
    } finally {
      this.#dispatching = false
    }
  }

  /**
   * Run one already-enqueued entry synchronously for a host-owned producer
   * such as TaskScheduleService. The same durable claim and runner used by
   * the background dispatcher are retained, so a scheduler race can only
   * produce one AgentRun. Waiting approval returns the durable waiting row;
   * the approval continuation owns the later resume.
   */
  async runEntryNow(queueEntryId: string, expectedRevision?: number): Promise<ConversationQueueEntry> {
    const current = this.#store.getConversationQueueEntry(queueEntryId)
    if (current === undefined) throw new Error(`Conversation queue entry not found: ${queueEntryId}`)
    if (this.#closed || current.status !== 'queued') return current
    let claimed: ConversationQueueEntry
    try {
      claimed = this.#store.claimConversationQueueEntry({
        queueEntryId,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        leaseOwner: this.#leaseOwner,
        leaseDurationMs: this.#leaseDurationMs,
      })
    } catch {
      return this.#store.getConversationQueueEntry(queueEntryId) ?? current
    }
    this.#active.add(claimed.id)
    this.#trackClaimed(claimed, this.#runClaimed(claimed))
    const execution = this.#activeRuns.get(claimed.id)
    if (execution !== undefined) await execution
    return this.#store.getConversationQueueEntry(queueEntryId) ?? claimed
  }

  /** Reconcile approval continuations that settle the WorkTurn outside the dispatcher. */
  async reconcileWaiting(): Promise<number> {
    let changed = 0
    for (const workspace of this.#store.listWorkspaces()) {
      for (const world of this.#store.listWorlds(workspace.id, true)) {
        const waiting = this.#store.listConversationQueue(world.id)
          .filter((entry) => entry.status === 'queued' || entry.status === 'waiting-approval' || entry.status === 'running')
        for (const entry of waiting) {
          const turn = this.#store.getWorkTurn(entry.workTurnId)
          if (turn === undefined) continue
          try {
            if (entry.status === 'queued' && turn.status === 'interrupted') {
              this.#store.interruptConversationQueueEntry({ queueEntryId: entry.id, expectedRevision: entry.revision, errorCode: turn.errorCode ?? 'interrupted' })
              changed += 1
            } else if (entry.status === 'running' && turn.status === 'waiting-approval') {
              this.#store.waitConversationQueueEntryForApproval({ queueEntryId: entry.id, expectedRevision: entry.revision })
              changed += 1
            } else if (entry.status === 'waiting-approval' && turn.status === 'running') {
              this.#store.resumeConversationQueueEntryAfterApproval({ queueEntryId: entry.id, expectedRevision: entry.revision })
              changed += 1
            } else if ((entry.status === 'running' || entry.status === 'waiting-approval') && turn.status === 'completed') {
              this.#store.completeConversationQueueEntry({ queueEntryId: entry.id, expectedRevision: entry.revision })
              changed += 1
            } else if ((entry.status === 'running' || entry.status === 'waiting-approval') && turn.status === 'failed') {
              this.#store.failConversationQueueEntry({ queueEntryId: entry.id, expectedRevision: entry.revision, errorCode: turn.errorCode ?? 'turn-failed' })
              changed += 1
            } else if ((entry.status === 'running' || entry.status === 'waiting-approval') && turn.status === 'interrupted') {
              this.#store.interruptConversationQueueEntry({ queueEntryId: entry.id, expectedRevision: entry.revision, errorCode: turn.errorCode ?? 'interrupted' })
              changed += 1
            }
          } catch {
            // A decision, Stop, or recovery worker may have won the CAS.
          }
        }
      }
    }
    return changed
  }

  stopDispatcher(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#wakeTimer !== undefined) clearTimeout(this.#wakeTimer)
    this.#wakeTimer = undefined
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closePromise = this.#closeInternal()
    return this.#closePromise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  async #closeInternal(): Promise<void> {
    this.#closed = true
    this.stopDispatcher()
    const active = [...this.#activeRuns.values()]
    if (active.length === 0) return
    const drained = await drainWithin(active, this.#closeDrainTimeoutMs)
    if (drained) return

    // A runner that did not settle by the shutdown deadline has an unknown
    // provider result. End the durable turn once and leave no queued fact that
    // a later process could replay. The runner may still unwind in the
    // background, but its late result cannot transition an interrupted turn.
    for (const queueEntryId of this.#activeRuns.keys()) {
      const current = this.#store.getConversationQueueEntry(queueEntryId)
      if (current === undefined || (current.status !== 'running' && current.status !== 'waiting-approval')) continue
      try {
        void Promise.resolve()
          .then(() => this.#orchestrator.interruptWorkTurn(current.workTurnId))
          .catch(() => undefined)
        this.#store.interruptConversationQueueEntry({
          queueEntryId: current.id,
          expectedRevision: current.revision,
          errorCode: 'shutdown-timeout-unknown-result',
        })
      } catch {
        // A runtime/controller race may already have written a terminal fact.
      }
    }
  }

  #trackClaimed(entry: ConversationQueueEntry, execution: Promise<void>): void {
    this.#activeRuns.set(entry.id, execution)
    void execution.then(
      () => this.#releaseClaim(entry.id),
      () => this.#releaseClaim(entry.id),
    )
  }

  #releaseClaim(queueEntryId: string): void {
    this.#activeRuns.delete(queueEntryId)
    this.#active.delete(queueEntryId)
    if (!this.#closed) this.wake()
  }

  #interruptQueueEntryAfterStop(entry: ConversationQueueEntry, errorCode: string): ConversationQueueEntry {
    try {
      return this.#store.interruptConversationQueueEntry({
        queueEntryId: entry.id,
        expectedRevision: entry.revision,
        errorCode,
      })
    } catch {
      const latest = this.#store.getConversationQueueEntry(entry.id)
      if (latest === undefined) throw new Error(`Conversation queue entry not found: ${entry.id}`)
      if (latest.status !== 'running' && latest.status !== 'waiting-approval') return latest
      throw new Error('Conversation queue entry changed concurrently')
    }
  }

  #listQueuedEntries(): ConversationQueueEntry[] {
    const result: ConversationQueueEntry[] = []
    for (const workspace of this.#store.listWorkspaces()) {
      // Active worlds only: a world archived while turns were still queued
      // must stop being driven. The entries stay queued and resume untouched
      // when the world is restored.
      for (const world of this.#store.listWorlds(workspace.id)) {
        result.push(...this.#store.listConversationQueue(world.id, undefined, 'queued'))
      }
    }
    const now = this.#clock()
    return result.sort((left, right) => {
      const leftAged = hasAged(left, now, this.#priorityAgingThresholdMs)
      const rightAged = hasAged(right, now, this.#priorityAgingThresholdMs)
      // Once an entry reaches the maximum wait, durable FIFO order wins over
      // all newer priority inserts. This places a finite bound on `next`
      // bursts without weakening their short-lived interactive semantics.
      if (leftAged !== rightAged) return leftAged ? -1 : 1
      if (leftAged) return left.enqueuedAt.localeCompare(right.enqueuedAt) || left.id.localeCompare(right.id)
      return right.priority - left.priority || left.enqueuedAt.localeCompare(right.enqueuedAt) || left.id.localeCompare(right.id)
    })
  }

  #durableScheduleState(): { employeeLoads: Map<string, number>; occupiedSessions: Set<string> } {
    const employeeLoads = new Map<string, number>()
    const occupiedSessions = new Set<string>()
    for (const workspace of this.#store.listWorkspaces()) {
      for (const world of this.#store.listWorlds(workspace.id, true)) {
        for (const entry of this.#store.listConversationQueue(world.id, undefined, 'running')) {
          occupiedSessions.add(entry.sessionId)
          for (const employeeId of entry.employeeIds) employeeLoads.set(employeeId, (employeeLoads.get(employeeId) ?? 0) + 1)
        }
        // Approval releases every employee lane, but the conversation itself
        // remains ordered. A later message in the same session must not pass
        // the unresolved turn while other sessions may continue.
        for (const entry of this.#store.listConversationQueue(world.id, undefined, 'waiting-approval')) {
          occupiedSessions.add(entry.sessionId)
        }
      }
    }
    return { employeeLoads, occupiedSessions }
  }

  #entryForTurn(worldId: string, workTurnId: string): ConversationQueueEntry | undefined {
    return this.#store.getConversationQueueEntryByWorkTurn?.(worldId, workTurnId)
      ?? this.#store.getConversationQueueEntryByTurn?.(worldId, workTurnId)
      ?? this.#store.listConversationQueue(worldId).find((entry) => entry.workTurnId === workTurnId)
  }

  #queueInput(input: TurnAwareDirectInput, session: ConversationResult['session'], workTurnId: string) {
    return {
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      workTurnId,
      employeeIds: [input.employeeId],
      conversationKind: 'direct' as const,
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    }
  }

  #groupQueueInput(input: GroupConversationInput, session: ConversationResult['session'], workTurnId: string) {
    return {
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      workTurnId,
      employeeIds: queueReservationEmployeeIds(input.metadata, input.employeeIds),
      conversationKind: 'group' as const,
      collaborationMode: input.collaborationMode ?? session.collaborationMode ?? 'discussion',
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    }
  }

  async #runClaimed(entry: ConversationQueueEntry): Promise<void> {
    const renewal = setInterval(() => {
      try { this.#store.renewConversationQueueLease(entry.id, this.#leaseOwner, this.#leaseDurationMs) } catch { /* settlement or recovery won */ }
    }, Math.max(250, Math.floor(this.#leaseDurationMs / 3)))
    renewal.unref()
    try {
      const customRunner = this.#runner
      const result = customRunner !== undefined
        ? await customRunner(entry)
        : this.#continuations === undefined
          ? undefined
          : await this.#continuations.runQueuedDirect(entry.workTurnId)
      if (customRunner === undefined && result === undefined) throw new Error('Queued WorkTurn could not be resumed')
      if (result?.waitingForApproval === true) {
        const current = this.#store.getConversationQueueEntry(entry.id)
        if (current !== undefined && current.status === 'running') {
          this.#store.waitConversationQueueEntryForApproval({
            queueEntryId: entry.id,
            expectedRevision: current.revision,
          })
        }
        return
      }
      const current = this.#store.getConversationQueueEntry(entry.id)
      if (current?.status !== 'running') return
      this.#store.completeConversationQueueEntry({
        queueEntryId: entry.id,
        expectedRevision: current.revision,
      })
    } catch (error) {
      try {
        const current = this.#store.getConversationQueueEntry(entry.id)
        if (current === undefined || current.status !== 'running') return
        this.#store.failConversationQueueEntry({
          queueEntryId: entry.id,
          expectedRevision: current.revision,
          errorCode: queueFailureCode(error),
        })
      } catch {
        // A Stop/cancel/recovery transition won the durable race.
      }
    } finally {
      clearInterval(renewal)
      try { await this.#onSettled?.(entry) } catch { /* projections never replace the durable turn result */ }
    }
  }
}

function queueFailureCode(error: unknown): string {
  if (error instanceof AgentTurnFailedError) return `runtime-${error.failureKind}`
  return error instanceof Error ? error.message.slice(0, 120) || 'queue-run-failed' : 'queue-run-failed'
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value))
}

function hasAged(entry: ConversationQueueEntry, now: number, thresholdMs: number): boolean {
  const enqueuedAt = Date.parse(entry.enqueuedAt)
  return Number.isFinite(enqueuedAt) && now - enqueuedAt >= thresholdMs
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    void promise.catch(() => undefined)
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (completed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(completed)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void promise.then(() => finish(true), () => finish(true))
  })
}

function drainWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return Promise.resolve(true)
  if (timeoutMs <= 0) {
    void Promise.allSettled(promises)
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (drained: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(drained)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void Promise.allSettled(promises).then(() => finish(true))
  })
}

function queueEmployeeIds(metadata: Record<string, unknown> | undefined): string[] {
  const single = metadata?.queueEmployeeId
  if (typeof single === 'string' && single.trim()) return [single.trim()]
  const reserved = stringArrayMetadata(metadata, 'reservationEmployeeIds')
  if (reserved.length > 0) return reserved
  return stringArrayMetadata(metadata, 'participantIds')
}

function queueReservationEmployeeIds(metadata: Record<string, unknown> | undefined, fallback: readonly string[]): string[] {
  const reserved = stringArrayMetadata(metadata, 'reservationEmployeeIds')
  return reserved.length > 0 ? reserved : [...new Set(fallback.map((value) => value.trim()).filter(Boolean))]
}

function stringArrayMetadata(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const value = metadata?.[key]
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim()))]
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function queuePermissionMode(metadata: Record<string, unknown> | undefined): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  const value = metadata?.permissionMode
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access' ? value : undefined
}

function queueReasoningEffort(metadata: Record<string, unknown> | undefined): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const value = metadata?.reasoningEffort
  return value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' ? value : undefined
}
