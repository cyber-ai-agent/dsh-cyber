import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  DomainEvent,
  DomainEventType,
  EmployeeInstance,
  EmployeeRevision,
  JsonObject,
  ParticipantKind,
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
  workspacePath: string
}

export interface DirectConversationInput {
  workspaceId: string
  worldId: string
  employeeId: string
  prompt: string
  metadata?: JsonObject
  runtimePrompt?: string
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
  title?: string
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

export class AgentTurnFailedError extends ConversationOrchestrationError {
  readonly employeeId: string

  constructor(employeeId: string) {
    super(`Agent turn failed: ${employeeId}`)
    this.name = 'AgentTurnFailedError'
    this.employeeId = employeeId
  }
}

export class ConversationOrchestrator implements AsyncDisposable {
  readonly #store: ConversationStorePort
  readonly #runtime: AgentRuntimePort
  readonly #workspacePath: string
  readonly #listeners = new Set<ConversationRealtimeListener>()

  constructor(options: ConversationOrchestratorOptions) {
    this.#store = options.store
    this.#runtime = options.runtime
    this.#workspacePath = options.workspacePath
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
    const reply = await this.#runAgent(session, employee, input.runtimePrompt?.trim() || prompt)
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
    const session = this.#store.createSession({
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
    this.#store.appendDomainEvent({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      type: 'meeting.started',
      actorId: 'owner',
      actorKind: 'owner',
      correlationId: session.id,
      payload: { participantIds: employeeIds, promptMessageSequence: 1 },
    })

    const replies: AgentReply[] = []
    try {
      for (const employee of employees) {
        const collaborationPrompt = groupPrompt(input.runtimePrompt?.trim() || prompt, replies)
        replies.push(await this.#runAgent(session, employee, collaborationPrompt))
      }
      this.#store.appendDomainEvent({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sessionId: session.id,
        type: 'meeting.finished',
        actorId: 'system',
        actorKind: 'system',
        correlationId: session.id,
        payload: { participantIds: employeeIds, status: 'completed', replyCount: replies.length },
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
        payload: { participantIds: employeeIds, status: 'blocked', replyCount: replies.length },
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
  ): Promise<AgentReply> {
    const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
    if (revision === undefined) {
      throw new ConversationOrchestrationError(`Missing agent revision: ${employee.id}`)
    }
    this.#store.setEmployeeStatus(employee.id, 'working', 'system')
    this.#store.appendDomainEvent({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      sessionId: session.id,
      type: 'task.started',
      actorId: employee.id,
      actorKind: 'employee',
      correlationId: session.id,
      payload: { employeeId: employee.id, role: employee.role },
    })

    let responsePersisted = false
    let failedTurn = false
    try {
      const result = await this.#runtime.runTurn({
        agent: employee,
        revision,
        prompt,
        workspacePath: this.#workspacePath,
        onEvent: (event) => {
          if (event.kind === 'turn.failed') failedTurn = true
          if (event.kind === 'assistant.message' && event.content?.trim()) {
            responsePersisted = true
          }
          this.#persistRuntimeEvent(session, employee, event)
          this.#emit({
            workspaceId: session.workspaceId,
            worldId: session.worldId,
            sessionId: session.id,
            agentId: employee.id,
            event,
          })
        },
      })
      this.#store.bindEmployeeAgentSession(employee.id, result.agentSessionId)
      if (failedTurn) {
        this.#blockAgent(session, employee, 'runtime-turn-failed')
        throw new AgentTurnFailedError(employee.id)
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
        payload: { employeeId: employee.id, agentSessionId: result.agentSessionId },
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
          payload: { employeeId: employee.id, failure: 'runtime-error' },
        })
        this.#blockAgent(session, employee, 'runtime-error')
      }
      throw error
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
        source: event.source,
        sourceSessionId: event.sourceSessionId,
        ...event.metadata,
      },
    })
  }

  #blockAgent(session: WorkSession, employee: EmployeeInstance, reason: string): void {
    this.#store.setEmployeeStatus(employee.id, 'blocked', 'system')
    this.#store.appendDomainEvent({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      sessionId: session.id,
      type: 'task.blocked',
      actorId: employee.id,
      actorKind: 'employee',
      correlationId: session.id,
      payload: { employeeId: employee.id, reason },
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
