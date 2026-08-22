import type {
  EmployeeInstance,
  JsonObject,
  WorkMessage,
  WorkSession,
} from '@dsh-cyber/contracts'
import type {
  PeerConversationIntent,
  PeerConversationOutcome,
  PeerConversationPolicy,
  PeerConversationTranscript,
  PeerConversationTurn,
} from '@dsh-cyber/contracts/peer-collaboration'
import { DEFAULT_PEER_CONVERSATION_POLICY } from '@dsh-cyber/contracts/peer-collaboration'

export interface PeerConversationStorePort {
  getEmployee(employeeId: string): EmployeeInstance | undefined
  createSession(input: {
    workspaceId: string
    worldId: string
    kind: WorkSession['kind']
    title: string
    participants: Array<{ participantId: string; kind: 'employee' }>
    actorId?: string
  }): WorkSession
  appendMessage(input: {
    sessionId: string
    senderId: string
    senderKind: 'employee' | 'system'
    kind: WorkMessage['kind']
    content: string
    metadata?: JsonObject
    correlationId?: string
  }): WorkMessage
  appendPeerEvent(input: {
    workspaceId: string
    worldId: string
    sessionId: string
    kind:
      | 'peer.conversation.requested'
      | 'peer.conversation.started'
      | 'peer.conversation.message'
      | 'peer.conversation.completed'
      | 'peer.conversation.blocked'
    actorId: string
    payload: JsonObject
    correlationId: string
  }): { id: string }
  recordRelationship(input: {
    employeeId: string
    colleagueId: string
    sessionId: string
    kind: 'collaboration'
    actorId: string
  }): void
  recordSharedEpisode(input: {
    workspaceId: string
    worldId: string
    participantIds: [string, string]
    sessionId: string
    taskId?: string
    title: string
    summary: string
    sourceEventIds: string[]
    sourceMessageIds: string[]
    importance: number
    occurredAt: string
  }): void
}

export interface PeerTurnRunner {
  run(input: {
    session: WorkSession
    speaker: EmployeeInstance
    listener: EmployeeInstance
    intent: PeerConversationIntent
    transcript: readonly PeerConversationTurn[]
    turnIndex: number
    prompt: string
    timeoutMs: number
  }): Promise<{ content: string }>
}

export interface StartPeerConversationInput {
  workspaceId: string
  worldId: string
  initiatorId: string
  targetId: string
  purpose: string
  taskId?: string
  urgency?: PeerConversationIntent['urgency']
  metadata?: JsonObject
  policy?: Partial<PeerConversationPolicy>
}

export interface PeerConversationResult {
  session: WorkSession
  transcript: PeerConversationTranscript
  outcome: PeerConversationOutcome
}

export class PeerConversationError extends Error {}

export class PeerConversationCoordinator {
  readonly #store: PeerConversationStorePort
  readonly #runner: PeerTurnRunner
  readonly #clock: () => string

