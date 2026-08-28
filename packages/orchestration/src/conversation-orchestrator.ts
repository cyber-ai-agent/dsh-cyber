import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentRun,
  AgentPermissionMode,
  CompletionJobDraft,
  ConversationHistoryEntry,
  DomainEvent,
  DomainEventType,
  EmployeeInstance,
  EmployeeRevision,
  JsonObject,
  ParticipantKind,
  ReasoningEffort,
  TaskCollaborationExecutionMode,
  TaskCollaborationPlan,
  TaskCollaborationPlanStatus,
  TaskCollaborationStep,
  TaskCollaborationStepStatus,
  WorkMessage,
  WorkSession,
  WorkSessionCollaborationMode,
  WorkTurn,
  WorkTurnInteractionKind,
  WorkSessionParticipant,
  World,
} from '@dsh-cyber/contracts'

import {
  buildConversationHistory,
  DEFAULT_CONVERSATION_HISTORY_BUDGET,
  lastAuthoredSequence,
  type ConversationHistoryBudget,
  type ConversationHistorySpeaker,
} from './conversation-history.js'
import {
  HeuristicGroupTurnPlanner,
  normalizeGroupTurnPlan,
  type GroupTurnCandidate,
  type GroupTurnPlan,
  type GroupTurnPlannerPort,
} from './group-turn-planner.js'
export interface ConversationStorePort {
  getWorld(worldId: string): World | undefined
  getEmployee(employeeId: string): EmployeeInstance | undefined
  getEmployeeRevision(employeeId: string, revision: number): EmployeeRevision | undefined
  getSession(sessionId: string): WorkSession | undefined
  listParticipants(sessionId: string): WorkSessionParticipant[]
  /**
   * Durable messages of exactly one session, oldest first. SQLite is the
   * authority for conversation history; the runtime session is a cache.
   */
  listMessages(sessionId: string): WorkMessage[]
  createSession(input: {
    workspaceId: string
    worldId: string
    kind: WorkSession['kind']
    title: string
    collaborationMode?: WorkSessionCollaborationMode
    participants?: Array<{ participantId: string; kind: ParticipantKind }>
    actorId?: string
  }): WorkSession
  addParticipant(
    sessionId: string,
    participantId: string,
    kind: ParticipantKind,
  ): WorkSessionParticipant
  appendMessage(input: {
    sessionId: string
    senderId: string
    senderKind: ParticipantKind
    kind: WorkMessage['kind']
    content: string
    metadata?: JsonObject
    causationId?: string
    correlationId?: string
  }): WorkMessage
  appendDomainEvent(input: {
    workspaceId: string
    worldId?: string
    type: DomainEventType
    actorId: string
    actorKind: ParticipantKind
    payload?: JsonObject
    sessionId?: string
    causationId?: string
    correlationId?: string
  }): DomainEvent
  bindEmployeeAgentSession(employeeId: string, agentSessionId: string): EmployeeInstance
  createWorkTurn(input: { workspaceId: string; worldId: string; sessionId: string; clientTurnId?: string; interactionKind: WorkTurnInteractionKind }): WorkTurn
  getWorkTurn(turnId: string): WorkTurn | undefined
  getAgentRun(runId: string): AgentRun | undefined
  listTurnAgentRuns(turnId: string): AgentRun[]
  startWorkTurn(turnId: string): WorkTurn
  completeWorkTurn(turnId: string): WorkTurn
  failWorkTurn(turnId: string, errorCode: string): WorkTurn
  createAgentRun(input: { workspaceId: string; worldId: string; turnId: string; sessionId: string; employeeId: string; ordinal: number }): AgentRun
  startAgentRun(runId: string): AgentRun
  completeAgentRun(runId: string, runtimeSessionId?: string): AgentRun
  commitAgentRunCompletion(input: {
    runId: string
    runtimeSessionId?: string
    messages: Array<{
      sessionId: string
      senderId: string
      senderKind: ParticipantKind
      kind: WorkMessage['kind']
      content: string
      metadata?: JsonObject
      correlationId?: string
    }>
    completionJob?: CompletionJobDraft
  }): { run: AgentRun; messages: WorkMessage[] }
  failAgentRun(runId: string, errorCode: string, runtimeSessionId?: string): AgentRun
  interruptAgentRun(runId: string, errorCode?: string): AgentRun
  interruptWorkTurn(turnId: string, errorCode?: string): WorkTurn
  createTaskCollaborationPlan?(input: {
    id?: string
    taskId: string
    workspaceId: string
    worldId: string
    sessionId: string
    workTurnId: string
    status?: TaskCollaborationPlanStatus
    steps: Array<{
      id?: string
      requiredSkills: string[]
      assignedEmployeeIds: string[]
      dependsOn: string[]
      executionMode: TaskCollaborationExecutionMode
      status?: TaskCollaborationStepStatus
      errorCode?: string | null
    }>
    actorId?: string
  }): TaskCollaborationPlan
  getTaskCollaborationPlan?(planId: string): TaskCollaborationPlan | undefined
  getTaskCollaborationPlanByTask?(worldId: string, taskId: string): TaskCollaborationPlan | undefined
  updateTaskCollaborationPlan?(input: {
    planId: string
    expectedRevision?: number
    revision?: number
    status?: TaskCollaborationPlanStatus
    steps?: Array<{
      id?: string
      requiredSkills: string[]
      assignedEmployeeIds: string[]
      dependsOn: string[]
      executionMode: TaskCollaborationExecutionMode
      status?: TaskCollaborationStepStatus
      errorCode?: string | null
    }>
    errorCode?: string | null
    actorId?: string
  }): TaskCollaborationPlan
  updateTaskCollaborationStep?(input: {
    planId: string
    stepId: string
    expectedRevision?: number
    revision?: number
    requiredSkills?: string[]
    assignedEmployeeIds?: string[]
    dependsOn?: string[]
    executionMode?: TaskCollaborationExecutionMode
    status?: TaskCollaborationStepStatus
    errorCode?: string | null
    actorId?: string
  }): TaskCollaborationPlan
}

export interface ConversationRealtimeEnvelope {
  workspaceId: string
  worldId: string
  sessionId: string
  agentId: string
  workTurnId: string
  agentRunId: string
  event: AgentRuntimeEvent
}

export interface ConversationControlEnvelope {
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  agentRunIds: string[]
  status: 'interrupted'
  content: '已停止'
}

export type ConversationRealtimeListener = (event: ConversationRealtimeEnvelope) => void
export type ConversationControlListener = (event: ConversationControlEnvelope) => void

export interface ConversationOrchestratorOptions {
  store: ConversationStorePort
  runtime: AgentRuntimePort
  workspacePath?: string
  /**
   * The workspace a character may run in.
   *
   * It takes the character because file access is per character: one without
   * `world.files.read` must be anchored at an empty host-managed workspace,
   * not at the world's real files.
   */
  resolveWorldRoot?: (worldId: string, employeeId: string) => Promise<string>
  historyBudget?: ConversationHistoryBudget
  /** Durable outbox handler type. The host processes it after the answer commits. */
  completionJobType?: string
  onCompletionJobQueued?: () => void
  /**
   * Decides who speaks in a group turn and in what order.
   *
   * Defaults to {@link HeuristicGroupTurnPlanner}, which costs no model call.
   * A host that wants a request routed by meaning rather than by `@` supplies
   * a model-backed planner here.
   */
  groupTurnPlanner?: GroupTurnPlannerPort
}

export interface DirectConversationInput {
  workspaceId: string
  worldId: string
  employeeId: string
  prompt: string
  metadata?: JsonObject
  runtimePrompt?: string
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  sessionId?: string
  title?: string
}

export interface GroupConversationInput {
  workspaceId: string
  worldId: string
  employeeIds: string[]
  prompt: string
  metadata?: JsonObject
  runtimePrompt?: string
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  sessionId?: string
  title?: string
  collaborationMode?: WorkSessionCollaborationMode
  /**
   * Per-character model override for this turn, keyed by employee id.
   *
   * A group is the case where one model for the whole turn is wrong: the
   * characters have their own assignments, and collapsing them silently makes
   * every role answer as the same model. An entry here wins for that
   * character; a character with no entry keeps its own assignment.
   */
  modelProfileIds?: Readonly<Record<string, string>>
  /**
   * Turn-wide model override, applied to every character without an entry in
   * `modelProfileIds`. Retained for the single-model composer control.
   */
  modelProfileId?: string
  /** Internal durable-queue continuation. HTTP callers never supply this. */
  existingWorkTurnId?: string
}

export interface TaskCollaborationStepDraft {
  id: string
  ordinal: number
  requiredSkills: string[]
  assignedEmployeeIds: string[]
  dependsOn: string[]
  executionMode: TaskCollaborationExecutionMode
}

export interface TaskConversationInput {
  workspaceId: string
  worldId: string
  prompt: string
  employeeIds: string[]
  coordinatorEmployeeId: string
  steps: TaskCollaborationStepDraft[]
  runtimePrompt?: string
  metadata?: JsonObject
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  sessionId?: string
  title?: string
  /** Internal durable-queue continuation. HTTP callers never supply this. */
  existingWorkTurnId?: string
}

export interface TaskConversationResult extends ConversationResult {
  workTurnId: string
  collaborationMode: 'task'
  plan: TaskCollaborationPlan
  coordinatorEmployeeId: string
}

