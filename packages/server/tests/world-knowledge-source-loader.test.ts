import { describe, expect, it } from 'vitest'

import {
  createKnowledgeArtifactSourceReader,
  WorldKnowledgeSourceLoader,
} from '../src/services/world-knowledge-source-loader.js'
import { WorldKnowledgeConsolidationScheduler } from '../src/services/world-knowledge-consolidation-scheduler.js'

describe('WorldKnowledgeSourceLoader', () => {
  it('loads only visible conversation messages and enforces session scope', async () => {
    const loader = new WorldKnowledgeSourceLoader({
      conversations: {
        getSession: () => ({ id: 'session-a', workspaceId: 'workspace-a', worldId: 'world-a' }),
        listMessagesPage: () => ({ items: [
          { id: 'm1', sessionId: 'session-a', sequence: 1, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '用户事实', metadata: {}, createdAt: '2026-08-26T00:00:00.000Z' },
          { id: 'm2', sessionId: 'session-a', sequence: 2, senderId: 'agent', senderKind: 'employee', kind: 'assistant', content: '角色事实', metadata: {}, createdAt: '2026-08-26T00:00:01.000Z' },
          { id: 'm3', sessionId: 'session-a', sequence: 3, senderId: 'agent', senderKind: 'employee', kind: 'tool-result', content: '不应进入知识', metadata: {}, createdAt: '2026-08-26T00:00:02.000Z' },
        ] }),
      },
    })
    const batch = await loader.load({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 1 })
    expect(batch.items.map((item) => item.text)).toEqual(['角色事实'])
    expect(batch.items[0]?.evidence.messageId).toBe('m2')
    await expect(loader.load({ workspaceId: 'workspace-b', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a' })).rejects.toMatchObject({ code: 'knowledge_source_scope_mismatch' })
  })

  it('projects indexed documents and trusted artifact previews as evidence', async () => {
    const loader = new WorldKnowledgeSourceLoader({
      documents: {
        getDocument: () => ({ id: 'doc-a', workspaceId: 'workspace-a', worldId: 'world-a', relativePath: 'notes.md', title: '笔记', mimeType: 'text/markdown', byteLength: 4, sha256: 'hash', origin: 'upload', status: 'indexed', chunkCount: 1, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' }),
        listChunks: () => [{ id: 'chunk-a', worldId: 'world-a', documentId: 'doc-a', ordinal: 0, content: '文档事实', contentHash: 'hash', createdAt: '2026-08-26T00:00:00.000Z' }],
      },
      artifacts: {
        async read() { return { workspaceId: 'workspace-a', worldId: 'world-a', artifactId: 'artifact-a', version: 2, body: new TextEncoder().encode('产物事实') } },
      },
    })
    const document = await loader.load({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'document', sourceId: 'doc-a' })
    expect(document.items[0]?.evidence.chunkId).toBe('chunk-a')
    const artifact = await loader.load({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'artifact', sourceId: 'artifact-a' })
    expect(artifact.items[0]?.evidence.artifactVersion).toBe('2')
  })

  it('adapts the world artifact preview authority and rejects a foreign preview', async () => {
    const reader = createKnowledgeArtifactSourceReader({
      async preview() {
        return {
          artifact: { id: 'artifact-a', workspaceId: 'workspace-a', worldId: 'world-a', title: '结果' },
          version: { artifactId: 'artifact-a', version: 3 },
          body: new TextEncoder().encode('安全内容'),
        }
      },
    })
    const result = await reader.read({ workspaceId: 'workspace-a', worldId: 'world-a', artifactId: 'artifact-a', artifactVersion: '3' })
    expect(result?.version).toBe(3)
    await expect(reader.read({ workspaceId: 'workspace-a', worldId: 'world-a', artifactId: 'artifact-a', artifactVersion: 'x' })).rejects.toMatchObject({ code: 'knowledge_artifact_version_invalid' })
  })
})

describe('WorldKnowledgeConsolidationScheduler', () => {
  it('queues a balanced shared-group window without invoking extraction and preserves the durable cursor range', async () => {
    const queued: Array<{ workspaceId: string; worldId: string; sessionId: string; fromCursor?: number; toCursor?: number }> = []
    const scheduler = new WorldKnowledgeConsolidationScheduler({
      repository: {
        listWorlds: () => [{ workspaceId: 'workspace-a', worldId: 'world-a' }],
        listSessions: () => [{ id: 'session-a', workspaceId: 'workspace-a', worldId: 'world-a', kind: 'group', collaborationMode: 'discussion', title: '共享群聊', status: 'open', createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' }],
        getKnowledgeConsolidationSettings: () => ({ worldId: 'world-a', retrievalEnabled: true, autoConsolidationMode: 'balanced', updatedAt: '2026-08-26T00:00:00.000Z' }),
        getKnowledgeConsolidationCursor: () => ({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', processedThroughSequence: 0, updatedAt: '2026-08-26T00:00:00.000Z' }),
      },
      messages: {
        listMessagesPage: () => ({ items: Array.from({ length: 6 }, (_, index) => ({ id: `m${index + 1}`, sessionId: 'session-a', sequence: index + 1, senderId: 'owner', senderKind: 'owner' as const, kind: 'user' as const, content: `事实${index + 1}`, metadata: {}, createdAt: '2026-08-25T23:00:00.000Z' })) }),
      },
      service: { enqueueConversation: async (input) => { queued.push(input); return {} as never } },
      clockMs: () => Date.parse('2026-08-26T00:00:00.000Z'),
    })
    await expect(scheduler.scanOnce()).resolves.toEqual({ worlds: 1, sessions: 1, queued: 1 })
    expect(queued[0]).toMatchObject({ workspaceId: 'workspace-a', worldId: 'world-a', sessionId: 'session-a', fromCursor: 0, toCursor: 6 })
  })

  it('does not automatically promote a private direct conversation to world knowledge', async () => {
    const queued: unknown[] = []
    const scheduler = new WorldKnowledgeConsolidationScheduler({
      repository: {
        listWorlds: () => [{ workspaceId: 'workspace-a', worldId: 'world-a' }],
        listSessions: () => [{ id: 'private-a', workspaceId: 'workspace-a', worldId: 'world-a', kind: 'direct', title: '私聊', status: 'open', createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' }],
        getKnowledgeConsolidationSettings: () => ({ worldId: 'world-a', retrievalEnabled: true, autoConsolidationMode: 'balanced', updatedAt: '2026-08-26T00:00:00.000Z' }),
      },
      messages: {
        listMessagesPage: () => ({ items: Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, sessionId: 'private-a', sequence: index + 1, senderId: 'owner', senderKind: 'owner' as const, kind: 'user' as const, content: '这是一段足够长但只属于当前员工的私聊事实。'.repeat(20), metadata: {}, createdAt: '2026-08-25T23:00:00.000Z' })) }),
      },
      service: { enqueueConversation: async (input) => { queued.push(input); return {} as never } },
      clockMs: () => Date.parse('2026-08-26T00:00:00.000Z'),
    })

    await expect(scheduler.scanOnce()).resolves.toEqual({ worlds: 1, sessions: 0, queued: 0 })
    expect(queued).toEqual([])
  })
})
