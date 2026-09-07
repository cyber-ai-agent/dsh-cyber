import { describe, expect, it } from 'vitest'
import type {
  ConversationSubmissionInput,
  ConversationSubmissionReceipt,
  ConversationSubmissionResult,
} from '@dsh-cyber/contracts'

import {
  ConversationIngressConflictError,
  ConversationIngressService,
  conversationIngressFingerprint,
  conversationPromptHash,
  type ConversationSubmissionStore,
} from '../src/services/conversation-ingress-service.js'

describe('ConversationIngressService', () => {
  it('normalizes set-like identity fields and binds every execution-affecting option', () => {
    const base = {
      workspaceId: 'workspace', worldId: 'world', clientTurnId: 'turn', kind: 'group' as const,
      promptHash: conversationPromptHash('同一请求'), employeeIds: ['b', 'a'],
      collaborationMode: 'task' as const, interactionKind: 'task' as const,
      queueMode: 'normal' as const, permissionMode: 'workspace-write' as const,
      reasoningEffort: 'high' as const, modelProfileIds: { b: 'model-b', a: 'model-a' },
      attachments: [{ assetId: 'asset-b', name: 'b.txt' }, { assetId: 'asset-a', name: 'a.txt' }],
    }
    expect(conversationIngressFingerprint(base)).toBe(conversationIngressFingerprint({
      ...base,
      employeeIds: ['a', 'b'],
      modelProfileIds: { a: 'model-a', b: 'model-b' },
      attachments: [...base.attachments].reverse(),
    }))
    expect(conversationIngressFingerprint(base)).not.toBe(conversationIngressFingerprint({
      ...base,
      permissionMode: 'read-only',
    }))
    expect(conversationIngressFingerprint(base)).not.toBe(conversationIngressFingerprint({
      ...base,
      promptHash: conversationPromptHash('另一请求'),
    }))
  })

  it('runs preparation and execution once while concurrent duplicates replay the receipt', async () => {
    const store = new FakeSubmissionStore()
    const service = new ConversationIngressService({ store })
    const identity = { workspaceId: 'workspace', worldId: 'world', clientTurnId: 'turn', fingerprintSha256: 'a'.repeat(64) }
    let prepared = 0
    let executed = 0
    let replayed = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const options = () => ({
      identity,
      prepare: async () => {
        prepared += 1
        await gate
        return { input: submission(identity), context: 'prepared' }
      },
      execute: async () => { executed += 1; return 'created' },
      replay: async () => { replayed += 1; return 'replayed' },
    })

    const first = service.run(options())
    const duplicate = service.run(options())
    await Promise.resolve()
    release()
    await expect(first).resolves.toMatchObject({ value: 'created', replayed: false })
    await expect(duplicate).resolves.toMatchObject({ value: 'replayed', replayed: true })
    expect({ prepared, executed, replayed, claims: store.claims }).toEqual({ prepared: 1, executed: 1, replayed: 1, claims: 1 })
  })

  it('rejects a concurrent key reused for another fingerprint before preparation', async () => {
    const service = new ConversationIngressService({ store: new FakeSubmissionStore() })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const firstIdentity = { workspaceId: 'workspace', worldId: 'world', clientTurnId: 'turn', fingerprintSha256: 'a'.repeat(64) }
    const first = service.run({
      identity: firstIdentity,
      prepare: async () => { await gate; return { input: submission(firstIdentity), context: undefined } },
      execute: () => 'created', replay: () => 'replayed',
    })
    await expect(service.run({
      identity: { ...firstIdentity, fingerprintSha256: 'b'.repeat(64) },
      prepare: () => { throw new Error('must not prepare') },
      execute: () => 'created', replay: () => 'replayed',
    })).rejects.toBeInstanceOf(ConversationIngressConflictError)
    release()
    await first
  })

  it('does not leak an unhandled coordination rejection when preparation fails without a waiter', async () => {
    const service = new ConversationIngressService({ store: new FakeSubmissionStore() })
    const identity = { workspaceId: 'workspace', worldId: 'world', clientTurnId: 'turn', fingerprintSha256: 'a'.repeat(64) }
    await expect(service.run({
      identity,
      prepare: () => { throw new Error('invalid request') },
      execute: () => 'created', replay: () => 'replayed',
    })).rejects.toThrow('invalid request')
    await Promise.resolve()
  })
})

class FakeSubmissionStore implements ConversationSubmissionStore {
  receipt: ConversationSubmissionReceipt | undefined
  claims = 0

  getConversationSubmissionClaim(): ConversationSubmissionReceipt | undefined { return this.receipt }

  claimConversationSubmission(input: ConversationSubmissionInput): ConversationSubmissionResult {
    this.claims += 1
    if (this.receipt !== undefined) return { created: false, ...this.receipt }
    this.receipt = receipt(input)
    return { created: true, ...this.receipt }
  }
}

function submission(identity: { workspaceId: string; worldId: string; clientTurnId: string; fingerprintSha256: string }): ConversationSubmissionInput {
  return {
    workspaceId: identity.workspaceId, worldId: identity.worldId,
    idempotencyKey: identity.clientTurnId, fingerprintSha256: identity.fingerprintSha256,
    sessionKind: 'direct', participantEmployeeIds: ['employee'], interactionKind: 'chat',
    ownerMessage: { content: '一次请求' },
  }
}

function receipt(input: ConversationSubmissionInput): ConversationSubmissionReceipt {
  const createdAt = '2026-09-06T00:00:00.000Z'
  return {
    claim: {
      id: 'claim', workspaceId: input.workspaceId, worldId: input.worldId,
      idempotencyKey: input.idempotencyKey, fingerprintSha256: input.fingerprintSha256,
      sessionId: 'session', workTurnId: 'turn', ownerMessageId: 'message', createdAt,
    },
    session: {
      id: 'session', workspaceId: input.workspaceId, worldId: input.worldId,
      kind: 'direct', collaborationMode: 'discussion', title: '私聊', status: 'open', createdAt, updatedAt: createdAt,
    },
    workTurn: {
      id: 'turn', workspaceId: input.workspaceId, worldId: input.worldId,
      sessionId: 'session', clientTurnId: input.idempotencyKey, interactionKind: 'chat', status: 'queued', createdAt,
    },
    ownerMessage: {
      id: 'message', sessionId: 'session', sequence: 1, senderId: 'owner', senderKind: 'owner',
      kind: 'user', content: input.ownerMessage.content, metadata: {}, createdAt,
    },
  }
}