export interface PeerConversationInput {
  workspaceId: string
  worldId: string
  initiatorId: string
  participantIds: string[]
  purpose: string
  maxRounds?: number
  runtimePrompt?: string
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  title?: string
}

export interface PeerConversationResult extends ConversationResult {
  initiatorId: string
  participantIds: string[]
  purpose: string
  rounds: number
}

export interface AgentReply {
  employeeId: string
  displayName: string
  agentSessionId: string
  content: string
}

export interface ConversationResult {
  session: WorkSession
  replies: AgentReply[]
}

export interface DirectConversationTurn {
  session: WorkSession
  workTurn: WorkTurn
  previousMessages: WorkMessage[]
  history: ConversationHistoryEntry[]
}

export interface ContinueDirectConversationInput {
  workTurnId: string
  employeeId: string
  runtimePrompt: string
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  previousMessages?: WorkMessage[]
  history?: ConversationHistoryEntry[]
}

interface RecoveredConversation {
  /** Every durable message of the session, oldest first. */
  messages: WorkMessage[]
  /** The user-visible subset, filtered and budgeted. */
  history: ConversationHistoryEntry[]
}

interface GroupConversationTurnContext {
  prompt: string
  employeeIds: string[]
  employees: EmployeeInstance[]
  session: WorkSession
  workTurn: WorkTurn
  recovered: RecoveredConversation
}

export class ConversationOrchestrationError extends Error {}

export class AgentTurnInterruptedError extends ConversationOrchestrationError {
  readonly employeeId: string

  constructor(employeeId: string) {
    super('Agent run was interrupted')
    this.name = 'AgentTurnInterruptedError'
    this.employeeId = employeeId
  }
}

export type AgentTurnFailureKind =
  | 'authentication'
  | 'model-not-found'
  | 'rate-limited'
  | 'timeout'
  | 'unreachable'
  | 'unknown'

export class AgentTurnFailedError extends ConversationOrchestrationError {
  readonly employeeId: string
  readonly failureKind: AgentTurnFailureKind

  constructor(employeeId: string, failureKind: AgentTurnFailureKind = 'unknown') {
    super('Agent model turn failed')
    this.name = 'AgentTurnFailedError'
    this.employeeId = employeeId
    this.failureKind = failureKind
  }
}

export class ConversationOrchestrator implements AsyncDisposable {
  readonly #store: ConversationStorePort
  readonly #runtime: AgentRuntimePort
  readonly #workspacePath: string | undefined
  readonly #resolveWorldRoot: ((worldId: string, employeeId: string) => Promise<string>) | undefined
  readonly #historyBudget: ConversationHistoryBudget
  readonly #completionJobType: string | undefined
  readonly #onCompletionJobQueued: (() => void) | undefined
  readonly #listeners = new Set<ConversationRealtimeListener>()
  readonly #controlListeners = new Set<ConversationControlListener>()
  readonly #activeAgentRuns = new Map<string, { workTurnId: string; employeeId: string }>()
  readonly #abortedAgentRuns = new Set<string>()
  readonly #groupTurnPlanner: GroupTurnPlannerPort

