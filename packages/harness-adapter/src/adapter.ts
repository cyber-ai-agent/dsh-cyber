import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import { DeepSeekHarness, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type {
  AgentRuntimeEvent,
  AgentPermissionMode,
  AgentRuntimePort,
  AgentTurnRequest,
  AgentTurnResult,
  ConversationHistoryEntry,
  EmployeeInstance,
  EmployeeRevision,
  JsonObject,
  ModelTokenUsage,
} from '@dsh-cyber/contracts'

import { formatRecoveredHistoryPrompt, unseenHistory } from './history-prompt.js'
import {
  ensureHarnessProfile,
  resolveDshBin,
  WORKER_PROFILE_NAME,
  type HarnessProviderProfile,
  type HarnessProfilePaths,
} from './profile.js'

export interface EmployeeTurnRequest {
  employee: EmployeeInstance
  revision: EmployeeRevision
  /** Durable WorkSession id. Every conversation owns its own Harness session. */
  conversationId: string
  /** User-visible history of `conversationId`, oldest first, without this turn. */
  history: ConversationHistoryEntry[]
  /** Sequence of this employee's own last statement in the conversation, or 0. */
  observedThroughSequence: number
  /** Durable AgentRun used to target one runtime lane for interruption. */
  agentRunId?: string
  prompt: string
  workspacePath: string
  permissionMode?: AgentPermissionMode
  onNotification?: (notification: HarnessNotification) => void
}

export interface EmployeeTurnResult {
  agentSessionId: string
  finalResponse: string
  notifications: HarnessNotification[]
}

export interface HarnessRuntime {
  run(
    sessionId: string,
    prompt: string,
    onNotification?: (notification: HarnessNotification) => void,
  ): Promise<{ finalResponse: string; notifications: HarnessNotification[] }>
  decideApproval?(approvalRequestId: string, decision: 'approved' | 'rejected'): Promise<void>
  close(): Promise<void>
}

export interface HarnessRuntimeSpec {
  employee: EmployeeInstance
  revision: EmployeeRevision
  profile: HarnessProfilePaths
  workspacePath: string
  sessionsRoot: string
  permissionMode: AgentPermissionMode
  /** Provider-neutral lane identity; never inferred from employeeSessionId. */
  conversationId?: string
  laneId?: string
}

export type HarnessRuntimeFactory = (spec: HarnessRuntimeSpec) => HarnessRuntime

/** One employee's bounded pool of independent conversation runtime lanes. */
interface LaneTask {
  request: EmployeeTurnRequest
  resolve: (result: EmployeeTurnResult) => void
  reject: (error: unknown) => void
  aborted: boolean
}

interface EmployeeLane {
  id: string
  conversationId: string
  permissionMode: AgentPermissionMode | undefined
  /** The directory this lane's runtime was started in. */
  workspacePath: string | undefined
  runtime: HarnessRuntime | undefined
  agentSessionId: string | undefined
  current: LaneTask | undefined
  pending: LaneTask[]
  lastUsed: number
}

interface EmployeeWorker {
  lanes: Map<string, EmployeeLane>
  waiting: LaneTask[]
  closingLanes: number
  closed: boolean
}

interface RunTaskRecord {
  task: LaneTask
  worker: EmployeeWorker
  lane: EmployeeLane | undefined
}

const MAX_ACTIVE_LANES_PER_EMPLOYEE = 2

export interface HarnessAdapterOptions {
  stateRoot: string
  runtimeFactory?: HarnessRuntimeFactory
  inheritedEnvironment?: NodeJS.ProcessEnv
  nodeExecutable?: string
  provider?: string
  model?: string
  providerProfile?: HarnessProviderProfile
  dshBinPath?: string
}

export class HarnessCompatibilityAdapter implements AgentRuntimePort, AsyncDisposable {
  readonly #options: HarnessAdapterOptions
  readonly #runtimes = new Map<string, EmployeeWorker>()
  readonly #activeRuns = new Map<string, { lane: EmployeeLane; task: LaneTask }>()
  readonly #runTasks = new Map<string, RunTaskRecord>()
  #profile: Promise<HarnessProfilePaths> | undefined

  constructor(options: HarnessAdapterOptions) {
    this.#options = options
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const employeeRequest: EmployeeTurnRequest = {
      employee: request.agent,
      revision: request.revision,
      conversationId: request.conversationId,
      history: request.history,
      observedThroughSequence: request.observedThroughSequence,
      ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
      prompt: request.prompt,
      workspacePath: request.workspacePath,
      ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
    }
    if (request.onEvent !== undefined) {
      employeeRequest.onNotification = (notification) => {
        for (const event of normalizeHarnessNotification(notification)) {
          request.onEvent?.(event)
        }
      }
    }
    const result = await this.runEmployeeTurn(employeeRequest)
    const tokenUsage = extractHarnessTokenUsage(result.notifications)
    return {
      agentSessionId: result.agentSessionId,
      finalResponse: result.finalResponse,
      eventCount: result.notifications.length,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    }
  }

  async runEmployeeTurn(request: EmployeeTurnRequest): Promise<EmployeeTurnResult> {
    const conversationId = requiredConversationId(request.conversationId)
    const worker = this.#runtimes.get(request.employee.id) ?? this.#createWorker(request.employee.id)
    const existingLane = worker.lanes.get(conversationId)
    return new Promise<EmployeeTurnResult>((resolvePromise, rejectPromise) => {
      const task: LaneTask = {
        request,
        resolve: resolvePromise,
        reject: rejectPromise,
        aborted: false,
      }
      if (existingLane !== undefined) {
        existingLane.pending.push(task)
        existingLane.lastUsed = Date.now()
        if (request.agentRunId !== undefined) this.#runTasks.set(request.agentRunId, { task, worker, lane: existingLane })
        this.#pumpLane(worker, existingLane)
        return
      }
      if (request.agentRunId !== undefined) this.#runTasks.set(request.agentRunId, { task, worker, lane: undefined })
      this.#scheduleNewLane(worker, task, conversationId)
    })
  }

  async decideApproval(agentRunId: string, approvalRequestId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const active = this.#activeRuns.get(agentRunId)
    if (active?.lane.runtime?.decideApproval === undefined) {
      throw new Error('审批对应的运行回合已经结束')
    }
    await active.lane.runtime.decideApproval(approvalRequestId, decision)
  }

  async #runEmployeeTurnExclusive(
    request: EmployeeTurnRequest,
    conversationId: string,
    lane: EmployeeLane,
    task: LaneTask,
  ): Promise<EmployeeTurnResult> {
    const profile = await this.#getProfile()
    assertLaneTaskActive(task)
    const permissionMode = request.permissionMode ?? 'read-only'
    const workspacePath = resolve(request.workspacePath)
    // The cwd is fixed when the runtime process starts, so a lane that keeps
    // running after the owner revokes a file permission would keep the
    // directory it was given. Both halves of the sandbox have to invalidate
    // the lane, not just the permission mode.
    if (
      (lane.permissionMode !== undefined && lane.permissionMode !== permissionMode) ||
      (lane.workspacePath !== undefined && lane.workspacePath !== workspacePath)
    ) {
      // Permission is lane-local. Changing a private chat from read-only to
      // workspace-write must not tear down the same employee's group lane.
      await lane.runtime?.close()
      lane.runtime = undefined
      lane.agentSessionId = undefined
      assertLaneTaskActive(task)
    }
    if (lane.runtime === undefined) {
      assertLaneTaskActive(task)
      const spec: HarnessRuntimeSpec = {
        employee: request.employee,
        revision: request.revision,
        profile,
        workspacePath,
        sessionsRoot: join(resolve(this.#options.stateRoot), 'harness-sessions', request.employee.id, 'lanes', lane.id),
        permissionMode,
        conversationId,
        laneId: lane.id,
      }
      const runtime = this.#options.runtimeFactory?.(spec) ?? this.#createRuntime(spec)
      if (task.aborted) {
        await runtime.close().catch(() => undefined)
        throw new Error('Employee runtime closed')
      }
      lane.permissionMode = permissionMode
      lane.workspacePath = workspacePath
      lane.runtime = runtime
    }
    // DSH 0.1.1-rc.1 cannot resume a named session whose JSONL log was created
    // by an earlier worker process, and it creates the named session lazily on
    // first append. Every conversation therefore gets a brand-new random id the
    // first time it runs inside this process:
    //
    // - rotating away from any durable id is mandatory (that log belongs to
    //   some other process), and
    // - a deterministic fallback id would collide with the employee's own
    //   leftover log, which is exactly the recurring "历史记录冲突" loop.
    //
    // The mapping is per conversation, so a private chat and a group meeting of
    // the same character never share worker context. Because the id is random
    // and the log is not resumed, the recovered SQLite history — not the DSH
    // JSONL — is what makes the character remember.
    //
    // A live session is not replayed wholesale, or the character would read its
    // own past twice; it receives only what it has not observed. That is empty
    // for a private chat, where the character has seen every message of the
    // conversation, and non-empty in a group, where whoever spoke first last
    // round never saw the characters that answered after it.
    const existingSessionId = lane.agentSessionId
    const agentSessionId = existingSessionId ?? freshAgentSessionId(request.employee.id)
    if (existingSessionId === undefined) lane.agentSessionId = agentSessionId
    const prompt = formatRecoveredHistoryPrompt(
      unseenHistory(request.history, request.observedThroughSequence, existingSessionId === undefined),
      request.prompt,
    )

    let observedNotification = false
    const onNotification = request.onNotification === undefined
      ? undefined
      : (notification: HarnessNotification) => {
          observedNotification = true
          request.onNotification?.(notification)
        }
    try {
      assertLaneTaskActive(task)
      const result = await lane.runtime!.run(agentSessionId, prompt, onNotification)
      return { agentSessionId, ...result }
    } catch (error) {
      if (task.aborted) throw error
      // DSH 0.1.1-rc.1's JSON-RPC server creates a named session on every
      // process start instead of resuming its persisted log. Reusing an id can
      // therefore fail before the prompt is queued. Only that exact,
      // side-effect-free failure is safe to retry.
      if (observedNotification || !isPersistedSessionCollision(error)) throw error
      const recoveredSessionId = freshAgentSessionId(request.employee.id)
      if (task.aborted) throw error
      lane.agentSessionId = recoveredSessionId
      // Only this conversation rotates. The recovered session starts empty, so
      // the whole history is replayed even if the conversation had already run
      // in this process.
      const result = await lane.runtime!.run(
        recoveredSessionId,
        formatRecoveredHistoryPrompt(unseenHistory(request.history, 0, true), request.prompt),
        request.onNotification,
      )
      return { agentSessionId: recoveredSessionId, ...result }
    }
  }

  #createWorker(employeeId: string): EmployeeWorker {
    const worker: EmployeeWorker = { lanes: new Map(), waiting: [], closingLanes: 0, closed: false }
    this.#runtimes.set(employeeId, worker)
    return worker
  }

  #createLane(worker: EmployeeWorker, conversationId: string): EmployeeLane {
    const lane: EmployeeLane = {
      id: randomUUID().replaceAll('-', ''),
      conversationId,
      permissionMode: undefined,
      workspacePath: undefined,
      runtime: undefined,
      agentSessionId: undefined,
      current: undefined,
      pending: [],
      lastUsed: Date.now(),
    }
    worker.lanes.set(conversationId, lane)
    return lane
  }

  #activeLaneCount(worker: EmployeeWorker): number {
    return [...worker.lanes.values()].filter((lane) => lane.current !== undefined || lane.pending.length > 0).length
  }

  #pumpLane(worker: EmployeeWorker, lane: EmployeeLane): void {
    if (lane.current !== undefined) return
    const task = lane.pending.shift()
    if (task === undefined) {
      this.#drainWaiting(worker)
      return
    }
    lane.current = task
    lane.lastUsed = Date.now()
    if (task.request.agentRunId !== undefined) this.#activeRuns.set(task.request.agentRunId, { lane, task })
    void this.#runEmployeeTurnExclusive(task.request, lane.conversationId, lane, task)
      .then((result) => {
        if (!task.aborted) task.resolve(result)
      })
      .catch((error) => {
        if (!task.aborted) task.reject(error)
      })
      .finally(() => {
        if (task.request.agentRunId !== undefined) this.#activeRuns.delete(task.request.agentRunId)
        if (task.request.agentRunId !== undefined) this.#runTasks.delete(task.request.agentRunId)
        if (lane.current === task) lane.current = undefined
        this.#pumpLane(worker, lane)
        this.#drainWaiting(worker)
      })
  }

  #drainWaiting(worker: EmployeeWorker): void {
    if (worker.waiting.length === 0 || this.#activeLaneCount(worker) >= MAX_ACTIVE_LANES_PER_EMPLOYEE) return
    const task = worker.waiting.shift()!
    const conversationId = requiredConversationId(task.request.conversationId)
    const existing = worker.lanes.get(conversationId)
    if (existing !== undefined) {
      existing.pending.push(task)
      existing.lastUsed = Date.now()
      if (task.request.agentRunId !== undefined) {
        const record = this.#runTasks.get(task.request.agentRunId)
        if (record !== undefined) record.lane = existing
      }
      this.#pumpLane(worker, existing)
      return
    }
    this.#scheduleNewLane(worker, task, conversationId)
  }

  #scheduleNewLane(worker: EmployeeWorker, task: LaneTask, conversationId: string): void {
    if (worker.closed) {
      task.aborted = true
      task.reject(new Error('Employee runtime closed'))
      if (task.request.agentRunId !== undefined) this.#runTasks.delete(task.request.agentRunId)
      return
    }
    if (this.#activeLaneCount(worker) >= MAX_ACTIVE_LANES_PER_EMPLOYEE) {
      worker.waiting.push(task)
      return
    }
    const idle = [...worker.lanes.values()]
      .filter((lane) => lane.current === undefined && lane.pending.length === 0)
      .sort((left, right) => left.lastUsed - right.lastUsed)[0]
    if (worker.lanes.size + worker.closingLanes >= MAX_ACTIVE_LANES_PER_EMPLOYEE && idle !== undefined) {
      worker.lanes.delete(idle.conversationId)
      worker.closingLanes += 1
      void (idle.runtime?.close() ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          worker.closingLanes = Math.max(0, worker.closingLanes - 1)
          if (worker.closed) {
            task.aborted = true
            task.reject(new Error('Employee runtime closed'))
            if (task.request.agentRunId !== undefined) this.#runTasks.delete(task.request.agentRunId)
            return
          }
          if (task.aborted) {
            this.#drainWaiting(worker)
            return
          }
          if (worker.lanes.size + worker.closingLanes >= MAX_ACTIVE_LANES_PER_EMPLOYEE) {
            worker.waiting.unshift(task)
            this.#drainWaiting(worker)
            return
          }
          const lane = this.#createLane(worker, conversationId)
          lane.pending.push(task)
          if (task.request.agentRunId !== undefined) {
            const record = this.#runTasks.get(task.request.agentRunId)
            if (record !== undefined) record.lane = lane
          }
          this.#pumpLane(worker, lane)
          this.#drainWaiting(worker)
        })
      return
    }
    if (worker.lanes.size + worker.closingLanes >= MAX_ACTIVE_LANES_PER_EMPLOYEE) {
      worker.waiting.push(task)
      return
    }
    const lane = this.#createLane(worker, conversationId)
    lane.pending.push(task)
    if (task.request.agentRunId !== undefined) {
      const record = this.#runTasks.get(task.request.agentRunId)
      if (record !== undefined) record.lane = lane
    }
    this.#pumpLane(worker, lane)
  }

  async closeEmployee(employeeId: string): Promise<void> {
    const worker = this.#runtimes.get(employeeId)
    if (worker === undefined) return
    this.#runtimes.delete(employeeId)
    worker.closed = true
    for (const task of worker.waiting.splice(0)) {
      task.aborted = true
      task.reject(new Error('Employee runtime closed'))
      if (task.request.agentRunId !== undefined) this.#runTasks.delete(task.request.agentRunId)
    }
    const lanes = [...worker.lanes.values()]
    worker.lanes.clear()
    await Promise.allSettled(lanes.map(async (lane) => {
      if (lane.current !== undefined) {
        lane.current.aborted = true
        lane.current.reject(new Error('Employee runtime closed'))
        if (lane.current.request.agentRunId !== undefined) this.#runTasks.delete(lane.current.request.agentRunId)
      }
      for (const task of lane.pending.splice(0)) {
        task.aborted = true
        task.reject(new Error('Employee runtime closed'))
        if (task.request.agentRunId !== undefined) this.#runTasks.delete(task.request.agentRunId)
      }
      await lane.runtime?.close()
      lane.runtime = undefined
      lane.agentSessionId = undefined
    }))
  }

  async abortRun(agentRunId: string): Promise<void> {
    const record = this.#runTasks.get(agentRunId)
    if (record === undefined) return
    const { task, worker, lane } = record
    task.aborted = true
    task.reject(new Error('Agent run aborted'))
    this.#runTasks.delete(agentRunId)
    if (lane === undefined) {
      const index = worker.waiting.indexOf(task)
      if (index >= 0) worker.waiting.splice(index, 1)
      return
    }
    const active = this.#activeRuns.get(agentRunId)
    if (active === undefined) {
      const index = lane.pending.indexOf(task)
      if (index >= 0) lane.pending.splice(index, 1)
      this.#pumpLane(worker, lane)
      return
    }
    // The SDK wire has no prompt-level cancel. Closing this lane's owned
    // runtime is the provider-neutral abort boundary and cannot touch another
    // conversation lane of the same employee.
    await active.lane.runtime?.close()
    active.lane.runtime = undefined
    active.lane.agentSessionId = undefined
  }

  closeAgent(agentId: string): Promise<void> {
    return this.closeEmployee(agentId)
  }

  async close(): Promise<void> {
    const employeeIds = [...this.#runtimes.keys()]
    const results = await Promise.allSettled(employeeIds.map((employeeId) => this.closeEmployee(employeeId)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to close ${failures.length} Harness employee runtime(s)`,
      )
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  async #getProfile(): Promise<HarnessProfilePaths> {
    this.#profile ??= ensureHarnessProfile(
      join(resolve(this.#options.stateRoot), 'harness-home'),
      WORKER_PROFILE_NAME,
      this.#options.providerProfile,
    )
    return this.#profile
  }

  #createRuntime(spec: HarnessRuntimeSpec): HarnessRuntime {
    const environment = workerEnvironment(
      this.#options.inheritedEnvironment ?? process.env,
      spec,
      [...new Set([
        this.#options.providerProfile?.apiKeyEnv,
        this.#options.providerProfile?.webSearch?.apiKeyEnv,
      ].filter((value): value is string => value !== undefined))],
    )
    const harness = new DeepSeekHarness({
      launch: {
        command: this.#options.nodeExecutable ?? process.execPath,
        args: [resolve(this.#options.dshBinPath ?? resolveDshBin()), '--profile', WORKER_PROFILE_NAME],
        cwd: spec.workspacePath,
        env: environment,
      },
      cwd: spec.workspacePath,
      provider: this.#options.provider ?? 'deepseek-official',
      model: this.#options.model ?? 'deepseek-v4-flash',
    })
    return {
      async run(sessionId, prompt, onNotification) {
        const result = await harness
          .session(sessionId)
          .run(prompt, onNotification === undefined ? undefined : { onNotification })
        return { finalResponse: result.finalResponse, notifications: result.notifications }
      },
      async decideApproval(approvalRequestId, decision) {
        await harness.start()
        await harness.client.request('approval/decide', {
          approvalRequestId,
          outcome: decision === 'approved' ? 'allowed-once' : 'rejected',
        })
      },
      close: () => harness.close(),
    }
  }
}

export function normalizeHarnessNotification(
  notification: HarnessNotification,
): AgentRuntimeEvent[] {
  if (notification.method !== 'session.event') return []
  const event = record(notification.params.event)
  if (event === undefined) return []
  const data = record(event.data) ?? {}
  const eventType = stringValue(event.type)
  const sourceSessionId = stringValue(notification.params.sessionId) ?? 'unknown-session'
  const sourceSequence = numberValue(event.seq)
  const sourceTime = numberValue(event.time)
  const make = (
    kind: AgentRuntimeEvent['kind'],
    extra: Partial<AgentRuntimeEvent> = {},
  ): AgentRuntimeEvent => {
    const normalized: AgentRuntimeEvent = {
      kind,
      source: 'deepseek-harness',
      sourceSessionId,
      metadata: (extra.metadata as JsonObject | undefined) ?? {},
    }
    if (sourceSequence !== undefined) normalized.sourceSequence = sourceSequence
    if (sourceTime !== undefined) normalized.sourceTime = sourceTime
    if (extra.content !== undefined) normalized.content = extra.content
    if (extra.toolName !== undefined) normalized.toolName = extra.toolName
    if (extra.callId !== undefined) normalized.callId = extra.callId
    if (extra.failed !== undefined) normalized.failed = extra.failed
    return normalized
  }

  switch (eventType) {
    case 'turn/start':
      return [make('turn.started', { metadata: numericMetadata(data, ['turn']) })]
    case 'assistant/chunk': {
      const chunk = record(data.chunk)
      if (chunk === undefined) return []
      const chunkType = stringValue(chunk.type)
      if (chunkType === 'reasoning-delta') {
        const content = stringValue(chunk.text)
        return content ? [make('reasoning.delta', { content })] : []
      }
      if (chunkType === 'text-delta') {
        const content = stringValue(chunk.text)
        return content ? [make('text.delta', { content })] : []
      }
      return []
    }
    case 'assistant/message': {
      const message = record(data.message)
      const blocks = Array.isArray(message?.content) ? message.content : []
      const normalized: AgentRuntimeEvent[] = []
      for (const blockValue of blocks) {
        const block = record(blockValue)
        if (block === undefined) continue
        const blockType = stringValue(block.type)
        const content = stringValue(block.text)
        if (!content) continue
        if (blockType === 'reasoning') {
          normalized.push(make('assistant.reasoning', { content }))
        } else if (blockType === 'text') {
          normalized.push(make('assistant.message', { content }))
        }
      }
      return normalized
    }
    case 'approval/asked': {
      const approvalRequestId = stringValue(data.id)
      if (approvalRequestId === undefined) return []
      const toolName = stringValue(data.toolName) ?? 'unknown-tool'
      const metadata: JsonObject = { approvalRequestId }
      const reason = stringValue(data.reason)
      const callId = stringValue(data.callId)
      if (reason !== undefined) metadata.reason = reason
      return [make('approval.requested', {
        toolName,
        ...(callId === undefined ? {} : { callId }),
        metadata,
      })]
    }
    case 'approval/decided': {
      const approvalRequestId = stringValue(data.id)
      const outcome = stringValue(data.outcome)
      if (approvalRequestId === undefined || outcome === undefined) return []
      return [make('approval.decided', {
        failed: outcome !== 'allowed-once',
        metadata: { approvalRequestId, outcome },
      })]
    }
    case 'tool/call': {
      const toolName = stringValue(data.name) ?? 'unknown-tool'
      const callId = stringValue(data.callId) ?? 'unknown-call'
      return [
        make('tool.started', {
          toolName,
          callId,
          metadata: { turn: numberValue(data.turn) ?? 0, step: numberValue(data.step) ?? 0 },
        }),
      ]
    }
    case 'tool/result': {
      const message = record(data.message)
      const source = record(message?.source)
      const callId = stringValue(source?.callId) ?? 'unknown-call'
      const failure = record(data.error)
      const failed = failure !== undefined
      const metadata: JsonObject = { failed }
      appendFailureDiagnostics(metadata, failure, data)
      return [make('tool.completed', { callId, failed, metadata })]
    }
    case 'turn/end': {
      const reason = record(data.reason)
      const reasonKind = stringValue(reason?.kind) ?? 'unknown'
      const metadata: JsonObject = { reason: reasonKind }
      const failure = record(reason?.error)
      appendFailureDiagnostics(metadata, failure, reason, data)
      const usage = extractTokenUsageFromValue(data)
      if (usage !== undefined) {
        metadata.tokensPrompt = usage.prompt
        metadata.tokensCompletion = usage.completion
        metadata.tokensTotal = usage.total
      }
      return [
        make(reasonKind === 'completed' ? 'turn.completed' : 'turn.failed', {
          failed: reasonKind !== 'completed',
          metadata,
        }),
      ]
    }
    default:
      return []
  }
}

export function extractHarnessTokenUsage(
  notifications: readonly HarnessNotification[],
): ModelTokenUsage | undefined {
  let latest: ModelTokenUsage | undefined
  for (const notification of notifications) {
    const usage = extractTokenUsageFromValue(notification)
    if (usage !== undefined) latest = usage
  }
  return latest
}

function extractTokenUsageFromValue(root: unknown): ModelTokenUsage | undefined {
  const seen = new Set<object>()
  let latest: ModelTokenUsage | undefined
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const item = value as Record<string, unknown>
    const prompt = tokenCount(item, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens'])
    const completion = tokenCount(item, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens'])
    const declaredTotal = tokenCount(item, ['total_tokens', 'totalTokens'])
    if (prompt !== undefined && completion !== undefined) {
      latest = {
        prompt,
        completion,
        total: declaredTotal ?? prompt + completion,
      }
    }
    for (const nested of Object.values(item)) visit(nested, depth + 1)
  }
  visit(root, 0)
  return latest
}

function tokenCount(recordValue: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = recordValue[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  }
  return undefined
}

function requiredConversationId(value: string | undefined): string {
  const conversationId = value?.trim() ?? ''
  if (conversationId.length === 0) {
    // Conversation identity is never inferred from the employee's last runtime
    // session: that value says nothing about which chat this turn belongs to.
    throw new Error('A Harness turn requires the conversation it belongs to')
  }
  return conversationId
}

function assertLaneTaskActive(task: LaneTask): void {
  if (task.aborted) throw new Error('Employee runtime closed')
}

export function stableAgentSessionId(employeeId: string): string {
  return `employee-${employeeId.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`
}

export function freshAgentSessionId(employeeId: string): string {
  return `${stableAgentSessionId(employeeId)}-${randomUUID().replaceAll('-', '')}`
}

export function isPersistedSessionCollision(value: unknown): boolean {
  const seen = new Set<unknown>()
  const messages: string[] = []
  let current: unknown = value
  for (let depth = 0; depth < 5 && current !== null && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current)
    if (current instanceof Error) {
      messages.push(current.message)
      current = (current as Error & { cause?: unknown }).cause
      continue
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>
      if (typeof record.message === 'string') messages.push(record.message)
      current = record.cause ?? record.error ?? record.data
      continue
    }
    messages.push(String(current))
    break
  }
  const signal = messages.join(' ').toLowerCase()
  return signal.includes('id collision')
    && (signal.includes('persisted log') || signal.includes('already persisted'))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numericMetadata(
  value: Record<string, unknown>,
  keys: readonly string[],
): JsonObject {
  const metadata: JsonObject = {}
  for (const key of keys) {
    const item = numberValue(value[key])
    if (item !== undefined) metadata[key] = item
  }
  return metadata
}

const DIAGNOSTIC_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\b\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:api[_-]?key|key|token|access[_-]?token)=)[^&\s]+/gi,
]

function appendFailureDiagnostics(
  metadata: JsonObject,
  ...sources: Array<Record<string, unknown> | undefined>
): void {
  const records = diagnosticRecords(sources)
  const code = firstDiagnosticString(records, ['code', 'errorCode', 'error_code'])
  const type = firstDiagnosticString(records, ['type', 'errorType', 'error_type'])
  const message = firstDiagnosticString(records, ['message', 'detail', 'error_description', 'error'])
  const status = firstHttpStatus(records)

  if (code !== undefined) metadata.errorCode = sanitizeDiagnosticText(code, 120)
  else if (status !== undefined) metadata.errorCode = statusFallbackCode(status)
  if (type !== undefined) metadata.errorType = sanitizeDiagnosticText(type, 120)
  if (message !== undefined) metadata.error = sanitizeDiagnosticText(message, 400)
  if (status !== undefined) metadata.httpStatus = status
}

function diagnosticRecords(
  roots: Array<Record<string, unknown> | undefined>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  const seen = new Set<Record<string, unknown>>()
  let current = roots.filter((value): value is Record<string, unknown> => value !== undefined)
  for (let depth = 0; depth < 3 && current.length > 0; depth += 1) {
    const next: Array<Record<string, unknown>> = []
    for (const item of current) {
      if (seen.has(item)) continue
      seen.add(item)
      result.push(item)
      for (const key of ['error', 'cause', 'response', 'data']) {
        const nested = record(item[key])
        if (nested !== undefined && !seen.has(nested)) next.push(nested)
      }
    }
    current = next
  }
  return result
}

function firstDiagnosticString(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const item of records) {
    for (const key of keys) {
      const value = stringValue(item[key])?.trim()
      if (value) return value
    }
  }
  return undefined
}

function firstHttpStatus(records: readonly Record<string, unknown>[]): number | undefined {
  for (const item of records) {
    for (const key of ['status', 'statusCode', 'httpStatus', 'http_status']) {
      const value = item[key]
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value
      if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10)
        if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed
      }
    }
  }
  return undefined
}

function statusFallbackCode(status: number): string {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'quota_exhausted'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'upstream_unreachable'
  return `http_${status}`
}

function sanitizeDiagnosticText(value: string, limit: number): string {
  let text = value.replaceAll(/[\r\n\t]+/g, ' ').trim()
  for (const pattern of DIAGNOSTIC_SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix: string | undefined) => prefix ? `${prefix}[已隐藏]` : '[已隐藏]')
  }
  return text.slice(0, limit)
}

export function workerEnvironment(
  inherited: NodeJS.ProcessEnv,
  spec: HarnessRuntimeSpec,
  credentialEnvironmentNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
  ] as const
  const environment: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    const value = inherited[key]
    if (value !== undefined) environment[key] = value
  }
  for (const key of credentialEnvironmentNames) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid credential environment: ${key}`)
    const value = inherited[key]
    if (value !== undefined) environment[key] = value
  }
  environment.DSH_HOME = spec.profile.homeDir
  environment.DSH_CWD = spec.workspacePath
  environment.DSH_SESSION_ROOT = spec.sessionsRoot
  environment.DSH_SYSTEM_PROMPT = employeeSystemPrompt(spec.employee, spec.revision)
  environment.DSH_TELEMETRY_DISABLED = '1'
  environment.DSH_PERMISSION_MODE = spec.permissionMode
  return environment
}

function employeeSystemPrompt(employee: EmployeeInstance, revision: EmployeeRevision): string {
  return [
    `你是 DSH Cyber 中持续存在的角色「${employee.displayName}」。`,
    '以下最新的用户自定义 Persona 和身份约定，是你当前身份的唯一权威来源：',
    revision.persona,
    '角色最初创建时使用的模板或职位只是来源信息。除非当前 Persona 明确保留，否则不得恢复或推断旧模板身份。',
    '始终保持当前身份一致，维护属于自己的持续会话，不得冒充其他角色。',
    '协作提示中出现其他角色的发言时，请回应其实际内容，并清楚说明认同点或分歧点。',
    '联网搜索不可用时，用简明中文说明原因，并引导用户前往“设置 → 模型 → 编辑当前模型 → 启用联网搜索”。不得编造搜索结果，也不得引导用户寻找不存在的隐藏页面。',
    '基于当前身份、记忆和已授权能力，使用简洁中文给出有证据的回答。需要调用工具时，向用户提供可公开、安全、简短的中文推理摘要，说明目标、判断依据和工具调度结果；不得暴露隐藏思维链、密钥、原始工具参数或原始工具结果。',
  ].join('\n\n')
}
