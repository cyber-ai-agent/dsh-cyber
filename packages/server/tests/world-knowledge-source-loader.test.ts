import { describe, expect, it, vi } from 'vitest'

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

  it('walks a long document one chunk window at a time and reports the version identity', async () => {
    const chunks = Array.from({ length: 37 }, (_, ordinal) => ({
      id: `chunk-${ordinal}`, worldId: 'world-a', documentId: 'doc-long', ordinal,
      content: `第 ${ordinal} 块正文`, contentHash: 'c'.repeat(64), createdAt: '2026-09-05T00:00:00.000Z',
    }))
    const loader = new WorldKnowledgeSourceLoader({
      documents: {
        getDocument: () => ({
          id: 'doc-long', workspaceId: 'workspace-a', worldId: 'world-a', relativePath: 'long.md', title: '长文档',
          mimeType: 'text/markdown', byteLength: 1_000, sha256: 'a'.repeat(64), origin: 'upload', status: 'indexed',
          chunkCount: chunks.length, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
        }),
        listChunks: () => chunks,
      },
      maxItems: 10,
    })
    const first = await loader.load({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'document', sourceId: 'doc-long' })
    expect(first).toMatchObject({ contentHash: 'a'.repeat(64), chunkTotal: 37, chunkCursor: 0, chunkExaminedThrough: 10 })
    expect(first.items).toHaveLength(10)
    expect(first.items[0]?.chunkOrdinal).toBe(0)

    const resumed = await loader.load({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'document', sourceId: 'doc-long', fromCursor: 30 })
    expect(resumed).toMatchObject({ chunkCursor: 30, chunkExaminedThrough: 37 })
    expect(resumed.items.map((item) => item.chunkOrdinal)).toEqual([30, 31, 32, 33, 34, 35, 36])

    // Past the end there is nothing left to examine, and the window never
    // reports having covered more chunks than the document has.
    const exhausted = await loader.load({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'document', sourceId: 'doc-long', fromCursor: 37 })
    expect(exhausted).toMatchObject({ chunkCursor: 37, chunkExaminedThrough: 37, items: [] })
  })

  it('windows an artifact longer than one extraction budget instead of silently truncating it', async () => {
    const body = 'x'.repeat(40_000)
    const loader = new WorldKnowledgeSourceLoader({
      artifacts: { async read() { return { workspaceId: 'workspace-a', worldId: 'world-a', artifactId: 'artifact-long', version: 4, body } } },
    })
    const first = await loader.load({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'artifact', sourceId: 'artifact-long' })
    expect(first).toMatchObject({ contentHash: 'v4', chunkTotal: 3, chunkCursor: 0, chunkExaminedThrough: 1 })
    expect(first.items[0]?.text).toHaveLength(16_000)
    const last = await loader.load({ workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'artifact', sourceId: 'artifact-long', fromCursor: 2 })
    expect(last).toMatchObject({ chunkCursor: 2, chunkExaminedThrough: 3 })
    expect(last.items[0]?.text).toHaveLength(8_000)
    expect(last.items[0]?.evidence.evidenceId).not.toBe(first.items[0]?.evidence.evidenceId)
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
  it('coalesces changed sources and bounds retries without repeating configuration failures', async () => {
    const now = Date.parse('2026-09-05T00:10:00.000Z')
    const revision = now - 60_000
    let job: any = undefined
    const enqueue = vi.fn(async () => ({} as never))
    const retryJob = vi.fn(async () => ({} as never))
    const scheduler = new WorldKnowledgeConsolidationScheduler({
      repository: {
        listWorlds: () => [{ workspaceId: 'workspace', worldId: 'world' }],
        listSessions: () => [],
        listSources: () => [{ sourceType: 'document', sourceId: 'doc', updatedAt: new Date(revision).toISOString() }],
        getConsolidationSourceJob: () => job,
      },
      messages: { listMessagesPage: () => ({ items: [] }) },
      service: { enqueue, retryJob, enqueueConversation: vi.fn() }, clockMs: () => now,
    })
    await scheduler.scanOnce()
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'doc', toCursor: revision }))
    enqueue.mockClear()
    job = { id: 'job', worldId: 'world', status: 'running', toCursor: revision - 1 }
    await scheduler.scanOnce()
    expect(enqueue).not.toHaveBeenCalled()
    job = { ...job, status: 'completed', toCursor: revision }
    await scheduler.scanOnce()
    expect(enqueue).not.toHaveBeenCalled()
    job = { ...job, status: 'failed', attempt: 1, errorCode: 'knowledge_model_timeout', updatedAt: new Date(now - 10_000).toISOString() }
    await scheduler.scanOnce()
    expect(retryJob).not.toHaveBeenCalled()
    job.updatedAt = new Date(now - 31_000).toISOString()
    await scheduler.scanOnce()
    expect(retryJob).toHaveBeenCalledWith('world', 'job')
    retryJob.mockClear()
    job.attempt = 3
    await scheduler.scanOnce()
    expect(retryJob).not.toHaveBeenCalled()
    job.attempt = 1
    job.errorCode = 'knowledge_model_credential_rejected'
    await scheduler.scanOnce()
    expect(retryJob).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    job.toCursor = revision - 1
    await scheduler.scanOnce()
    expect(enqueue).toHaveBeenCalledOnce()
  })

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

  it('keeps queueing the next chunk window until the source watermark is complete', async () => {
    const now = Date.parse('2026-09-05T00:10:00.000Z')
    const revision = now - 60_000
    const enqueue = vi.fn(async () => ({} as never))
    let version: { chunkTotal: number; processedChunks: number } | undefined
    const job = {
      id: 'job-doc', worldId: 'world', workspaceId: 'workspace', sourceType: 'document' as const, sourceId: 'doc',
      status: 'completed' as const, attempt: 1, fromCursor: 0, toCursor: revision,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:05:00.000Z',
    }
    const scheduler = new WorldKnowledgeConsolidationScheduler({
      repository: {
        listWorlds: () => [{ workspaceId: 'workspace', worldId: 'world' }],
        listSessions: () => [],
        listSources: () => [{ sourceType: 'document', sourceId: 'doc', updatedAt: new Date(revision).toISOString() }],
        getConsolidationSourceJob: () => job,
        getKnowledgeSourceProgress: () => version === undefined ? undefined : {
          workspaceId: 'workspace', worldId: 'world', sourceType: 'document', sourceId: 'doc',
          contentHash: 'a'.repeat(64), createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:05:00.000Z',
          ...version,
        },
      },
      messages: { listMessagesPage: () => ({ items: [] }) },
      service: { enqueue, enqueueConversation: vi.fn() },
      clockMs: () => now,
    })

    // A completed job over a partly processed document is not a finished
    // document: the next window starts exactly where the watermark stopped.
    version = { chunkTotal: 37, processedChunks: 12 }
    await scheduler.scanOnce()
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'doc', fromCursor: 12, toCursor: revision }))

    enqueue.mockClear()
    version = { chunkTotal: 37, processedChunks: 37 }
    await scheduler.scanOnce()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('re-walks a source whose completed job predates the watermark instead of trusting it', async () => {
    const now = Date.parse('2026-09-05T00:10:00.000Z')
    const revision = now - 60_000
    const enqueue = vi.fn(async () => ({} as never))
    // Exactly what a pre-42 run left behind: the window was recorded as done
    // with fromCursor 0 and the source revision as toCursor, and no source
    // version row was ever written, so how much of the document that run
    // actually covered is unknown.
    const legacyJob = {
      id: 'legacy-job', worldId: 'world', workspaceId: 'workspace', sourceType: 'document' as const, sourceId: 'doc',
      status: 'completed' as const, attempt: 1, fromCursor: 0, toCursor: revision,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:05:00.000Z',
    }
    const scheduler = new WorldKnowledgeConsolidationScheduler({
      repository: {
        listWorlds: () => [{ workspaceId: 'workspace', worldId: 'world' }],
        listSessions: () => [],
        listSources: () => [{ sourceType: 'document', sourceId: 'doc', updatedAt: new Date(revision).toISOString() }],
        getConsolidationSourceJob: () => legacyJob,
        // No row for this source: the watermark table knows nothing about it.
        getKnowledgeSourceProgress: () => undefined,
      },
      messages: { listMessagesPage: () => ({ items: [] }) },
      service: { enqueue, enqueueConversation: vi.fn() },
      clockMs: () => now,
    })

    await scheduler.scanOnce()
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'doc', fromCursor: 0, toCursor: revision }))
  })
})