  constructor(options: ConversationOrchestratorOptions) {
    this.#store = options.store
    this.#runtime = options.runtime
    this.#workspacePath = options.workspacePath
    this.#resolveWorldRoot = options.resolveWorldRoot
    this.#historyBudget = options.historyBudget ?? DEFAULT_CONVERSATION_HISTORY_BUDGET
    this.#completionJobType = options.completionJobType?.trim() || undefined
    this.#onCompletionJobQueued = options.onCompletionJobQueued
    this.#groupTurnPlanner = options.groupTurnPlanner ?? new HeuristicGroupTurnPlanner()
    if (this.#workspacePath === undefined && this.#resolveWorldRoot === undefined) throw new Error('ConversationOrchestrator requires workspacePath or resolveWorldRoot')
  }

  subscribe(listener: ConversationRealtimeListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  subscribeControl(listener: ConversationControlListener): () => void {
    this.#controlListeners.add(listener)
    return () => this.#controlListeners.delete(listener)
  }

  /**
   * Stop every live AgentRun belonging to one WorkTurn. The runtime receives
   * only the affected AgentRun ids, so another conversation of the same
   * employee remains alive in its own Harness lane.
   */
  async interruptWorkTurn(workTurnId: string): Promise<ConversationControlEnvelope | undefined> {
    const workTurn = this.#store.getWorkTurn(workTurnId)
    if (workTurn === undefined) throw new ConversationOrchestrationError('Work turn is unavailable')
    if (!['queued', 'running', 'waiting-approval'].includes(workTurn.status)) {
      // Stop is idempotent for a terminal turn. Do not append a misleading
      // "已停止" notice after a completed or failed response.
      return undefined
    }
    const activeRunIds = [...this.#activeAgentRuns.entries()]
      .filter(([, value]) => value.workTurnId === workTurnId)
      .map(([runId]) => runId)
    const persistedRunIds = this.#store.listTurnAgentRuns(workTurnId)
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run) => run.id)
    const runIds = [...new Set([...activeRunIds, ...persistedRunIds])]
    for (const runId of runIds) this.#abortedAgentRuns.add(runId)
    await Promise.allSettled(activeRunIds.map((runId) => this.#runtime.abortRun?.(runId)))
    for (const runId of runIds) {
      try { this.#store.interruptAgentRun(runId, 'interrupted') } catch { /* a runtime race already settled it */ }
    }
    const current = this.#store.getWorkTurn(workTurnId)
    if (current !== undefined && ['queued', 'running', 'waiting-approval'].includes(current.status)) {
      try { this.#store.interruptWorkTurn(workTurnId, 'interrupted') } catch { /* another controller won */ }
    }
    const envelope: ConversationControlEnvelope = {
      workspaceId: workTurn.workspaceId,
      worldId: workTurn.worldId,
      sessionId: workTurn.sessionId,
      workTurnId,
      agentRunIds: runIds,
      status: 'interrupted',
      content: '已停止',
    }
    this.#appendStopNotice(envelope)
    this.#emitControl(envelope)
    return envelope
  }

  async direct(input: DirectConversationInput): Promise<ConversationResult> {
    const begun = this.beginDirect(input)
    return this.continueDirect({
      workTurnId: begun.workTurn.id,
      employeeId: input.employeeId,
      runtimePrompt: input.runtimePrompt?.trim() || requiredText(input.prompt, 'Prompt'),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      previousMessages: begun.previousMessages,
      history: begun.history,
    })
  }

  beginDirect(input: DirectConversationInput): DirectConversationTurn {
    return this.#beginDirect(input, true)
  }

  /** Create the durable user message without claiming a runtime slot yet. */
  beginDirectQueued(input: DirectConversationInput): DirectConversationTurn {
    return this.#beginDirect(input, false)
  }

  #beginDirect(input: DirectConversationInput, start: boolean): DirectConversationTurn {
    const prompt = requiredText(input.prompt, 'Prompt')
    const employee = this.#requireEmployeeInWorld(input.employeeId, input.workspaceId, input.worldId)
    const session = input.sessionId
      ? this.#requireDirectSession(input.sessionId, input.workspaceId, input.worldId, employee.id)
      : this.#store.createSession({
          workspaceId: input.workspaceId,
          worldId: input.worldId,
          kind: 'direct',
          title: input.title?.trim() || `与 ${employee.displayName} 对话`,
          participants: [
            { participantId: 'owner', kind: 'owner' },
            { participantId: employee.id, kind: 'employee' },
          ],
        })

    // SQLite is the conversation authority. Read the durable transcript before
    // the current prompt is appended, otherwise this turn's prompt would reach
    // the model twice: once as recovered history and once as the live request.
    const recovered = this.#recoverConversation(session)
    const clientTurnId = clientTurnIdFrom(input.metadata)
    const workTurn = this.#store.createWorkTurn({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      interactionKind: interactionKindFrom(input.metadata, 'chat'),
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
    })
    this.#store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: prompt,
      metadata: { ...input.metadata, workTurnId: workTurn.id },
      correlationId: session.id,
    })
    if (start) this.#store.startWorkTurn(workTurn.id)
    return { session, workTurn: this.#store.getWorkTurn(workTurn.id)!, previousMessages: recovered.messages, history: recovered.history }
  }

  async continueDirect(input: ContinueDirectConversationInput): Promise<ConversationResult> {
    const workTurn = this.#store.getWorkTurn(input.workTurnId)
    if (workTurn === undefined || workTurn.status !== 'running') {
      throw new ConversationOrchestrationError('Work turn is not ready to continue')
    }
    const session = this.#store.getSession(workTurn.sessionId)
    if (session === undefined || session.kind !== 'direct' || session.workspaceId !== workTurn.workspaceId || session.worldId !== workTurn.worldId) {
      throw new ConversationOrchestrationError('Direct continuation session is unavailable')
    }
    const employee = this.#requireEmployeeInWorld(input.employeeId, workTurn.workspaceId, workTurn.worldId)
    const participants = this.#store.listParticipants(session.id)
    if (!participants.some((participant) => participant.kind === 'employee' && participant.participantId === employee.id)) {
      throw new ConversationOrchestrationError('Direct continuation character is not a session participant')
    }
    const previousMessages = input.previousMessages
      ?? this.#store.listMessages(session.id).filter((message) => message.metadata.workTurnId !== workTurn.id)
    const recovered = {
      messages: previousMessages,
      history: input.history ?? buildConversationHistory(previousMessages, this.#speakersFor(session), this.#historyBudget),
    }
    const ordinal = Math.max(0, ...this.#store.listTurnAgentRuns(workTurn.id).map((run) => run.ordinal)) + 1
    try {
      const reply = await this.#runAgent({
        session, workTurn, ordinal, employee,
        prompt: requiredText(input.runtimePrompt, 'Runtime prompt'),
        history: recovered.history,
        observedThroughSequence: lastAuthoredSequence(recovered.messages, employee.id),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
        ...(workTurn.clientTurnId === undefined ? {} : { clientTurnId: workTurn.clientTurnId }),
      })
      this.#store.completeWorkTurn(workTurn.id)
      return { session, replies: [reply] }
    } catch (error) {
      if (this.#store.getWorkTurn(workTurn.id)?.status === 'running') this.#store.failWorkTurn(workTurn.id, lifecycleErrorCode(error))
      throw error
    }
  }

  /** Persist one group user turn without occupying any employee runtime lane. */
  beginGroupQueued(input: GroupConversationInput): DirectConversationTurn {
    const begun = this.#beginGroupTurn(input, false)
    return { session: begun.session, workTurn: begun.workTurn, previousMessages: begun.recovered.messages, history: begun.recovered.history }
  }

  #beginGroupTurn(input: GroupConversationInput, start: boolean): GroupConversationTurnContext {
    const prompt = requiredText(input.prompt, 'Prompt')
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length < 2) throw new ConversationOrchestrationError('A group conversation requires at least two agents')
    const employees = employeeIds.map((employeeId) => this.#requireEmployeeInWorld(employeeId, input.workspaceId, input.worldId))
    const session = input.sessionId
      ? this.#requireGroupSession(input.sessionId, input.workspaceId, input.worldId, employeeIds)
      : this.#store.createSession({
          workspaceId: input.workspaceId,
          worldId: input.worldId,
          kind: 'group',
          collaborationMode: input.collaborationMode ?? 'discussion',
          title: input.title?.trim() || conciseTitle(prompt),
          participants: [
            { participantId: 'owner', kind: 'owner' },
            ...employees.map((employee) => ({ participantId: employee.id, kind: 'employee' as const })),
          ],
        })
    const recovered = this.#recoverConversation(session)
    const clientTurnId = clientTurnIdFrom(input.metadata)
    const workTurn = this.#store.createWorkTurn({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      interactionKind: interactionKindFrom(input.metadata, input.collaborationMode === 'task' ? 'task' : 'meeting'),
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
    })
    this.#store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: prompt,
      metadata: {
        ...input.metadata,
        participantIds: employeeIds,
        collaborationMode: input.collaborationMode ?? session.collaborationMode ?? 'discussion',
        workTurnId: workTurn.id,
      },
      correlationId: session.id,
    })
    if (start) this.#store.startWorkTurn(workTurn.id)
    return { prompt, employeeIds, employees, session, workTurn: this.#store.getWorkTurn(workTurn.id)!, recovered }
  }

  #resumeGroupTurn(input: GroupConversationInput): GroupConversationTurnContext {
    const prompt = requiredText(input.prompt, 'Prompt')
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length < 2) throw new ConversationOrchestrationError('A group conversation requires at least two agents')
    const turn = input.existingWorkTurnId === undefined ? undefined : this.#store.getWorkTurn(input.existingWorkTurnId)
    if (turn === undefined || (turn.status !== 'queued' && turn.status !== 'running') || turn.workspaceId !== input.workspaceId || turn.worldId !== input.worldId) {
      throw new ConversationOrchestrationError('Queued group WorkTurn is unavailable')
    }
    const session = this.#requireGroupSession(turn.sessionId, input.workspaceId, input.worldId, employeeIds)
    if (input.sessionId !== undefined && input.sessionId !== session.id) throw new ConversationOrchestrationError('Queued group session does not match')
    const message = this.#store.listMessages(session.id).find((item) => item.kind === 'user' && item.metadata.workTurnId === turn.id)
    if (message === undefined || message.content !== prompt) throw new ConversationOrchestrationError('Queued group message is unavailable')
    const employees = employeeIds.map((employeeId) => this.#requireEmployeeInWorld(employeeId, input.workspaceId, input.worldId))
    const previousMessages = this.#store.listMessages(session.id).filter((item) => item.metadata.workTurnId !== turn.id)
    if (turn.status === 'queued') this.#store.startWorkTurn(turn.id)
    return {
      prompt,
      employeeIds,
      employees,
      session,
      workTurn: this.#store.getWorkTurn(turn.id)!,
      recovered: { messages: previousMessages, history: buildConversationHistory(previousMessages, this.#speakersFor(session), this.#historyBudget) },
    }
  }

  async group(input: GroupConversationInput): Promise<ConversationResult> {
    const begun = input.existingWorkTurnId === undefined ? this.#beginGroupTurn(input, true) : this.#resumeGroupTurn(input)
    const { prompt, employeeIds, employees, session, workTurn, recovered } = begun
    const clientTurnId = workTurn.clientTurnId
    const meetingRunId = workTurn.id
    // Resolved once for the turn rather than re-scanned per character, and
    // taken from the durable message so the queued and immediate paths agree.
    const selection = this.#turnModelSelection(session.id, workTurn.id)
    const modelProfileIds = { ...selection.perCharacter, ...input.modelProfileIds }
    const plan = await this.#planGroupTurn(input, employees, session)
    this.#store.appendDomainEvent({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      type: 'meeting.started',
      actorId: 'owner',
      actorKind: 'owner',
      correlationId: session.id,
      payload: {
        participantIds: employeeIds,
        promptMessageSequence: 1,
        meetingRunId,
        workTurnId: workTurn.id,
        // The roster is now a decision rather than the membership list, so it
        // has to be inspectable after the fact.
        plan: planEventPayload(plan),
      },
    })

    const replies: AgentReply[] = []
    const failures: Array<{ employeeId: string; errorCode: string }> = []
    let firstFailure: unknown
    let ordinal = 0
    try {
      for (const wave of plan.waves) {
        // Statements are shared between waves, never inside one. Speakers of a
        // wave are declared independent by the plan, so they start from the
        // same context and run at the same time; the wall clock of a wave is
        // its slowest speaker rather than the sum of all of them.
        const peerStatements = [...replies]
        const launched = wave.speakers.map((speaker) => {
          const employee = employees.find((candidate) => candidate.id === speaker.employeeId)
          if (employee === undefined) return undefined
          ordinal += 1
          const modelProfileId = modelProfileIds[employee.id] ?? input.modelProfileId ?? selection.scalar
          return {
            employeeId: employee.id,
            run: this.#runAgent({
              session, workTurn, ordinal,
              employee,
              prompt: groupPrompt(input.runtimePrompt?.trim() || prompt, peerStatements, speaker.brief),
              history: recovered.history,
              // Each character catches up from its own last statement. A character
              // that spoke first in the previous round has not seen what the ones
              // after it said, and its runtime session never will unless we replay.
              observedThroughSequence: lastAuthoredSequence(recovered.messages, employee.id),
              ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
              ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
              ...(clientTurnId === undefined ? {} : { clientTurnId }),
              ...(modelProfileId === undefined ? {} : { modelProfileId }),
            }),
          }
        }).filter((item): item is { employeeId: string; run: Promise<AgentReply> } => item !== undefined)

        const settled = await Promise.allSettled(launched.map((item) => item.run))
        for (const [index, result] of settled.entries()) {
          if (result.status === 'fulfilled') {
            replies.push(result.value)
            continue
          }
          // A stop command ends the whole meeting; it is the owner's decision,
          // not one character's failure.
          if (result.reason instanceof AgentTurnInterruptedError) throw result.reason
          // One character failing used to silence everyone after it and throw
          // away the answers already produced. The others have already spoken;
          // their work is kept and the failure is reported alongside it.
          if (failures.length === 0) firstFailure = result.reason
          failures.push({ employeeId: launched[index]!.employeeId, errorCode: lifecycleErrorCode(result.reason) })
        }
        if (this.#store.getWorkTurn(workTurn.id)?.status === 'interrupted') {
          throw new AgentTurnInterruptedError(launched[0]?.employeeId ?? '')
        }
      }
      // Every speaker failing is a failed turn, not an empty meeting. The
      // original error is rethrown rather than a fresh one: re-wrapping lost
      // the failure kind, so a missing model or an exhausted quota was
      // recorded as `runtime-unknown` and the turn stopped being diagnosable.
      if (replies.length === 0 && failures.length > 0) throw firstFailure
      this.#store.appendDomainEvent({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sessionId: session.id,
        type: 'meeting.finished',
        actorId: 'system',
        actorKind: 'system',
        correlationId: session.id,
        payload: {
          participantIds: employeeIds,
          status: 'completed',
          replyCount: replies.length,
          meetingRunId,
          workTurnId: workTurn.id,
          // A meeting that finished with a speaker down is completed, not
          // clean. Saying so is the difference between a quiet character and a
          // broken one.
          ...(failures.length === 0 ? {} : { failedSpeakers: failures }),
        },
      })
      this.#store.completeWorkTurn(workTurn.id)
      return { session, replies }
    } catch (error) {
      const interrupted = error instanceof AgentTurnInterruptedError || this.#store.getWorkTurn(workTurn.id)?.status === 'interrupted'
      this.#store.appendDomainEvent({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sessionId: session.id,
        type: 'meeting.finished',
        actorId: 'system',
        actorKind: 'system',
        correlationId: session.id,
        payload: { participantIds: employeeIds, status: interrupted ? 'interrupted' : 'blocked', replyCount: replies.length, meetingRunId, workTurnId: workTurn.id },
      })
      if (!interrupted && this.#store.getWorkTurn(workTurn.id)?.status === 'running') {
        this.#store.failWorkTurn(workTurn.id, lifecycleErrorCode(error))
      }
      throw error
    }
  }

  /** The turn-wide model override the composer sent, if any. */
  #turnModelProfileId(sessionId: string, workTurnId: string): string | undefined {
    return this.#turnModelSelection(sessionId, workTurnId).scalar
  }

  /**
   * What the composer asked for, read back from the turn's own user message.
   *
   * The durable message is the authority rather than the request object,
   * because a queued turn is rebuilt minutes later by a different code path
   * that never saw the original request. A selection that lived only in memory
   * silently stopped applying the moment a turn was enqueued — which is every
   * turn the web client sends.
   */
  #turnModelSelection(sessionId: string, workTurnId: string): { scalar?: string; perCharacter: Record<string, string> } {
    const turnMessage = this.#store.listMessages(sessionId)
      .find((message) => message.metadata.workTurnId === workTurnId && message.kind === 'user')
    const scalar = typeof turnMessage?.metadata.modelProfileId === 'string' ? turnMessage.metadata.modelProfileId : undefined
    const raw = turnMessage?.metadata.modelProfileIds
    const perCharacter: Record<string, string> = {}
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [employeeId, profileId] of Object.entries(raw)) {
        if (typeof profileId === 'string' && profileId !== '') perCharacter[employeeId] = profileId
      }
    }
    return { ...(scalar === undefined ? {} : { scalar }), perCharacter }
  }

  /**
   * Decides the speaking roster for one group turn.
   *
   * A planner failure must not cost the user their turn: the meeting falls
   * back to the whole room speaking concurrently, which is the same roster the
   * old sequential loop used and strictly faster than it.
   */
  async #planGroupTurn(
    input: GroupConversationInput,
    employees: readonly EmployeeInstance[],
    session: WorkSession,
  ): Promise<GroupTurnPlan> {
    const candidates: GroupTurnCandidate[] = employees.map((employee) => {
      const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
      return {
        employeeId: employee.id,
        displayName: employee.displayName,
        ...(employee.role === undefined ? {} : { role: employee.role }),
        ...(revision === undefined ? {} : { skillIds: revision.skillGrants }),
      }
    })
    const planInput = {
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      prompt: input.prompt,
      candidates,
      collaborationMode: (input.collaborationMode ?? session.collaborationMode ?? 'discussion') as 'discussion' | 'task',
    }
    try {
      return normalizeGroupTurnPlan(await this.#groupTurnPlanner.plan(planInput), candidates)
    } catch {
      return normalizeGroupTurnPlan(
        { waves: [{ speakers: candidates.map((candidate) => ({ employeeId: candidate.employeeId })) }], source: 'heuristic', rationale: '调度器不可用，全体并发发言' },
        candidates,
      )
    }
  }

  /**
   * Executes a persisted deterministic task plan inside one WorkTurn.
   * Discussion mode intentionally stays in `group()` above; this path only
   * runs steps whose assignments were produced by the host Task Router.
   */
  async task(input: TaskConversationInput): Promise<TaskConversationResult> {
    const prompt = requiredText(input.prompt, 'Prompt')
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length < 2) throw new ConversationOrchestrationError('A task group requires at least two agents')
    if (!employeeIds.includes(input.coordinatorEmployeeId)) {
      throw new ConversationOrchestrationError('Task coordinator must be a group participant')
    }
    const employees = employeeIds.map((employeeId) =>
      this.#requireEmployeeInWorld(employeeId, input.workspaceId, input.worldId),
    )
    validateTaskDraft(input.steps, employeeIds)

    const queuedTurn = input.existingWorkTurnId === undefined ? undefined : this.#store.getWorkTurn(input.existingWorkTurnId)
    if (input.existingWorkTurnId !== undefined && (
      queuedTurn === undefined
      || (queuedTurn.status !== 'queued' && queuedTurn.status !== 'running')
      || queuedTurn.workspaceId !== input.workspaceId
      || queuedTurn.worldId !== input.worldId
    )) throw new ConversationOrchestrationError('Queued task WorkTurn is unavailable')

    const session = queuedTurn !== undefined
      ? this.#requireGroupSession(queuedTurn.sessionId, input.workspaceId, input.worldId, employeeIds)
      : input.sessionId
      ? this.#requireGroupSession(input.sessionId, input.workspaceId, input.worldId, employeeIds)
      : this.#store.createSession({
          workspaceId: input.workspaceId,
          worldId: input.worldId,
          kind: 'group',
          collaborationMode: 'task',
          title: input.title?.trim() || conciseTitle(prompt),
          participants: [
            { participantId: 'owner', kind: 'owner' },
            ...employees.map((employee) => ({ participantId: employee.id, kind: 'employee' as const })),
          ],
        })
    if (session.collaborationMode !== undefined && session.collaborationMode !== 'task') {
      throw new ConversationOrchestrationError('Task execution requires a task collaboration session')
    }
    if (input.sessionId !== undefined && input.sessionId !== session.id) throw new ConversationOrchestrationError('Queued task session does not match')

    const recovered = queuedTurn === undefined
      ? this.#recoverConversation(session)
      : (() => {
          const messages = this.#store.listMessages(session.id)
          const current = messages.find((item) => item.kind === 'user' && item.metadata.workTurnId === queuedTurn.id)
          if (current === undefined || current.content !== prompt) throw new ConversationOrchestrationError('Queued task message is unavailable')
          const previous = messages.filter((item) => item.metadata.workTurnId !== queuedTurn.id)
          return { messages: previous, history: buildConversationHistory(previous, this.#speakersFor(session), this.#historyBudget) }
        })()
    const clientTurnId = queuedTurn?.clientTurnId ?? clientTurnIdFrom(input.metadata)
    const workTurn = queuedTurn ?? this.#store.createWorkTurn({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      interactionKind: 'task',
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
    })
    if (queuedTurn === undefined) {
      this.#store.appendMessage({
        sessionId: session.id,
        senderId: 'owner',
        senderKind: 'owner',
        kind: 'user',
        content: prompt,
        metadata: {
          ...input.metadata,
          participantIds: employeeIds,
          collaborationMode: 'task',
          interactionKind: 'task',
          workTurnId: workTurn.id,
        },
        correlationId: session.id,
      })
    }
    if (workTurn.status === 'queued') this.#store.startWorkTurn(workTurn.id)

    let plan: TaskCollaborationPlan | undefined
    try {
      plan = this.#store.createTaskCollaborationPlan?.({
        taskId: `task-${workTurn.id}`,
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sessionId: session.id,
        workTurnId: workTurn.id,
        steps: input.steps.map((step) => ({
          id: `${workTurn.id}:${step.id}`,
          requiredSkills: [...step.requiredSkills],
          assignedEmployeeIds: [...step.assignedEmployeeIds],
          dependsOn: step.dependsOn.map((dependency) => `${workTurn.id}:${dependency}`),
          executionMode: step.executionMode,
          status: 'pending' as const,
        })),
        actorId: 'owner',
      })
    } catch (error) {
      if (this.#store.getWorkTurn(workTurn.id)?.status === 'running') {
        this.#store.failWorkTurn(workTurn.id, lifecycleErrorCode(error))
      }
      throw error
    }
    if (plan === undefined) {
      this.#store.failWorkTurn(workTurn.id, 'task-plan-persistence-unavailable')
      throw new ConversationOrchestrationError('Task collaboration plan persistence is unavailable')
    }

    let currentPlan = this.#updateTaskPlan(plan, { status: 'running' })
    const replies: AgentReply[] = []
    const repliesByStep = new Map<string, AgentReply[]>()
    let nextOrdinal = 0

    try {
      while (currentPlan.steps.some((step) => step.status === 'pending' || step.status === 'ready' || step.status === 'running')) {
        const blocked = currentPlan.steps.filter((step) =>
          (step.status === 'pending' || step.status === 'ready')
          && step.dependsOn.some((dependency) => {
            const source = currentPlan.steps.find((candidate) => candidate.id === dependency)
            return source?.status === 'failed' || source?.status === 'blocked' || source?.status === 'interrupted' || source?.status === 'cancelled'
          }),
        )
        if (blocked.length > 0) {
          currentPlan = this.#updateTaskPlan(currentPlan, {
            steps: currentPlan.steps.map((step) => blocked.some((item) => item.id === step.id)
              ? taskStepInput(step, 'blocked', 'dependency-failed')
              : taskStepInput(step)),
          })
        }

        const ready = currentPlan.steps.filter((step) =>
          step.status === 'pending'
          && step.dependsOn.every((dependency) => currentPlan.steps.find((candidate) => candidate.id === dependency)?.status === 'completed'),
        )
        if (ready.length === 0) {
          if (currentPlan.steps.some((step) => step.status === 'running')) {
            // A step can only remain running while its Promise.allSettled
            // batch is in flight; reaching this point means the plan storage
            // changed concurrently and should fail closed.
            throw new ConversationOrchestrationError('Task collaboration plan has a running step without an executor')
          }
          if (currentPlan.steps.some((step) => step.status === 'pending')) {
            throw new ConversationOrchestrationError('Task collaboration plan cannot make progress')
          }
          break
        }

        // Persistence intentionally models pending -> ready -> running so a
        // recovered plan can distinguish dependency resolution from execution.
        // Keep the two transitions explicit instead of collapsing them into a
        // single update (which would be rejected by the store contract).
        currentPlan = this.#updateTaskPlan(currentPlan, {
          steps: currentPlan.steps.map((step) => ready.some((item) => item.id === step.id)
            ? taskStepInput(step, 'ready')
            : taskStepInput(step)),
        })
        currentPlan = this.#updateTaskPlan(currentPlan, {
          steps: currentPlan.steps.map((step) => ready.some((item) => item.id === step.id)
            ? taskStepInput(step, 'running')
            : taskStepInput(step)),
        })

        const executions = ready.map(async (step) => {
          const dependencyReplies = step.dependsOn.flatMap((dependency) => repliesByStep.get(dependency) ?? [])
          const stepReplies: AgentReply[] = []
          const assigned = step.assignedEmployeeIds.map((employeeId) => {
            const employee = employees.find((item) => item.id === employeeId)!
            nextOrdinal += 1
            return this.#runAgent({
              session,
              workTurn,
              ordinal: nextOrdinal,
              employee,
              prompt: taskStepPrompt(input.runtimePrompt?.trim() || prompt, step, dependencyReplies),
              history: recovered.history,
              observedThroughSequence: lastAuthoredSequence(recovered.messages, employee.id),
              ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
              ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
              ...(clientTurnId === undefined ? {} : { clientTurnId }),
            })
          })
          const settled = await Promise.allSettled(assigned)
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              stepReplies.push(result.value)
              replies.push(result.value)
            }
          }
          const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
          return { stepId: step.id, replies: stepReplies, failure }
        })
        const settledSteps = await Promise.all(executions)
        const failedStepIds = new Set(settledSteps.filter((item) => item.failure !== undefined).map((item) => item.stepId))
        for (const item of settledSteps) repliesByStep.set(item.stepId, item.replies)
        const failedOrBlockedStepIds = new Set(failedStepIds)
        let blockedChanged = true
        while (blockedChanged) {
          blockedChanged = false
          for (const step of currentPlan.steps) {
            if (
              (step.status === 'pending' || step.status === 'ready')
              && step.dependsOn.some((dependency) => failedOrBlockedStepIds.has(dependency))
              && !failedOrBlockedStepIds.has(step.id)
            ) {
              failedOrBlockedStepIds.add(step.id)
              blockedChanged = true
            }
          }
        }
        const stepUpdate: {
          status?: TaskCollaborationPlanStatus
          steps: Array<{
            id: string
            requiredSkills: string[]
            assignedEmployeeIds: string[]
            dependsOn: string[]
            executionMode: TaskCollaborationExecutionMode
            status?: TaskCollaborationStepStatus
            errorCode?: string | null
          }>
        } = {
          steps: currentPlan.steps.map((step) => {
            const result = settledSteps.find((item) => item.stepId === step.id)
            if (result === undefined && failedOrBlockedStepIds.has(step.id)) {
              return taskStepInput(step, 'blocked', 'dependency-failed')
            }
            if (result === undefined) return taskStepInput(step)
            return taskStepInput(step, result.failure === undefined ? 'completed' : 'failed', result.failure === undefined ? undefined : lifecycleErrorCode(result.failure.reason))
          }),
        }
        if (failedStepIds.size > 0) stepUpdate.status = 'failed'
        currentPlan = this.#updateTaskPlan(currentPlan, stepUpdate)
        // Independent steps should continue after a sibling failure, but a
        // failed plan cannot execute its coordinator summary. Dependent steps
        // are marked blocked on the next loop before any new run starts.
        if (failedStepIds.size > 0) break
      }

      if (currentPlan.status === 'failed' || currentPlan.steps.some((step) => step.status === 'failed' || step.status === 'blocked')) {
        throw new AgentTurnFailedError(input.coordinatorEmployeeId, 'unknown')
      }
      const coordinator = employees.find((employee) => employee.id === input.coordinatorEmployeeId)!
      nextOrdinal += 1
      const coordinatorReply = await this.#runAgent({
        session,
        workTurn,
        ordinal: nextOrdinal,
        employee: coordinator,
        prompt: coordinatorPrompt(input.runtimePrompt?.trim() || prompt, currentPlan, repliesByStep),
        history: recovered.history,
        observedThroughSequence: lastAuthoredSequence(recovered.messages, coordinator.id),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
        ...(clientTurnId === undefined ? {} : { clientTurnId }),
      })
      replies.push(coordinatorReply)
      currentPlan = this.#updateTaskPlan(currentPlan, { status: 'completed' })
      this.#store.completeWorkTurn(workTurn.id)
      return {
        session,
        replies,
        workTurnId: workTurn.id,
        collaborationMode: 'task',
        plan: currentPlan,
        coordinatorEmployeeId: input.coordinatorEmployeeId,
      }
    } catch (error) {
      const interrupted = error instanceof AgentTurnInterruptedError || this.#store.getWorkTurn(workTurn.id)?.status === 'interrupted'
      if (currentPlan.status !== 'failed' && currentPlan.status !== 'completed') {
        try {
          currentPlan = this.#updateTaskPlan(currentPlan, interrupted
            ? { status: 'interrupted', errorCode: 'interrupted' }
            : { status: 'failed', errorCode: lifecycleErrorCode(error) })
        } catch { /* preserve original task error */ }
      }
      if (this.#store.getWorkTurn(workTurn.id)?.status === 'running') {
        this.#store.failWorkTurn(workTurn.id, lifecycleErrorCode(error))
      }
      throw error
    }
  }

  async peer(input: PeerConversationInput): Promise<PeerConversationResult> {
  const purpose = requiredText(input.purpose, 'Peer conversation purpose')
  const initiatorId = requiredText(input.initiatorId, 'Initiator id')
  const participantIds = [...new Set(
    [initiatorId, ...input.participantIds]
      .map((value) => value.trim())
      .filter(Boolean),
  )]
  if (participantIds.length < 2 || participantIds.length > 4) {
    throw new ConversationOrchestrationError('A peer conversation requires 2 to 4 characters')
  }
  const maxRounds = input.maxRounds ?? 1
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3) {
    throw new ConversationOrchestrationError('Peer conversation rounds must be between 1 and 3')
  }
  const employees = participantIds.map((employeeId) =>
    this.#requireEmployeeInWorld(employeeId, input.workspaceId, input.worldId),
  )
  const initiator = employees.find((employee) => employee.id === initiatorId)
  if (initiator === undefined) throw new ConversationOrchestrationError('Peer conversation initiator is unavailable')
  const orderedEmployees = [
    ...employees.filter((employee) => employee.id !== initiator.id),
    initiator,
  ]
  const session = this.#store.createSession({
    workspaceId: input.workspaceId,
    worldId: input.worldId,
    kind: 'meeting',
    title: input.title?.trim() || conciseTitle(purpose),
    participants: employees.map((employee) => ({
      participantId: employee.id,
      kind: 'employee' as const,
    })),
    actorId: initiator.id,
  })
  const workTurn = this.#store.createWorkTurn({
    workspaceId: input.workspaceId,
    worldId: input.worldId,
    sessionId: session.id,
    interactionKind: 'peer',
  })
  this.#store.appendMessage({
    sessionId: session.id,
    senderId: 'system',
    senderKind: 'system',
    kind: 'system',
    content: `角色协作目标：${purpose}`,
    metadata: {
      source: 'peer-collaboration',
      peerConversation: true,
      initiatorId: initiator.id,
      participantIds,
      purpose,
      maxRounds,
      workTurnId: workTurn.id,
    },
    correlationId: session.id,
  })
  this.#store.startWorkTurn(workTurn.id)
  const meetingRunId = workTurn.id
  this.#store.appendDomainEvent({
    workspaceId: input.workspaceId,
    worldId: input.worldId,
    sessionId: session.id,
    type: 'meeting.started',
    actorId: initiator.id,
    actorKind: 'employee',
    correlationId: session.id,
    payload: {
      participantIds,
      speakerOrder: orderedEmployees.map((employee) => employee.id),
      initiatorId: initiator.id,
      peerConversation: true,
      purpose,
      maxRounds,
      meetingRunId,
      workTurnId: workTurn.id,
    },
  })

  const replies: AgentReply[] = []
  let ordinal = 0
  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      for (const employee of orderedEmployees) {
        ordinal += 1
        replies.push(await this.#runAgent({
          session, workTurn, ordinal,
          employee,
          prompt: peerPrompt({
            basePrompt: input.runtimePrompt?.trim() || purpose,
            purpose,
            employee,
            initiator,
            participants: employees,
            replies,
            round,
            maxRounds,
          }),
          // A peer session is always freshly created, and every statement of
          // the running collaboration is already carried by peerPrompt().
          history: [],
          observedThroughSequence: 0,
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        }))
      }
    }
    this.#store.appendDomainEvent({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      type: 'meeting.finished',
      actorId: 'system',
      actorKind: 'system',
      correlationId: session.id,
      payload: {
        participantIds,
        initiatorId: initiator.id,
        peerConversation: true,
        status: 'completed',
        replyCount: replies.length,
        rounds: maxRounds,
        meetingRunId,
        workTurnId: workTurn.id,
      },
    })
    this.#store.completeWorkTurn(workTurn.id)
    return {
      session,
      replies,
      initiatorId: initiator.id,
      participantIds,
      purpose,
      rounds: maxRounds,
    }
  } catch (error) {
    const interrupted = error instanceof AgentTurnInterruptedError || this.#store.getWorkTurn(workTurn.id)?.status === 'interrupted'
    this.#store.appendDomainEvent({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      type: 'meeting.finished',
      actorId: 'system',
      actorKind: 'system',
      correlationId: session.id,
      payload: {
        participantIds,
        initiatorId: initiator.id,
        peerConversation: true,
        status: interrupted ? 'interrupted' : 'blocked',
        replyCount: replies.length,
        rounds: maxRounds,
        meetingRunId,
        workTurnId: workTurn.id,
      },
    })
    if (!interrupted && this.#store.getWorkTurn(workTurn.id)?.status === 'running') {
      this.#store.failWorkTurn(workTurn.id, lifecycleErrorCode(error))
    }
    throw error
  }
}

  close(): Promise<void> {
    return this.#runtime.close()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /**
   * Recovers the user-visible history of one session from the local store.
   *
   * Only messages of `session` are read, so a direct chat can never inherit
   * group context, a group can never inherit a private chat, and no world can
   * leak into another. The raw messages are returned alongside the history so
   * each character can be given its own catch-up watermark.
   */
  #recoverConversation(session: WorkSession): RecoveredConversation {
    const messages = this.#store.listMessages(session.id)
    return {
      messages,
      history: buildConversationHistory(messages, this.#speakersFor(session), this.#historyBudget),
    }
  }

  #updateTaskPlan(
    current: TaskCollaborationPlan,
    patch: {
      status?: TaskCollaborationPlanStatus
      steps?: Array<{
        id?: string
        requiredSkills: string[]
        assignedEmployeeIds: string[]
        dependsOn: string[]
        executionMode: TaskCollaborationExecutionMode
        status?: TaskCollaborationStepStatus
        errorCode?: string | null
      }>
      errorCode?: string | null
    },
  ): TaskCollaborationPlan {
    if (this.#store.updateTaskCollaborationPlan === undefined) {
      throw new ConversationOrchestrationError('Task collaboration plan persistence is unavailable')
    }
    return this.#store.updateTaskCollaborationPlan({
      planId: current.id,
      expectedRevision: current.revision,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.steps === undefined ? {} : { steps: patch.steps }),
      ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
      actorId: 'system',
    })
  }

  #speakersFor(session: WorkSession): ConversationHistorySpeaker[] {
    const speakers: ConversationHistorySpeaker[] = []
    for (const participant of this.#store.listParticipants(session.id)) {
      if (participant.kind !== 'employee') continue
      const employee = this.#store.getEmployee(participant.participantId)
      if (employee === undefined) continue
      speakers.push({ id: employee.id, displayName: employee.displayName })
    }
    return speakers
  }

  async #runAgent(input: {
    session: WorkSession
    workTurn: WorkTurn
    ordinal: number
    employee: EmployeeInstance
    prompt: string
    history: ConversationHistoryEntry[]
    observedThroughSequence: number
    reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
    permissionMode?: AgentPermissionMode
    clientTurnId?: string
    /**
     * Model for this character's run, overriding the turn-wide one.
     *
     * Without it the profile is read from the turn's own user message, which
     * is one value for the whole turn — so a group collapsed every character
     * onto whichever model the composer had selected, silently discarding
     * their individual assignments.
     */
    modelProfileId?: string
  }): Promise<AgentReply> {
    const {
      session,
      workTurn,
      ordinal,
      employee,
      prompt,
      history,
      observedThroughSequence,
      reasoningEffort,
      permissionMode,
      clientTurnId,
    } = input
    const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
    if (revision === undefined) {
      throw new ConversationOrchestrationError(`Missing agent revision: ${employee.id}`)
    }
    const agentRun = this.#store.createAgentRun({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      turnId: workTurn.id,
      sessionId: session.id,
      employeeId: employee.id,
      ordinal,
    })
    this.#store.startAgentRun(agentRun.id)
    this.#activeAgentRuns.set(agentRun.id, { workTurnId: workTurn.id, employeeId: employee.id })
    // A Stop command may win immediately after the queue entry becomes
    // running but before this AgentRun reaches the runtime. Keep that race
    // durable: the run is recorded as interrupted and never starts work for
    // an already-interrupted WorkTurn.
    if (this.#abortedAgentRuns.has(agentRun.id) || this.#store.getWorkTurn(workTurn.id)?.status !== 'running') {
      try { this.#store.interruptAgentRun(agentRun.id, 'interrupted') } catch { /* another controller won */ }
      throw new AgentTurnInterruptedError(employee.id)
    }
    const traceTurnId = agentRun.id
    const modelProfileId = input.modelProfileId ?? this.#turnModelProfileId(session.id, workTurn.id)
    let responsePersisted = false
    const pendingAssistantMessages: PendingAssistantMessage[] = []
    let failedTurn = false
    let failedTurnKind: AgentTurnFailureKind = 'unknown'
    try {
      this.#store.appendDomainEvent({
        workspaceId: session.workspaceId,
        worldId: session.worldId,
        sessionId: session.id,
        type: 'task.started',
        actorId: employee.id,
        actorKind: 'employee',
        correlationId: session.id,
        payload: { employeeId: employee.id, role: employee.role, traceTurnId, agentRunId: agentRun.id, workTurnId: workTurn.id },
      })
      const workspacePath = this.#resolveWorldRoot === undefined ? this.#workspacePath! : await this.#resolveWorldRoot(session.worldId, employee.id)
      if (this.#abortedAgentRuns.has(agentRun.id)) throw new AgentTurnInterruptedError(employee.id)
      const result = await this.#runtime.runTurn({
        agent: employee,
        revision,
        conversationId: session.id,
        workTurnId: workTurn.id,
        agentRunId: agentRun.id,
        history,
        observedThroughSequence,
        prompt,
        workspacePath,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(modelProfileId === undefined ? {} : { modelProfileId }),
        onEvent: (event) => {
          const tracedEvent: AgentRuntimeEvent = {
            ...event,
            metadata: {
              ...event.metadata,
              traceTurnId,
              agentRunId: agentRun.id,
              workTurnId: workTurn.id,
              ...(clientTurnId === undefined ? {} : { clientTurnId }),
            },
          }
          if (tracedEvent.kind === 'turn.failed') {
            failedTurn = true
            failedTurnKind = classifyRuntimeFailure(tracedEvent.metadata)
          }
          if (tracedEvent.kind === 'assistant.message' && tracedEvent.content?.trim()) {
            responsePersisted = true
          }
          this.#persistRuntimeEvent(session, employee, tracedEvent, pendingAssistantMessages)
          this.#emit({
            workspaceId: session.workspaceId,
            worldId: session.worldId,
            sessionId: session.id,
            agentId: employee.id,
            agentRunId: agentRun.id,
            workTurnId: workTurn.id,
            event: tracedEvent,
          })
        },
      })
      if (this.#abortedAgentRuns.has(agentRun.id)) throw new AgentTurnInterruptedError(employee.id)
      this.#store.bindEmployeeAgentSession(employee.id, result.agentSessionId)
      if (failedTurn) {
        this.#store.failAgentRun(agentRun.id, `runtime-${failedTurnKind}`, result.agentSessionId)
        throw new AgentTurnFailedError(employee.id, failedTurnKind)
      }
      const content = result.finalResponse.trim()
      const completionStatus = this.#completionJobType === undefined ? 'completed' : 'pending'
      const completionMessages = pendingAssistantMessages.map((pending, index) => ({
        sessionId: session.id,
        senderId: employee.id,
        senderKind: 'employee' as const,
        kind: 'assistant' as const,
        content: pending.content,
        metadata: index === pendingAssistantMessages.length - 1
          ? {
              ...pending.metadata,
              agentSessionId: result.agentSessionId,
              traceTurnId,
              agentRunId: agentRun.id,
              workTurnId: workTurn.id,
              completionStatus,
              ...(clientTurnId === undefined ? {} : { clientTurnId }),
            }
          : pending.metadata,
        correlationId: session.id,
      }))
      if (completionMessages.length === 0 && !responsePersisted && content) {
        completionMessages.push({
          sessionId: session.id,
          senderId: employee.id,
          senderKind: 'employee',
          kind: 'assistant',
          content,
          metadata: {
            source: 'runtime-final-response',
            agentSessionId: result.agentSessionId,
            traceTurnId,
            agentRunId: agentRun.id,
            workTurnId: workTurn.id,
            ...(clientTurnId === undefined ? {} : { clientTurnId }),
            completionStatus,
          },
          correlationId: session.id,
        })
      }
      const completionJob = this.#completionJobType === undefined || completionMessages.length === 0
        ? undefined
        : {
            idempotencyKey: `agent-run-completion:v1:${this.#completionJobType}:${agentRun.id}`,
            workspaceId: session.workspaceId,
            worldId: session.worldId,
            sessionId: session.id,
            workTurnId: workTurn.id,
            agentRunId: agentRun.id,
            type: this.#completionJobType,
            payload: { employeeId: employee.id, workspacePath },
          }
      this.#store.commitAgentRunCompletion({
        runId: agentRun.id,
        runtimeSessionId: result.agentSessionId,
        messages: completionMessages,
        ...(completionJob === undefined ? {} : { completionJob }),
      })
      if (completionJob !== undefined) {
        try { this.#onCompletionJobQueued?.() } catch { /* durable polling remains the fallback */ }
      }
      this.#store.appendDomainEvent({
        workspaceId: session.workspaceId,
        worldId: session.worldId,
        sessionId: session.id,
        type: 'task.completed',
        actorId: employee.id,
        actorKind: 'employee',
        correlationId: session.id,
        payload: { employeeId: employee.id, agentSessionId: result.agentSessionId, traceTurnId, agentRunId: agentRun.id, workTurnId: workTurn.id },
      })
      return {
        employeeId: employee.id,
        displayName: employee.displayName,
        agentSessionId: result.agentSessionId,
        content,
      }
    } catch (error) {
      if (this.#abortedAgentRuns.has(agentRun.id) || error instanceof AgentTurnInterruptedError) {
        try { this.#store.interruptAgentRun(agentRun.id, 'interrupted') } catch { /* controller may have won the race */ }
        throw error instanceof AgentTurnInterruptedError ? error : new AgentTurnInterruptedError(employee.id)
      }
      if (!(error instanceof AgentTurnFailedError)) {
        this.#store.failAgentRun(agentRun.id, lifecycleErrorCode(error))
        this.#store.appendDomainEvent({
          workspaceId: session.workspaceId,
          worldId: session.worldId,
          sessionId: session.id,
          type: 'turn.failed',
          actorId: employee.id,
          actorKind: 'employee',
          correlationId: session.id,
          payload: { employeeId: employee.id, failure: 'runtime-error', traceTurnId, agentRunId: agentRun.id, workTurnId: workTurn.id },
        })
      }
      throw error instanceof AgentTurnFailedError
        ? error
        : new AgentTurnFailedError(employee.id, classifyRuntimeFailure(error))
    } finally {
      this.#activeAgentRuns.delete(agentRun.id)
      this.#abortedAgentRuns.delete(agentRun.id)
    }
  }

  #persistRuntimeEvent(
    session: WorkSession,
    employee: EmployeeInstance,
    event: AgentRuntimeEvent,
    pendingAssistantMessages?: PendingAssistantMessage[],
  ): void {
    const metadata = runtimeMetadata(event)
    switch (event.kind) {
      case 'assistant.reasoning':
        if (event.content?.trim()) {
          this.#store.appendMessage({
            sessionId: session.id,
            senderId: employee.id,
            senderKind: 'employee',
            kind: 'reasoning',
            content: event.content,
            metadata,
            correlationId: session.id,
          })
        }
        break
      case 'assistant.message':
        if (event.content?.trim()) {
          if (pendingAssistantMessages !== undefined) {
            pendingAssistantMessages.push({ content: event.content, metadata })
          } else {
            this.#store.appendMessage({
              sessionId: session.id,
              senderId: employee.id,
              senderKind: 'employee',
              kind: 'assistant',
              content: event.content,
              metadata,
              correlationId: session.id,
            })
          }
        }
        break
      case 'approval.requested':
        // The host turns this runtime event into a dedicated approval card.
        // Keep it out of the chat transcript and preserve the live AgentRun.
        break
      case 'approval.decided':
        break
      case 'tool.started':
        this.#store.appendMessage({
          sessionId: session.id,
          senderId: employee.id,
          senderKind: 'employee',
          kind: 'tool-call',
          content: `调用工具：${event.toolName ?? 'unknown-tool'}`,
          metadata,
          correlationId: session.id,
        })
        this.#runtimeDomainEvent(session, employee, 'tool.started', event)
        break
      case 'tool.completed':
        this.#store.appendMessage({
          sessionId: session.id,
          senderId: employee.id,
          senderKind: 'employee',
          kind: 'tool-result',
          content: event.failed ? '工具执行失败' : '工具执行完成',
          metadata,
          correlationId: session.id,
        })
        this.#runtimeDomainEvent(session, employee, 'tool.completed', event)
        break
      case 'turn.started':
        this.#runtimeDomainEvent(session, employee, 'turn.started', event)
        break
      case 'turn.completed':
        this.#runtimeDomainEvent(session, employee, 'turn.completed', event)
        break
      case 'turn.failed':
        this.#runtimeDomainEvent(session, employee, 'turn.failed', event)
        break
      case 'reasoning.delta':
      case 'text.delta':
        // Token deltas are streamed to clients but assembled messages are the durable transcript.
        break
    }
  }

  #runtimeDomainEvent(
    session: WorkSession,
    employee: EmployeeInstance,
    type: DomainEventType,
    event: AgentRuntimeEvent,
  ): void {
    this.#store.appendDomainEvent({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      sessionId: session.id,
      type,
      actorId: employee.id,
      actorKind: 'employee',
      correlationId: session.id,
      payload: {
        employeeId: employee.id,
        ...runtimeMetadata(event),
      },
    })
  }

  #requireEmployeeInWorld(
    employeeId: string,
    workspaceId: string,
    worldId: string,
  ): EmployeeInstance {
    const world = this.#store.getWorld(worldId)
    if (world === undefined || world.workspaceId !== workspaceId || world.status === 'archived') {
      throw new ConversationOrchestrationError('World is unavailable')
    }
    const employee = this.#store.getEmployee(employeeId)
    if (
      employee === undefined ||
      employee.workspaceId !== workspaceId ||
      employee.worldId !== worldId ||
      employee.status === 'archived'
    ) {
      throw new ConversationOrchestrationError(`Agent does not belong to this world: ${employeeId}`)
    }
    return employee
  }

  #requireDirectSession(
    sessionId: string,
    workspaceId: string,
    worldId: string,
    employeeId: string,
  ): WorkSession {
    const session = this.#store.getSession(sessionId)
    if (
      session === undefined ||
      session.kind !== 'direct' ||
      session.workspaceId !== workspaceId ||
      session.worldId !== worldId ||
      session.status !== 'open'
    ) {
      throw new ConversationOrchestrationError('Direct session is unavailable')
    }
    const participants = this.#store.listParticipants(session.id)
    if (!participants.some((participant) => participant.participantId === employeeId)) {
      this.#store.addParticipant(session.id, employeeId, 'employee')
    }
    return session
  }

  #requireGroupSession(
    sessionId: string,
    workspaceId: string,
    worldId: string,
    employeeIds: string[],
  ): WorkSession {
    const session = this.#store.getSession(sessionId)
    if (
      session === undefined ||
      session.kind !== 'group' ||
      session.workspaceId !== workspaceId ||
      session.worldId !== worldId ||
      session.status !== 'open'
    ) {
      throw new ConversationOrchestrationError('Group session is unavailable')
    }
    const existingIds = new Set(this.#store.listParticipants(session.id)
      .filter((participant) => participant.kind === 'employee')
      .map((participant) => participant.participantId))
    // A subset may speak. Requiring the request to name every member made
    // participation a property of the membership list, so a five-character
    // room had to run five characters for "@小刘 看下这个" — and no planner
    // could ever narrow it, because the narrowed roster was rejected here.
    // Naming someone who is not in the room stays an error.
    const outsiders = employeeIds.filter((employeeId) => !existingIds.has(employeeId))
    if (outsiders.length > 0) {
      throw new ConversationOrchestrationError('Group session participants do not match')
    }
    return session
  }

  #emit(envelope: ConversationRealtimeEnvelope): void {
    for (const listener of this.#listeners) {
      try {
        listener(envelope)
      } catch {
        // An observer cannot veto or corrupt an already-running agent turn.
      }
    }
  }

  #appendStopNotice(envelope: ConversationControlEnvelope): void {
    this.#store.appendMessage({
      sessionId: envelope.sessionId,
      senderId: 'system',
      senderKind: 'system',
      kind: 'system',
      content: envelope.content,
      metadata: {
        productNotice: true,
        control: 'stop',
        status: envelope.status,
        workTurnId: envelope.workTurnId,
        ...(envelope.agentRunIds.length === 0 ? {} : { agentRunIds: envelope.agentRunIds }),
      },
      correlationId: envelope.sessionId,
    })
  }

  #emitControl(envelope: ConversationControlEnvelope): void {
    for (const listener of this.#controlListeners) {
      try {
        listener(envelope)
      } catch {
        // A live observer cannot veto a durable interruption.
      }
    }
  }
}

