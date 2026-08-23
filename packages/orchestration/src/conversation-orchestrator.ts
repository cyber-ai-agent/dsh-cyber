import { randomUUID } from 'node:crypto'

import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  DomainEvent,
  DomainEventType,
  EmployeeInstance,
  EmployeeRevision,
  JsonObject,
  ParticipantKind,
  ReasoningEffort,
  WorkMessage,
  WorkSession,
  WorkSessionParticipant,
  World,
} from '@dsh-cyber/contracts'

export interface ConversationStorePort {
  getWorld(worldId: string): World | undefined
  getEmployee(employeeId: string): EmployeeInstance | undefined
  getEmployeeRevision(employeeId: string, revision: number): EmployeeRevision | undefined
  getSession(sessionId: string): WorkSession | undefined
  listParticipants(sessionId: string): WorkSessionParticipant[]
  createSession(input: {
    workspaceId: string
    worldId: string
    kind: WorkSession['kind']
    title: string
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
  setEmployeeStatus(
    employeeId: string,
    status: EmployeeInstance['status'],
    actorId: string,
  ): EmployeeInstance
  bindEmployeeAgentSession(employeeId: string, agentSessionId: string): EmployeeInstance
}

export interface ConversationRealtimeEnvelope {
  workspaceId: string
  worldId: string
  sessionId: string
  agentId: string
  event: AgentRuntimeEvent
}

export type ConversationRealtimeListener = (event: ConversationRealtimeEnvelope) => void

export interface ConversationOrchestratorOptions {
  store: ConversationStorePort
  runtime: AgentRuntimePort
  workspacePath?: string
  resolveWorldRoot?: (worldId: string) => Promise<string>
}

export interface DirectConversationInput {
  workspaceId: string
  worldId: string
  employeeId: string
  prompt: string
  metadata?: JsonObject
  runtimePrompt?: string
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
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
  sessionId?: string
  title?: string
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

export class ConversationOrchestrationError extends Error {}

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
  readonly #resolveWorldRoot: ((worldId: string) => Promise<string>) | undefined
  readonly #listeners = new Set<ConversationRealtimeListener>()

  constructor(options: ConversationOrchestratorOptions) {
    this.#store = options.store
    this.#runtime = options.runtime
    this.#workspacePath = options.workspacePath
    this.#resolveWorldRoot = options.resolveWorldRoot
    if (this.#workspacePath === undefined && this.#resolveWorldRoot === undefined) throw new Error('ConversationOrchestrator requires workspacePath or resolveWorldRoot')
  }

  subscribe(listener: ConversationRealtimeListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async direct(input: DirectConversationInput): Promise<ConversationResult> {
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

    this.#store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: prompt,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      correlationId: session.id,
    })
    const reply = await this.#runAgent(session, employee, input.runtimePrompt?.trim() || prompt, input.reasoningEffort)
    return { session, replies: [reply] }
  }

  async group(input: GroupConversationInput): Promise<ConversationResult> {
    const prompt = requiredText(input.prompt, 'Prompt')
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length < 2) {
      throw new ConversationOrchestrationError('A group conversation requires at least two agents')
    }
    const employees = employeeIds.map((employeeId) =>
      this.#requireEmployeeInWorld(employeeId, input.workspaceId, input.worldId),
    )
    const session = input.sessionId
      ? this.#requireGroupSession(input.sessionId, input.workspaceId, input.worldId, employeeIds)
      : this.#store.createSession({
          workspaceId: input.workspaceId,
          worldId: input.worldId,
          kind: 'group',
          title: input.title?.trim() || conciseTitle(prompt),
          participants: [
            { participantId: 'owner', kind: 'owner' },
            ...employees.map((employee) => ({
              participantId: employee.id,
              kind: 'employee' as const,
            })),
          ],
        })
    this.#store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: prompt,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      correlationId: session.id,
    })
    const meetingRunId = randomUUID()
    this.#store.appendDomainEvent({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      type: 'meeting.started',
      actorId: 'owner',
      actorKind: 'owner',
      correlationId: session.id,
      payload: { participantIds: employeeIds, promptMessageSequence: 1, meetingRunId },
    })

    const replies: AgentReply[] = []
    try {
      for (const employee of employees) {
        const collaborationPrompt = groupPrompt(input.runtimePrompt?.trim() || prompt, replies)
        replies.push(await this.#runAgent(session, employee, collaborationPrompt, input.reasoningEffort))
      }
      this.#store.appendDomainEvent({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sessionId: session.id,
        type: 'meeting.finished',
        actorId: 'system',
        actorKind: 'system',
        correlationId: session.id,
        payload: { participantIds: employeeIds, status: 'completed', replyCount: replies.length, meetingRunId },
      })
      return { session, replies }
    } catch (error) {
      this.#store.appendDomainEvent({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sessionId: session.id,
        type: 'meeting.finished',
        actorId: 'system',
        actorKind: 'system',
        correlationId: session.id,
        payload: { participantIds: employeeIds, status: 'blocked', replyCount: replies.length, meetingRunId },
      })
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
    },
    correlationId: session.id,
  })
  const meetingRunId = randomUUID()
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
    },
  })

  const replies: AgentReply[] = []
  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      for (const employee of orderedEmployees) {
        replies.push(await this.#runAgent(
          session,
          employee,
          peerPrompt({
            basePrompt: input.runtimePrompt?.trim() || purpose,
            purpose,
            employee,
            initiator,
            participants: employees,
            replies,
            round,
            maxRounds,
          }),
          input.reasoningEffort,
        ))
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
      },
    })
    return {
      session,
      replies,
      initiatorId: initiator.id,
      participantIds,
      purpose,
      rounds: maxRounds,
    }
  } catch (error) {
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
        status: 'blocked',
        replyCount: replies.length,
        rounds: maxRounds,
        meetingRunId,
      },
    })
    throw error
  }
}

  close(): Promise<void> {
    return this.#runtime.close()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  async #runAgent(
    session: WorkSession,
    employee: EmployeeInstance,
    prompt: string,
    reasoningEffort?: Exclude<ReasoningEffort, 'auto'>,
  ): Promise<AgentReply> {
    const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
    if (revision === undefined) {
      throw new ConversationOrchestrationError(`Missing agent revision: ${employee.id}`)
    }
    const traceTurnId = randomUUID()
    this.#store.setEmployeeStatus(employee.id, 'working', 'system')
    this.#store.appendDomainEvent({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      sessionId: session.id,
      type: 'task.started',
      actorId: employee.id,
      actorKind: 'employee',
      correlationId: session.id,
      payload: { employeeId: employee.id, role: employee.role, traceTurnId },
    })

    let responsePersisted = false
    let failedTurn = false
    let failedTurnKind: AgentTurnFailureKind = 'unknown'
    try {
      const workspacePath = this.#resolveWorldRoot === undefined ? this.#workspacePath! : await this.#resolveWorldRoot(session.worldId)
      const result = await this.#runtime.runTurn({
        agent: employee,
        revision,
        prompt,
        workspacePath,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        onEvent: (event) => {
          const tracedEvent: AgentRuntimeEvent = {
            ...event,
            metadata: { ...event.metadata, traceTurnId },
          }
          if (tracedEvent.kind === 'turn.failed') {
            failedTurn = true
            failedTurnKind = classifyRuntimeFailure(tracedEvent.metadata)
          }
          if (tracedEvent.kind === 'assistant.message' && tracedEvent.content?.trim()) {
            responsePersisted = true
          }
          this.#persistRuntimeEvent(session, employee, tracedEvent)
          this.#emit({
            workspaceId: session.workspaceId,
            worldId: session.worldId,
            sessionId: session.id,
            agentId: employee.id,
            event: tracedEvent,
          })
        },
      })
      this.#store.bindEmployeeAgentSession(employee.id, result.agentSessionId)
      if (failedTurn) {
        this.#blockAgent(session, employee, 'runtime-turn-failed', traceTurnId)
        throw new AgentTurnFailedError(employee.id, failedTurnKind)
      }
      const content = result.finalResponse.trim()
      if (!responsePersisted && content) {
        this.#store.appendMessage({
          sessionId: session.id,
          senderId: employee.id,
          senderKind: 'employee',
          kind: 'assistant',
          content,
          metadata: {
            source: 'runtime-final-response',
            agentSessionId: result.agentSessionId,
            traceTurnId,
          },
          correlationId: session.id,
        })
      }
      this.#store.setEmployeeStatus(employee.id, 'available', 'system')
      this.#store.appendDomainEvent({
        workspaceId: session.workspaceId,
        worldId: session.worldId,
        sessionId: session.id,
        type: 'task.completed',
        actorId: employee.id,
        actorKind: 'employee',
        correlationId: session.id,
        payload: { employeeId: employee.id, agentSessionId: result.agentSessionId, traceTurnId },
      })
      return {
        employeeId: employee.id,
        displayName: employee.displayName,
        agentSessionId: result.agentSessionId,
        content,
      }
    } catch (error) {
      if (!(error instanceof AgentTurnFailedError)) {
        this.#store.appendDomainEvent({
          workspaceId: session.workspaceId,
          worldId: session.worldId,
          sessionId: session.id,
          type: 'turn.failed',
          actorId: employee.id,
          actorKind: 'employee',
          correlationId: session.id,
          payload: { employeeId: employee.id, failure: 'runtime-error', traceTurnId },
        })
        this.#blockAgent(session, employee, 'runtime-error', traceTurnId)
      }
      throw error instanceof AgentTurnFailedError
        ? error
        : new AgentTurnFailedError(employee.id, classifyRuntimeFailure(error))
    }
  }

  #persistRuntimeEvent(
    session: WorkSession,
    employee: EmployeeInstance,
    event: AgentRuntimeEvent,
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

  #blockAgent(session: WorkSession, employee: EmployeeInstance, reason: string, traceTurnId: string): void {
    this.#store.setEmployeeStatus(employee.id, 'blocked', 'system')
    this.#store.appendDomainEvent({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      sessionId: session.id,
      type: 'task.blocked',
      actorId: employee.id,
      actorKind: 'employee',
      correlationId: session.id,
      payload: { employeeId: employee.id, reason, traceTurnId },
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
    const existingIds = this.#store.listParticipants(session.id)
      .filter((participant) => participant.kind === 'employee')
      .map((participant) => participant.participantId)
      .sort()
    const requestedIds = [...employeeIds].sort()
    if (
      existingIds.length !== requestedIds.length ||
      existingIds.some((participantId, index) => participantId !== requestedIds[index])
    ) {
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

function groupPrompt(original: string, replies: readonly AgentReply[]): string {
  const context = replies.length
    ? replies.map((reply) => `${reply.displayName}：${reply.content}`).join('\n\n')
    : '尚无其他角色发言。'
  return [
    '你正在参加同一世界内的多角色协作会话。请只以你自己的身份和专业立场发言。',
    `用户请求：\n${original}`,
    `此前角色的真实发言：\n${context}`,
    '请回应请求以及此前发言中的具体观点；说明你补充、同意或反对什么。不要替其他角色总结成他们没有说过的话。',
  ].join('\n\n')
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

function requiredText(value: string, label: string): string {
  const text = value.trim()
  if (!text) throw new ConversationOrchestrationError(`${label} cannot be empty`)
  return text
}

function conciseTitle(prompt: string): string {
  const compact = prompt.replaceAll(/\s+/g, ' ').trim()
  return compact.length <= 36 ? compact : `${compact.slice(0, 35)}…`
}