  constructor(options: {
    store: PeerConversationStorePort
    runner: PeerTurnRunner
    clock?: () => string
  }) {
    this.#store = options.store
    this.#runner = options.runner
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  async run(input: StartPeerConversationInput): Promise<PeerConversationResult> {
    const purpose = requiredText(input.purpose, '协作目的', 2_000)
    if (input.initiatorId === input.targetId) throw new PeerConversationError('角色不能与自己发起协作会话')
    const initiator = this.#requireCharacter(input.initiatorId, input.workspaceId, input.worldId)
    const target = this.#requireCharacter(input.targetId, input.workspaceId, input.worldId)
    const policy = resolvePolicy(input.policy)
    const requestedAt = this.#clock()
    const intent: PeerConversationIntent = {
      contractVersion: 1,
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      initiatorId: initiator.id,
      targetId: target.id,
      purpose,
      ...(input.taskId?.trim() ? { taskId: input.taskId.trim() } : {}),
      urgency: input.urgency ?? 'normal',
      requestedAt,
      metadata: input.metadata ?? {},
    }
    const session = this.#store.createSession({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      kind: 'group',
      title: `${initiator.displayName} 与 ${target.displayName}：${compact(purpose, 42)}`,
      participants: [
        { participantId: initiator.id, kind: 'employee' },
        { participantId: target.id, kind: 'employee' },
      ],
      actorId: initiator.id,
    })
    const correlationId = session.id
    const eventIds: string[] = []
    eventIds.push(this.#store.appendPeerEvent({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      kind: 'peer.conversation.requested',
      actorId: initiator.id,
      correlationId,
      payload: intent as unknown as JsonObject,
    }).id)
    eventIds.push(this.#store.appendPeerEvent({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      kind: 'peer.conversation.started',
      actorId: initiator.id,
      correlationId,
      payload: { participantIds: [initiator.id, target.id], purpose },
    }).id)

    const turns: PeerConversationTurn[] = []
    const messageIds: string[] = []
    try {
      for (let index = 0; index < policy.maxTurns; index += 1) {
        const speaker = index % 2 === 0 ? initiator : target
        const listener = index % 2 === 0 ? target : initiator
        const prompt = buildTurnPrompt(intent, speaker, listener, turns, index, policy.maxPromptCharsPerTurn)
        const generated = await withTimeout(
          this.#runner.run({
            session,
            speaker,
            listener,
            intent,
            transcript: turns,
            turnIndex: index,
            prompt,
            timeoutMs: policy.timeoutMs,
          }),
          policy.timeoutMs,
        )
        const content = requiredText(generated.content, '角色回复', policy.maxResponseCharsPerTurn)
        const message = this.#store.appendMessage({
          sessionId: session.id,
          senderId: speaker.id,
          senderKind: 'employee',
          kind: 'assistant',
          content,
          metadata: {
            source: 'peer-conversation',
            listenerId: listener.id,
            turnIndex: index,
            purpose,
          },
          correlationId,
        })
        messageIds.push(message.id)
        const turn: PeerConversationTurn = {
          index,
          speakerId: speaker.id,
          listenerId: listener.id,
          content,
          messageId: message.id,
          createdAt: message.createdAt,
        }
        turns.push(turn)
        eventIds.push(this.#store.appendPeerEvent({
          workspaceId: input.workspaceId,
          worldId: input.worldId,
          sessionId: session.id,
          kind: 'peer.conversation.message',
          actorId: speaker.id,
          correlationId,
          payload: {
            speakerId: speaker.id,
            listenerId: listener.id,
            messageId: message.id,
            turnIndex: index,
            excerpt: compact(content, 180),
          },
        }).id)
      }
    } catch (error) {
      eventIds.push(this.#store.appendPeerEvent({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sessionId: session.id,
        kind: 'peer.conversation.blocked',
        actorId: 'system',
        correlationId,
        payload: { participantIds: [initiator.id, target.id], reason: errorMessage(error) },
      }).id)
      throw error instanceof PeerConversationError
        ? error
        : new PeerConversationError(`角色协作会话失败：${errorMessage(error)}`)
    }

    const completedAt = this.#clock()
    const summary = summarize(purpose, initiator, target, turns)
    const completedEvent = this.#store.appendPeerEvent({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: session.id,
      kind: 'peer.conversation.completed',
      actorId: 'system',
      correlationId,
      payload: {
        participantIds: [initiator.id, target.id],
        purpose,
        turnCount: turns.length,
        summary,
      },
    })
    eventIds.push(completedEvent.id)
    for (const [employeeId, colleagueId] of [[initiator.id, target.id], [target.id, initiator.id]] as const) {
      this.#store.recordRelationship({
        employeeId,
        colleagueId,
        sessionId: session.id,
        kind: 'collaboration',
        actorId: 'system',
      })
    }
    this.#store.recordSharedEpisode({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      participantIds: [initiator.id, target.id],
      sessionId: session.id,
      ...(intent.taskId === undefined ? {} : { taskId: intent.taskId }),
      title: `${initiator.displayName} 与 ${target.displayName} 的协作`,
      summary,
      sourceEventIds: eventIds,
      sourceMessageIds: messageIds,
      importance: intent.urgency === 'high' ? 80 : intent.urgency === 'low' ? 35 : 55,
      occurredAt: completedAt,
    })
    const outcome: PeerConversationOutcome = {
      sessionId: session.id,
      status: 'completed',
      summary,
      participantIds: [initiator.id, target.id],
      sourceMessageIds: messageIds,
      sourceEventIds: eventIds,
      completedAt,
    }
    return {
      session,
      transcript: {
        sessionId: session.id,
        intent,
        turns,
        startedAt: requestedAt,
        completedAt,
      },
      outcome,
    }
  }

  #requireCharacter(characterId: string, workspaceId: string, worldId: string): EmployeeInstance {
    const character = this.#store.getEmployee(characterId)
    if (character === undefined || character.workspaceId !== workspaceId || character.worldId !== worldId) {
      throw new PeerConversationError(`当前世界中不存在角色：${characterId}`)
    }
    if (character.status === 'archived') throw new PeerConversationError(`角色已归档：${characterId}`)
    return character
  }
}