interface PendingAssistantMessage {
  content: string
  metadata: JsonObject
}

function classifyRuntimeFailure(value: unknown): AgentTurnFailureKind {
  const signal = value instanceof Error
    ? `${value.name} ${value.message}`
    : value !== null && typeof value === 'object'
      ? Object.values(value).filter((item) => typeof item === 'string' || typeof item === 'number').join(' ')
      : String(value ?? '')
  const normalized = signal.toLowerCase()
  if (/401|403|unauthori[sz]ed|forbidden|authentication|invalid[_ -]?api[_ -]?key|credential/.test(normalized)) return 'authentication'
  if (/404|model[_ -]?not[_ -]?found|unknown[_ -]?model|invalid[_ -]?model/.test(normalized)) return 'model-not-found'
  if (/429|rate[_ -]?limit|too many requests|quota/.test(normalized)) return 'rate-limited'
  if (/timeout|timed out|abort/.test(normalized)) return 'timeout'
  if (/econn|enotfound|network|fetch failed|connection|socket|dns/.test(normalized)) return 'unreachable'
  return 'unknown'
}

function peerPrompt(input: {
  basePrompt: string
  purpose: string
  employee: EmployeeInstance
  initiator: EmployeeInstance
  participants: EmployeeInstance[]
  replies: readonly AgentReply[]
  round: number
  maxRounds: number
}): string {
  const transcript = input.replies.length === 0
    ? '尚无角色发言。'
    : input.replies
        .slice(-12)
        .map((reply) => `${reply.displayName}：${compactPeerStatement(reply.content)}`)
        .join('\n\n')
  const participantNames = input.participants.map((participant) => participant.displayName).join('、')
  const roleInstruction = input.employee.id === input.initiator.id
    ? '你是本次协作的发起者，本轮最后发言。请核对其他角色的真实意见，给出阶段结论、下一步或需要继续追问的点。'
    : `你是被 ${input.initiator.displayName} 邀请参与协作的角色。请从自己的当前 Persona、记忆和权限范围内提供具体信息，不要从创建时模板岗位推断已经被用户修改掉的身份，也不要替发起者或其他角色发言。`
  return [
    input.basePrompt,
    '你正在参加同一世界内的一次真实角色协作。这个会话没有用户直接代替你们发言。',
    `协作目标：${input.purpose}`,
    `参与角色：${participantNames}`,
    `当前轮次：${input.round}/${input.maxRounds}`,
    `此前角色的真实发言：\n${transcript}`,
    roleInstruction,
    '只引用会话中已经出现的事实和你自己能够访问的信息。不得虚构共同经历、权限、文件内容或其他角色观点。回答应简洁、可执行；没有补充时明确说明。',
  ].join('\n\n')
}

