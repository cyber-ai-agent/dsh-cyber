import type {
  AgentPermissionMode,
  EmployeeInstance,
  JsonObject,
  ReasoningEffort,
  WorkSession,
} from '@dsh-cyber/contracts'
import type {
  ConversationOrchestrator,
  ConversationResult,
  DirectConversationInput,
} from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type {
  PeerCollaborationResult,
  PeerCollaborationService,
} from './peer-collaboration-service.js'
import { ServiceError } from './service-error.js'
import type { WorldRuntimePromptComposer } from './world-runtime-context-composer.js'

const MAX_DELEGATED_TARGETS = 3
const DELEGATION_REQUEST = /(帮我|替我|请你|麻烦你|劳烦你|帮忙|去问|去找)/
const COLLABORATION_ACTION = /(询问|问一下|问问|咨询|确认|核对|沟通|讨论|请教|同步|了解|打听|对接)/
const DEEP_DISCUSSION = /(深入|详细|追问|多轮|充分讨论)/

export interface DelegatedCollaborationIntent {
  initiatorId: string
  targetIds: string[]
  purpose: string
  maxRounds: number
}

export interface DelegatedCollaborationInput extends DelegatedCollaborationIntent {
  workspaceId: string
  worldId: string
  transformedPrompt: string
  metadata: JsonObject
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  sessionId?: string
  title?: string
}

export interface DelegatedCollaborationResult extends ConversationResult {
  delegation: {
    session: WorkSession
    participantIds: string[]
    episodeId: string
  }
}

export interface DelegatedCollaborationServiceOptions {
  store: Pick<SqliteStore, 'getEmployee' | 'appendMessage'>
  orchestrator: Pick<ConversationOrchestrator, 'direct'>
  peerCollaboration: Pick<PeerCollaborationService, 'run'>
  worldSettings: WorldRuntimePromptComposer
}

export class DelegatedCollaborationService {
  readonly #store: DelegatedCollaborationServiceOptions['store']
  readonly #orchestrator: DelegatedCollaborationServiceOptions['orchestrator']
  readonly #peerCollaboration: DelegatedCollaborationServiceOptions['peerCollaboration']
  readonly #worldSettings: DelegatedCollaborationServiceOptions['worldSettings']

  constructor(options: DelegatedCollaborationServiceOptions) {
    this.#store = options.store
    this.#orchestrator = options.orchestrator
    this.#peerCollaboration = options.peerCollaboration
    this.#worldSettings = options.worldSettings
  }