function resolvePolicy(overrides: Partial<PeerConversationPolicy> | undefined): PeerConversationPolicy {
  const policy = { ...DEFAULT_PEER_CONVERSATION_POLICY, ...overrides }
  if (!Number.isInteger(policy.maxTurns) || policy.maxTurns < 2 || policy.maxTurns > 6) {
    throw new PeerConversationError('角色协作轮数必须在 2 到 6 轮之间')
  }
  if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 5_000 || policy.timeoutMs > 300_000) {
    throw new PeerConversationError('角色协作单轮超时必须在 5 秒到 5 分钟之间')
  }
  if (!Number.isInteger(policy.maxPromptCharsPerTurn) || policy.maxPromptCharsPerTurn < 1_000) {
    throw new PeerConversationError('角色协作 prompt 限制无效')
  }
  if (!Number.isInteger(policy.maxResponseCharsPerTurn) || policy.maxResponseCharsPerTurn < 200) {
    throw new PeerConversationError('角色协作回复限制无效')
  }
  return policy
}

function buildTurnPrompt(
  intent: PeerConversationIntent,
  speaker: EmployeeInstance,
  listener: EmployeeInstance,
  transcript: readonly PeerConversationTurn[],
  turnIndex: number,
  maximumChars: number,
): string {
  const history = transcript.map((turn) => `${turn.speakerId}: ${turn.content}`).join('\n')
  const instruction = turnIndex === 0
    ? `请向 ${listener.displayName} 发起这次协作，直接说明目的并提出关键问题。`
    : `请基于已有讨论回应 ${listener.displayName}，提供与你职责相关的事实、判断或下一步。`
  return compact([
    '你正在参与一次受控的角色间协作会话。',
    `协作目的：${intent.purpose}`,
    `你是：${speaker.displayName}（${speaker.role}）`,
    `对方是：${listener.displayName}（${listener.role}）`,
    intent.taskId === undefined ? '' : `关联任务：${intent.taskId}`,
    instruction,
    '只依据你可以访问的信息作答；不要假装拥有对方的权限或私有文件。',
    history ? `已有讨论：\n${history}` : '',
  ].filter(Boolean).join('\n\n'), maximumChars)
}

function summarize(
  purpose: string,
  initiator: EmployeeInstance,
  target: EmployeeInstance,
  turns: readonly PeerConversationTurn[],
): string {
  const finalTurns = turns.slice(-2).map((turn) => compact(turn.content, 220)).join('；')
  return compact(`${initiator.displayName} 与 ${target.displayName} 围绕“${purpose}”完成 ${turns.length} 轮协作。${finalTurns}`, 900)
}

function requiredText(value: string, label: string, maximum: number): string {
  const text = value.trim()
  if (!text) throw new PeerConversationError(`${label}不能为空`)
  if (text.length > maximum) throw new PeerConversationError(`${label}不能超过 ${maximum} 个字符`)
  return text
}

function compact(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PeerConversationError('角色协作单轮执行超时')), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
