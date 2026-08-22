import type { EmployeeRelationship, WorkMessage } from '@dsh-cyber/contracts'
import type {
  PeerConversationInput,
  PeerConversationResult,
  ConversationOrchestrator,
} from '@dsh-cyber/orchestration'
import type { SqliteStore, WorldSimulationStore } from '@dsh-cyber/persistence'
import type { SharedWorldEpisode } from '@dsh-cyber/contracts/world-simulation'

import { ServiceError } from './service-error.js'

export interface PeerCollaborationServiceOptions {
  store: SqliteStore
  simulationStore: WorldSimulationStore
  orchestrator: ConversationOrchestrator
  clock?: () => string
}

export interface PeerCollaborationResult extends PeerConversationResult {
  episode: SharedWorldEpisode
  relationships: EmployeeRelationship[]
}

export class PeerCollaborationService {
  readonly #store: SqliteStore
  readonly #simulationStore: WorldSimulationStore
  readonly #orchestrator: ConversationOrchestrator
  readonly #clock: () => string
  readonly #activeCharacterIds = new Set<string>()

  constructor(options: PeerCollaborationServiceOptions) {
    this.#store = options.store
    this.#simulationStore = options.simulationStore
    this.#orchestrator = options.orchestrator
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  async run(input: PeerConversationInput): Promise<PeerCollaborationResult> {
    const characterIds = uniqueCharacterIds(input)
    const busyCharacterId = characterIds.find((characterId) => this.#activeCharacterIds.has(characterId))
    if (busyCharacterId !== undefined) {
      const character = this.#store.getEmployee(busyCharacterId)
      throw new ServiceError(
        'conflict',
        'peer_collaboration_busy',
        `${character?.displayName ?? '所选角色'} 正在参与另一场协作，请等待结束后重试`,
      )
    }
    for (const characterId of characterIds) this.#activeCharacterIds.add(characterId)

    try {
      const result = await this.#orchestrator.peer(input)
      const messages = this.#store.listMessages(result.session.id)
      const events = this.#store
        .listWorldDomainEvents(result.session.worldId, 0)
        .filter((event) => event.sessionId === result.session.id)
      const now = this.#clock()
      const episode: SharedWorldEpisode = {
        id: `peer-episode-${result.session.id}`,
        worldId: result.session.worldId,
        participantIds: result.participantIds,
        sessionId: result.session.id,
        kind: 'collaboration',
        title: concise(result.purpose, 80),
        summary: groundedSummary(result.replies),
        outcome: groundedOutcome(result.replies),
        sourceEventIds: events.map((event) => event.id),
        sourceMessageIds: peerConversationMessageIds(messages),
        importance: peerImportance(result.rounds, result.participantIds.length),
        occurredAt: now,
        createdAt: now,
      }
      this.#simulationStore.recordSharedEpisode(episode)

      const relationships: EmployeeRelationship[] = []
      for (let leftIndex = 0; leftIndex < result.participantIds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < result.participantIds.length; rightIndex += 1) {
          const left = result.participantIds[leftIndex]
          const right = result.participantIds[rightIndex]
          if (left === undefined || right === undefined) continue
          relationships.push(...this.#store.recordEmployeeInteraction({
            employeeId: left,
            colleagueId: right,
            sessionId: result.session.id,
            kind: 'collaboration',
          }))
        }
      }

      return { ...result, episode, relationships }
    } finally {
      for (const characterId of characterIds) this.#activeCharacterIds.delete(characterId)
    }
  }
}

function uniqueCharacterIds(input: PeerConversationInput): string[] {
  return [...new Set([input.initiatorId, ...input.participantIds].map((value) => value.trim()).filter(Boolean))]
}

function groundedSummary(replies: PeerConversationResult['replies']): string {
  const statements = replies
    .filter((reply) => reply.content.trim().length > 0)
    .map((reply) => `${reply.displayName}：${concise(reply.content, 280)}`)
  return statements.length === 0
    ? '本次角色协作未产生可沉淀的正式发言。'
    : concise(statements.join('\n'), 1_800)
}

function groundedOutcome(replies: PeerConversationResult['replies']): string {
  const final = [...replies].reverse().find((reply) => reply.content.trim().length > 0)
  return final === undefined
    ? '协作已结束，未形成明确结论。'
    : concise(final.content, 600)
}

function peerImportance(rounds: number, participantCount: number): number {
  return Math.min(85, 45 + rounds * 8 + participantCount * 4)
}

function concise(value: string, limit: number): string {
  const text = value.replaceAll(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}…`
}

export function peerConversationMessageIds(messages: readonly WorkMessage[]): string[] {
  return messages
    .filter((message) => message.kind === 'assistant' || message.kind === 'system')
    .map((message) => message.id)
}
