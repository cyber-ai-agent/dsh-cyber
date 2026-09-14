import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SqliteStore } from '@dsh-cyber/persistence'

import { ConversationHubService } from '../src/services/conversation-hub-service.js'

describe('ConversationHubService read state', () => {
  it('keeps the read cursor monotonic and bounded by the latest employee message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-conversation-hub-'))
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    try {
      const workspace = store.createWorkspace({ name: '会话工作区' })
      const world = store.createWorld({ workspaceId: workspace.id, name: '会话世界', templateId: 'personal-world' })
      const session = store.createSession({
        workspaceId: workspace.id,
        worldId: world.id,
        kind: 'direct',
        title: '私聊',
        participants: [{ participantId: 'owner', kind: 'owner' }],
      })
      const first = store.appendMessage({ sessionId: session.id, senderId: 'employee-a', senderKind: 'employee', kind: 'assistant', content: '第一条回复' })
      const service = new ConversationHubService(store)

      await expect(service.setLastReadSeq(session.id, Number.NaN)).rejects.toMatchObject({ code: 'invalid_sequence' })
      expect((await service.list(world.id))[0]?.unread).toBe(true)
      expect((await service.setLastReadSeq(session.id, 999))[0]?.unread).toBeUndefined()

      const second = store.appendMessage({ sessionId: session.id, senderId: 'employee-a', senderKind: 'employee', kind: 'assistant', content: '第二条回复' })
      expect(second.sequence).toBeGreaterThan(first.sequence)
      expect((await service.list(world.id))[0]?.unread).toBe(true)

      await service.setLastReadSeq(session.id, second.sequence)
      expect((await service.setLastReadSeq(session.id, first.sequence))[0]?.unread).toBeUndefined()

      store.appendMessage({ sessionId: session.id, senderId: 'employee-a', senderKind: 'employee', kind: 'assistant', content: '第三条回复' })
      expect((await service.list(world.id))[0]?.unread).toBe(true)
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