function compactPeerStatement(value: string): string {
  const compact = value.replaceAll(/\s+/g, ' ').trim()
  return compact.length <= 1_200 ? compact : `${compact.slice(0, 1_199)}…`
}

function compact(value: string, limit: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(1, limit - 1))}…`
}

function validateTaskDraft(steps: readonly TaskCollaborationStepDraft[], employeeIds: readonly string[]): void {
  if (steps.length === 0 || steps.length > 3) throw new ConversationOrchestrationError('A task collaboration plan must contain 1 to 3 steps')
  const employeeSet = new Set(employeeIds)
  const ids = new Set<string>()
  for (const step of steps) {
    if (!step.id.trim() || ids.has(step.id)) throw new ConversationOrchestrationError(`Duplicate task collaboration step: ${step.id}`)
    ids.add(step.id)
    if (step.assignedEmployeeIds.length === 0) throw new ConversationOrchestrationError(`Task step has no assigned employee: ${step.id}`)
    if (step.assignedEmployeeIds.some((employeeId) => !employeeSet.has(employeeId))) {
      throw new ConversationOrchestrationError(`Task step employee is not a group participant: ${step.id}`)
    }
    if (new Set(step.assignedEmployeeIds).size !== step.assignedEmployeeIds.length) {
      throw new ConversationOrchestrationError(`Task step assigns one employee more than once: ${step.id}`)
    }
    if (step.dependsOn.includes(step.id) || step.dependsOn.some((dependency) => !ids.has(dependency) && !steps.some((candidate) => candidate.id === dependency))) {
      throw new ConversationOrchestrationError(`Task step dependency is invalid: ${step.id}`)
    }
  }
  const byId = new Map(steps.map((step) => [step.id, step]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new ConversationOrchestrationError('Task collaboration plan contains a dependency cycle')
    visiting.add(id)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of steps) visit(step.id)
}

function taskStepInput(
  step: TaskCollaborationStep,
  status?: TaskCollaborationStepStatus,
  errorCode?: string,
): {
  id: string
  requiredSkills: string[]
  assignedEmployeeIds: string[]
  dependsOn: string[]
  executionMode: TaskCollaborationExecutionMode
  status?: TaskCollaborationStepStatus
  errorCode?: string | null
} {
  return {
    id: step.id,
    requiredSkills: [...step.requiredSkills],
    assignedEmployeeIds: [...step.assignedEmployeeIds],
    dependsOn: [...step.dependsOn],
    executionMode: step.executionMode,
    ...(status === undefined ? { status: step.status } : { status }),
    ...(errorCode === undefined
      ? (step.errorCode === undefined ? {} : { errorCode: step.errorCode })
      : { errorCode }),
  }
}

function taskStepPrompt(basePrompt: string, step: TaskCollaborationStep, dependencies: readonly AgentReply[]): string {
  const dependencyText = dependencies.length === 0
    ? '无'
    : dependencies.map((reply) => `${reply.displayName}：${compact(reply.content, 1_200)}`).join('\n\n')
  return [
    basePrompt,
    '[任务协作步骤]',
    `步骤 ${step.ordinal}，所需技能：${step.requiredSkills.join('、') || '综合处理'}`,
    `前置步骤的真实结果：\n${dependencyText}`,
    '只完成分配给你的步骤；不要替其他角色执行，也不要把未完成或未知内容写成事实。完成后给出证据、产物和下一步。',
  ].join('\n\n')
}

function coordinatorPrompt(
  basePrompt: string,
  plan: TaskCollaborationPlan,
  repliesByStep: ReadonlyMap<string, readonly AgentReply[]>,
): string {
  const results = plan.steps.map((step) => {
    const replies = repliesByStep.get(step.id) ?? []
    const content = replies.length === 0
      ? '该步骤没有形成正式回复。'
      : replies.map((reply) => `${reply.displayName}：${compact(reply.content, 1_200)}`).join('\n\n')
    return `步骤 ${step.ordinal}（${step.status}）：\n${content}`
  }).join('\n\n')
  return [
    basePrompt,
    '[任务协作汇总]',
    '你是明确指定的协调角色。以下是其他 AgentRun 的真实步骤结果：',
    results,
    '请只依据这些真实结果汇总结论、未决问题、证据/产物和下一步；不要声称未执行的步骤已完成，不要补造其他角色的观点。',
  ].join('\n\n')
}

function groupPrompt(original: string, replies: readonly AgentReply[], brief?: string): string {
  // Every sibling prompt builder caps a quoted statement; this one used to
  // inline `reply.content` whole, so the last speaker of a large room carried
  // the full text of everyone before it and the prompt grew quadratically
  // across the turn.
  const context = replies.length
    ? replies.map((reply) => `${reply.displayName}：${compactPeerStatement(reply.content)}`).join('\n\n')
    : '尚无其他角色发言。'
  return [
    '你正在参加同一世界内的多角色协作会话。请只以你自己的身份和专业立场发言。',
    `用户请求：\n${original}`,
    `此前角色的真实发言：\n${context}`,
    // A brief is the planner's words, not the user's. Marking it keeps a
    // character from answering the routing note as if it were the request.
    ...(brief === undefined || brief === '' ? [] : [`本轮请你重点负责（由调度给出，不是用户原话）：\n${brief}`]),
    '请回应请求以及此前发言中的具体观点；说明你补充、同意或反对什么。不要替其他角色总结成他们没有说过的话。',
  ].join('\n\n')
}

function planEventPayload(plan: GroupTurnPlan): JsonObject {
  return {
    source: plan.source,
    ...(plan.rationale === undefined ? {} : { rationale: plan.rationale }),
    waves: plan.waves.map((wave) => wave.speakers.map((speaker) => speaker.employeeId)),
  }
}

function runtimeMetadata(event: AgentRuntimeEvent): JsonObject {
  const metadata: JsonObject = {
    source: event.source,
    sourceSessionId: event.sourceSessionId,
    ...event.metadata,
  }
  if (event.sourceSequence !== undefined) metadata.sourceSequence = event.sourceSequence
  if (event.sourceTime !== undefined) metadata.sourceTime = event.sourceTime
  if (event.toolName !== undefined) metadata.toolName = event.toolName
  if (event.callId !== undefined) metadata.callId = event.callId
  if (event.failed !== undefined) metadata.failed = event.failed
  return metadata
}

function clientTurnIdFrom(metadata?: JsonObject): string | undefined {
  const value = metadata?.clientTurnId
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function interactionKindFrom(metadata: JsonObject | undefined, fallback: WorkTurnInteractionKind): WorkTurnInteractionKind {
  const value = metadata?.interactionKind
  return value === 'chat' || value === 'task' || value === 'meeting' || value === 'peer' ? value : fallback
}

function lifecycleErrorCode(error: unknown): string {
  return error instanceof AgentTurnFailedError ? `runtime-${error.failureKind}` : 'runtime-error'
}

function requiredText(value: string, label: string): string {
  const text = value.trim()
  if (!text) throw new ConversationOrchestrationError(`${label} cannot be empty`)
  return text
}

function conciseTitle(prompt: string): string {
  const compact = prompt.replaceAll(/\s+/g, ' ').trim()
  return compact.length <= 36 ? compact : `${compact.slice(0, 35)}…`
}
