import { describe, expect, it } from 'vitest'

import type {
  EmployeeInstance,
  EmployeeRelationship,
  JsonObject,
  WorkMessage,
  WorkSession,
} from '@dsh-cyber/contracts'
import type {
  ConversationResult,
  DirectConversationInput,
} from '@dsh-cyber/orchestration'
import type { PeerCollaborationResult } from '../src/services/peer-collaboration-service.js'

import {
  DelegatedCollaborationService,
  detectDelegatedCollaboration,
} from '../src/services/delegated-collaboration-service.js'

describe('delegated character collaboration', () => {
  it('detects only explicit delegated requests and preserves mentioned role order', () => {
    const butler = character('butler', '管家', '世界管家')
    const engineer = character('engineer', '阿帆', '开发工程师')
    const researcher = character('researcher', '阿研', '研究员')

    expect(detectDelegatedCollaboration({
      prompt: '请帮我向 @阿研 和 @阿帆 详细确认当前进度，然后回来告诉我。',
      initiator: butler,
      characters: [butler, engineer, researcher],
    })).toEqual({
      initiatorId: butler.id,
      targetIds: [researcher.id, engineer.id],
      purpose: '请帮我向 @阿研 和 @阿帆 详细确认当前进度，然后回来告诉我。',
      maxRounds: 2,
    })

    expect(detectDelegatedCollaboration({
      prompt: '我刚才和 @阿帆 讨论过这个问题。',
      initiator: butler,
      characters: [butler, engineer],
    })).toBeUndefined()
    expect(detectDelegatedCollaboration({
      prompt: '帮我确认当前进度。',
      initiator: butler,
      characters: [butler, engineer],
    })).toBeUndefined()
  })

  it('runs the real peer session first, then gives the initiator a grounded report prompt and links both sessions', async () => {
    const butler = character('butler', '管家', '世界管家')
    const engineer = character('engineer', '阿帆', '开发工程师')
    const appended: Array<{
      sessionId: string
      senderId: string
      metadata?: JsonObject
    }> = []
    const directInputs: DirectConversationInput[] = []
    const peerInputs: Array<Record<string, unknown>> = []
    const service = new DelegatedCollaborationService({
      store: {
        getEmployee(id) {
          return id === butler.id ? butler : id === engineer.id ? engineer : undefined
        },
        appendMessage(input) {
          appended.push({
            sessionId: input.sessionId,
            senderId: input.senderId,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          })
          return message(input.sessionId, input.senderId, input.content, input.metadata ?? {})
        },
      },
      peerCollaboration: {
        async run(input) {
          peerInputs.push(input as unknown as Record<string, unknown>)
          return collaborationResult(butler, engineer)
        },
      },
      orchestrator: {
        async direct(input) {
          directInputs.push(input)
          return directResult(butler)
        },
      },
      worldSettings: {
        async composeGroupRuntimePrompt(_worldId, prompt) {
          return `[GROUP]\n${prompt}`
        },
        async composeRuntimePrompt(_worldId, _character, prompt) {
          return `[DIRECT]\n${prompt}`
        },
      },
    })

    const result = await service.run({
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      initiatorId: butler.id,
      targetIds: [engineer.id],
      purpose: '请帮我向 @阿帆 确认进度，然后回来告诉我。',
      maxRounds: 1,
      transformedPrompt: '请帮我向 @阿帆 确认进度，然后回来告诉我。',
      metadata: { participantIds: [butler.id] },
      sessionId: 'direct-existing',
    })

    expect(peerInputs).toHaveLength(1)
    expect(peerInputs[0]).toMatchObject({
      initiatorId: butler.id,
      participantIds: [engineer.id],
      maxRounds: 1,
      runtimePrompt: expect.stringContaining('[GROUP]'),
    })
    expect(directInputs).toHaveLength(1)
    expect(directInputs[0]).toMatchObject({
      employeeId: butler.id,
      sessionId: 'direct-existing',
      metadata: {
        delegatedWorkflow: true,
        delegatedPeerSessionId: 'peer-session',
        delegatedEpisodeId: 'episode-1',
        delegatedParticipantIds: [butler.id, engineer.id],
      },
    })
    expect(directInputs[0]?.runtimePrompt).toContain('阿帆：接口层已经完成')
    expect(directInputs[0]?.runtimePrompt).toContain('只依据以上真实记录')
    expect(appended).toContainEqual(expect.objectContaining({
      sessionId: 'peer-session',
      senderId: 'system',
      metadata: expect.objectContaining({ delegatedDirectSessionId: 'direct-session' }),
    }))
    expect(result.session.id).toBe('direct-session')
    expect(result.delegation).toEqual({
      session: expect.objectContaining({ id: 'peer-session' }),
      participantIds: [butler.id, engineer.id],
      episodeId: 'episode-1',
    })
  })
})

function character(id: string, displayName: string, role: string): EmployeeInstance {
  return {
    id,
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    blueprintId: id,
    blueprintVersion: 1,
    displayName,
    role,
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  }
}

function session(id: string, kind: WorkSession['kind']): WorkSession {
  return {
    id,
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    kind,
    title: id,
    status: 'open',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  }
}

function collaborationResult(
  butler: EmployeeInstance,
  engineer: EmployeeInstance,
): PeerCollaborationResult {
  const relationships: EmployeeRelationship[] = [
    {
      employeeId: butler.id,
      colleagueId: engineer.id,
      collaborationCount: 1,
      reviewCount: 0,
      handoffCount: 0,
      lastInteractionAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    },
  ]
  return {
    session: session('peer-session', 'meeting'),
    initiatorId: butler.id,
    participantIds: [butler.id, engineer.id],
    purpose: '确认进度',
    rounds: 1,
    replies: [
      {
        employeeId: engineer.id,
        displayName: engineer.displayName,
        agentSessionId: 'engineer-agent-session',
        content: '接口层已经完成，剩余端到端验证。',
      },
      {
        employeeId: butler.id,
        displayName: butler.displayName,
        agentSessionId: 'butler-agent-session',
        content: '已核对开发进度，建议继续完成端到端验证。',
      },
    ],
    episode: {
      id: 'episode-1',
      worldId: 'world-1',
      participantIds: [butler.id, engineer.id],
      sessionId: 'peer-session',
      kind: 'collaboration',
      title: '确认进度',
      summary: '阿帆确认接口层已完成，下一步是端到端验证。',
      outcome: 'completed',
      sourceEventIds: ['event-1'],
      sourceMessageIds: ['message-1'],
      importance: 60,
      occurredAt: '2026-08-22T00:00:00.000Z',
      createdAt: '2026-08-22T00:00:00.000Z',
    },
    relationships,
  }
}

function directResult(butler: EmployeeInstance): ConversationResult {
  return {
    session: session('direct-session', 'direct'),
    replies: [{
      employeeId: butler.id,
      displayName: butler.displayName,
      agentSessionId: 'butler-agent-session',
      content: '我已经向阿帆确认过，接口层已完成。',
    }],
  }
}

function message(
  sessionId: string,
  senderId: string,
  content: string,
  metadata: JsonObject,
): WorkMessage {
  return {
    id: 'message-link',
    sessionId,
    sequence: 1,
    senderId,
    senderKind: 'system',
    kind: 'system',
    content,
    metadata,
    createdAt: '2026-08-22T00:00:00.000Z',
  }
}
