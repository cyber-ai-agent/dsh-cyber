import { describe, expect, it } from 'vitest'
import type { EmployeeInstance, JsonObject, WorkMessage, WorkSession } from '@dsh-cyber/contracts'
import { PeerConversationCoordinator, PeerConversationError } from '../src/peer-conversation-coordinator.js'

const now = '2026-08-22T04:00:00.000Z'

function character(id: string, role: string): EmployeeInstance {
  return {
    id,
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    blueprintId: id,
    blueprintVersion: 1,
    displayName: id === 'secretary' ? '秘书' : '开发工程师',
    role,
    status: 'available',
    currentRevision: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function fixture() {
  const characters = new Map([
    ['secretary', character('secretary', '行政协调')],
    ['engineer', character('engineer', '软件开发')],
  ])
  const messages: WorkMessage[] = []
  const events: Array<{ id: string; kind: string; payload: JsonObject }> = []
  const relationships: Array<{ employeeId: string; colleagueId: string }> = []
  const episodes: Array<{ summary: string; participantIds: [string, string] }> = []
  const session: WorkSession = {
    id: 'peer-session-1', workspaceId: 'workspace-1', worldId: 'world-1', kind: 'group',
    title: 'peer', status: 'open', createdAt: now, updatedAt: now,
  }
  const store = {
    getEmployee: (id: string) => characters.get(id),
    createSession: () => session,
    appendMessage(input: { sessionId: string; senderId: string; senderKind: 'employee' | 'system'; kind: WorkMessage['kind']; content: string; metadata?: JsonObject }) {
      const message: WorkMessage = {
        id: `message-${messages.length + 1}`,
        sessionId: input.sessionId,
        sequence: messages.length + 1,
        senderId: input.senderId,
        senderKind: input.senderKind,
        kind: input.kind,
        content: input.content,
        metadata: input.metadata ?? {},
        createdAt: now,
      }
      messages.push(message)
      return message
    },
    appendPeerEvent(input: { kind: string; payload: JsonObject }) {
      const event = { id: `event-${events.length + 1}`, kind: input.kind, payload: input.payload }
      events.push(event)
      return event
    },
    recordRelationship(input: { employeeId: string; colleagueId: string }) {
      relationships.push({ employeeId: input.employeeId, colleagueId: input.colleagueId })
    },
    recordSharedEpisode(input: { summary: string; participantIds: [string, string] }) {
      episodes.push({ summary: input.summary, participantIds: input.participantIds })
    },
  }
  return { characters, messages, events, relationships, episodes, session, store }
}

describe('PeerConversationCoordinator', () => {
  it('runs a bounded alternating conversation and records a shared episode', async () => {
    const data = fixture()
    const coordinator = new PeerConversationCoordinator({
      store: data.store,
      clock: () => now,
      runner: {
        async run(input) {
          return { content: `${input.speaker.displayName} 第 ${input.turnIndex + 1} 轮回复` }
        },
      },
    })
    const result = await coordinator.run({
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      initiatorId: 'secretary',
      targetId: 'engineer',
      purpose: '确认项目当前进度',
      policy: { maxTurns: 4 },
    })
    expect(result.transcript.turns.map((turn) => turn.speakerId)).toEqual([
      'secretary', 'engineer', 'secretary', 'engineer',
    ])
    expect(data.messages).toHaveLength(4)
    expect(data.events.map((event) => event.kind)).toEqual([
      'peer.conversation.requested',
      'peer.conversation.started',
      'peer.conversation.message',
      'peer.conversation.message',
      'peer.conversation.message',
      'peer.conversation.message',
      'peer.conversation.completed',
    ])
    expect(data.relationships).toEqual([
      { employeeId: 'secretary', colleagueId: 'engineer' },
      { employeeId: 'engineer', colleagueId: 'secretary' },
    ])
    expect(data.episodes).toHaveLength(1)
    expect(result.outcome.sourceMessageIds).toEqual(['message-1', 'message-2', 'message-3', 'message-4'])
  })

  it('rejects self-conversations and cross-world targets', async () => {
    const data = fixture()
    const coordinator = new PeerConversationCoordinator({
      store: data.store,
      runner: { async run() { return { content: 'unused' } } },
    })
    await expect(coordinator.run({
      workspaceId: 'workspace-1', worldId: 'world-1',
      initiatorId: 'secretary', targetId: 'secretary', purpose: '自言自语',
    })).rejects.toBeInstanceOf(PeerConversationError)
    data.characters.set('engineer', { ...data.characters.get('engineer')!, worldId: 'world-2' })
    await expect(coordinator.run({
      workspaceId: 'workspace-1', worldId: 'world-1',
      initiatorId: 'secretary', targetId: 'engineer', purpose: '跨世界询问',
    })).rejects.toBeInstanceOf(PeerConversationError)
  })

  it('stops at the configured turn budget', async () => {
    const data = fixture()
    let calls = 0
    const coordinator = new PeerConversationCoordinator({
      store: data.store,
      runner: { async run() { calls += 1; return { content: '简短回复' } } },
    })
    const result = await coordinator.run({
      workspaceId: 'workspace-1', worldId: 'world-1',
      initiatorId: 'secretary', targetId: 'engineer', purpose: '确认进度',
      policy: { maxTurns: 2 },
    })
    expect(calls).toBe(2)
    expect(result.transcript.turns).toHaveLength(2)
  })
})