  async run(input: DelegatedCollaborationInput): Promise<DelegatedCollaborationResult> {
    const initiator = this.#store.getEmployee(input.initiatorId)
    if (
      initiator === undefined ||
      initiator.workspaceId !== input.workspaceId ||
      initiator.worldId !== input.worldId ||
      initiator.status === 'archived'
    ) {
      throw new ServiceError('not-found', 'delegation_initiator_unavailable', '发起协作的角色不可用')
    }
    const targetIds = [...new Set(input.targetIds.filter((id) => id !== initiator.id))]
    if (targetIds.length === 0) {
      throw new ServiceError('invalid', 'delegation_target_required', '请明确 @ 至少一名需要沟通的角色')
    }
    if (targetIds.length > MAX_DELEGATED_TARGETS) {
      throw new ServiceError('invalid', 'delegation_target_limit', `一次最多委托 ${MAX_DELEGATED_TARGETS} 名角色参与沟通`)
    }

    const targets = targetIds.map((targetId) => {
      const target = this.#store.getEmployee(targetId)
      if (
        target === undefined ||
        target.workspaceId !== input.workspaceId ||
        target.worldId !== input.worldId ||
        target.status === 'archived'
      ) {
        throw new ServiceError('not-found', 'delegation_target_unavailable', `当前世界中不存在可用角色：${targetId}`)
      }
      return target
    })

    const collaboration = await this.#peerCollaboration.run({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      initiatorId: initiator.id,
      participantIds: targetIds,
      purpose: input.purpose,
      maxRounds: input.maxRounds,
      runtimePrompt: await this.#worldSettings.composeGroupRuntimePrompt(
        input.worldId,
        input.transformedPrompt,
      ),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      title: `${initiator.displayName} 代你向 ${targets.map((target) => target.displayName).join('、')} 确认`,
    })

    const directMetadata: JsonObject = {
      ...input.metadata,
      delegatedWorkflow: true,
      delegatedPeerSessionId: collaboration.session.id,
      delegatedEpisodeId: collaboration.episode.id,
      delegatedParticipantIds: collaboration.participantIds,
      delegatedPurpose: input.purpose,
    }
    const reportPrompt = buildGroundedReportPrompt(
      input.transformedPrompt,
      initiator,
      targets,
      collaboration,
    )
    const directInput: DirectConversationInput = {
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      employeeId: initiator.id,
      prompt: input.purpose,
      metadata: directMetadata,
      runtimePrompt: await this.#worldSettings.composeRuntimePrompt(
        input.worldId,
        initiator,
        reportPrompt,
      ),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    }
    if (input.sessionId !== undefined) directInput.sessionId = input.sessionId
    if (input.title !== undefined) directInput.title = input.title

    const direct = await this.#orchestrator.direct(directInput)
    this.#store.appendMessage({
      sessionId: collaboration.session.id,
      senderId: 'system',
      senderKind: 'system',
      kind: 'system',
      content: `${initiator.displayName} 已将本次协作结果汇报给用户。`,
      metadata: {
        source: 'delegated-collaboration',
        delegatedDirectSessionId: direct.session.id,
        delegatedEpisodeId: collaboration.episode.id,
      },
      correlationId: direct.session.id,
    })

    return {
      ...direct,
      delegation: {
        session: collaboration.session,
        participantIds: collaboration.participantIds,
        episodeId: collaboration.episode.id,
      },
    }
  }
}

export function detectDelegatedCollaboration(input: {
  prompt: string
  initiator: EmployeeInstance
  characters: readonly EmployeeInstance[]
}): DelegatedCollaborationIntent | undefined {
  const prompt = input.prompt.trim()
  if (!DELEGATION_REQUEST.test(prompt) || !COLLABORATION_ACTION.test(prompt)) return undefined

  const targets = input.characters
    .filter((character) =>
      character.id !== input.initiator.id &&
      character.status !== 'archived' &&
      prompt.includes(`@${character.displayName}`),
    )
    .sort((left, right) => prompt.indexOf(`@${left.displayName}`) - prompt.indexOf(`@${right.displayName}`))
  if (targets.length === 0) return undefined

  return {
    initiatorId: input.initiator.id,
    targetIds: targets.map((target) => target.id),
    purpose: prompt,
    maxRounds: DEEP_DISCUSSION.test(prompt) ? 2 : 1,
  }
}

function buildGroundedReportPrompt(
  transformedPrompt: string,
  initiator: EmployeeInstance,
  targets: readonly EmployeeInstance[],
  collaboration: PeerCollaborationResult,
): string {
  const transcript = collaboration.replies
    .map((reply) => `${reply.displayName}：${compact(reply.content, 1_200)}`)
    .join('\n\n')
  return [
    transformedPrompt,
    '[系统已完成一次真实角色协作]',
    `你是发起角色：${initiator.displayName}（${initiator.role}）`,
    `你实际沟通过的角色：${targets.map((target) => `${target.displayName}（${target.role}）`).join('、')}`,
    `协作会话 ID：${collaboration.session.id}`,
    `共同经历摘要：${collaboration.episode.summary}`,
    `真实协作发言：\n${transcript || '本次协作没有产生正式发言。'}`,
    '现在回到用户的原始会话进行汇报。只依据以上真实记录，明确说明已确认的事实、仍有分歧或未知的内容，以及下一步。不得虚构其他角色没有说过的观点、文件内容、进度或共同经历。',
  ].join('\n\n')
}

function compact(value: string, maximum: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}
