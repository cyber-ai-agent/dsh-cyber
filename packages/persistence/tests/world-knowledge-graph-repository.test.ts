import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore, WorldArtifactRepository, WorldKnowledgeGraphRepository, WorldKnowledgeRepository } from '../src/index.js'

const stores: SqliteStore[] = []

const hash = (seed: string): string => seed.repeat(64).slice(0, 64)

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function database(): Promise<SqliteStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-graph-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  return store
}

describe('WorldKnowledgeGraphRepository', () => {
  it('stores evidence-backed entities, claims and relations without crossing worlds', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '图谱工作区' })
    const otherWorkspace = store.createWorkspace({ name: '另一个工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '研究世界', templateId: 'cyber-company' })
    const otherWorld = store.createWorld({ workspaceId: otherWorkspace.id, name: '隔离世界', templateId: 'tavern' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const subject = repository.upsertEntity({
      workspaceId: workspace.id, worldId: world.id, type: 'project', canonicalName: '知识图谱', aliases: ['长期知识'],
      summary: '用于保存世界事实',
    })
    const target = repository.upsertEntity({
      workspaceId: workspace.id, worldId: world.id, type: 'concept', canonicalName: '证据',
    })
    const evidence = repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'manual', createdBy: 'owner', excerpt: '所有长期知识都要能回到证据。',
    })
    expect(() => repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: 'requires', objectEntityId: target.id,
    })).toThrow('require evidence')
    const claim = repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: 'requires', objectEntityId: target.id, evidenceIds: [evidence.id], confidence: 0.95,
    })
    const relation = repository.upsertRelation({
      workspaceId: workspace.id, worldId: world.id, fromEntityId: subject.id, toEntityId: target.id,
      predicate: '依据', evidenceIds: [evidence.id], confidence: 0.9,
    })
    expect(repository.getGraph(world.id)).toMatchObject({
      worldId: world.id,
      entities: expect.arrayContaining([expect.objectContaining({ id: subject.id }), expect.objectContaining({ id: target.id })]),
      claims: [expect.objectContaining({ id: claim.id, evidenceIds: [evidence.id] })],
      relations: [expect.objectContaining({ id: relation.id, evidenceIds: [evidence.id] })],
      evidence: [expect.objectContaining({ id: evidence.id, sourceWeight: 1 })],
    })
    expect(repository.listEvidence({ worldId: world.id, claimIds: [claim.id], relationIds: [relation.id], limit: 10 })).toEqual([
      expect.objectContaining({ id: evidence.id }),
    ])
    expect(repository.listEntities(otherWorld.id)).toEqual([])
    expect(() => repository.upsertClaim({
      workspaceId: otherWorkspace.id, worldId: otherWorld.id, type: 'fact', subjectEntityId: subject.id,
      predicate: '越界', objectText: '不应写入', evidenceIds: [evidence.id],
    })).toThrow('outside this world')
  })

  it('rejects hidden conversation evidence and keeps source references world-scoped', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '会话证据' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '对话世界', templateId: 'cyber-company' })
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '事实采集' })
    const hidden = store.appendMessage({ sessionId: session.id, senderId: 'system', senderKind: 'system', kind: 'tool-result', content: '内部工具结果' })
    expect(() => new WorldKnowledgeGraphRepository(store.database).createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'conversation', sessionId: session.id,
      messageId: hidden.id, sequence: hidden.sequence, excerpt: hidden.content,
    })).toThrow('visible conversation')
    const visible = store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '世界事实' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    expect(repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'conversation', sessionId: session.id,
      messageId: visible.id, sequence: visible.sequence, excerpt: visible.content,
    })).toMatchObject({ sourceType: 'conversation', sessionId: session.id, sequence: visible.sequence, sourceWeight: 0.9 })
    const assistant = store.appendMessage({ sessionId: session.id, senderId: 'employee-1', senderKind: 'employee', kind: 'assistant', content: '角色回答' })
    expect(repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'conversation', sessionId: session.id,
      messageId: assistant.id, sequence: assistant.sequence, excerpt: assistant.content,
    })).toMatchObject({ sourceType: 'conversation', sourceWeight: 0.55 })
  })

  it('persists a compare-and-set cursor and idempotent restart-safe jobs', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '作业恢复' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '作业世界', templateId: 'cyber-company' })
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '知识整理' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    expect(repository.advanceConversationCursor({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id, expectedThroughSequence: 0, processedThroughSequence: 6,
    })).toMatchObject({ processedThroughSequence: 6 })
    expect(() => repository.advanceConversationCursor({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id, expectedThroughSequence: 0, processedThroughSequence: 7,
    })).toThrow('changed concurrently')
    const first = repository.enqueueConsolidationJob({ workspaceId: workspace.id, worldId: world.id, sourceType: 'conversation', sourceId: session.id, fromCursor: 0, toCursor: 6 })
    const duplicate = repository.enqueueConsolidationJob({ workspaceId: workspace.id, worldId: world.id, sourceType: 'conversation', sourceId: session.id, fromCursor: 0, toCursor: 6 })
    expect(duplicate.id).toBe(first.id)
    expect(repository.claimNextConsolidationJob(world.id)).toMatchObject({ id: first.id, status: 'running', attempt: 1 })
    expect(repository.recoverRunningConsolidationJobs(world.id)).toBe(1)
    expect(repository.claimNextConsolidationJob(world.id)).toMatchObject({ id: first.id, status: 'running', attempt: 2 })
    expect(repository.completeConsolidationJob(world.id, first.id).status).toBe('completed')
    expect(repository.listConsolidationJobs(world.id)).toHaveLength(1)
  })

  it('requeues a failed consolidation job and clears terminal failure state', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '重试作业' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '重试世界', templateId: 'cyber-company' })
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '知识重试' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const job = repository.enqueueConsolidationJob({
      workspaceId: workspace.id,
      worldId: world.id,
      sourceType: 'conversation',
      sourceId: session.id,
      fromCursor: 0,
      toCursor: 1,
    })

    expect(repository.claimConsolidationJob(job.id)).toMatchObject({ status: 'running', attempt: 1 })
    expect(repository.failConsolidationJob(world.id, job.id, 'knowledge_model_timeout')).toMatchObject({
      status: 'failed',
      errorCode: 'knowledge_model_timeout',
    })
    const requeued = repository.requeueConsolidationJob(world.id, job.id)
    expect(requeued).toMatchObject({
      status: 'queued',
      attempt: 1,
    })
    expect(requeued).not.toHaveProperty('errorCode')
    expect(requeued).not.toHaveProperty('startedAt')
    expect(requeued).not.toHaveProperty('completedAt')
    expect(repository.claimConsolidationJob(job.id)).toMatchObject({ status: 'running', attempt: 2 })
  })

  it('suppresses archived auto knowledge by semantic fingerprint and preserves it for audit', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '抑制测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '抑制世界', templateId: 'cyber-company' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const entity = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'topic', canonicalName: '主题' })
    const evidence = repository.createEvidence({ workspaceId: workspace.id, worldId: world.id, sourceType: 'manual', createdBy: 'owner', excerpt: '旧事实' })
    const claim = repository.upsertClaim({ workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: entity.id, predicate: 'is', objectText: '旧事实', evidenceIds: [evidence.id] })
    repository.archiveClaim(world.id, claim.id)
    expect(repository.isSuppressed(world.id, 'claim', `claim:${entity.id}:is:旧事实`)).toBe(true)
    expect(() => repository.upsertClaim({ workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: entity.id, predicate: 'is', objectText: '旧事实', evidenceIds: [evidence.id] })).toThrow('suppressed')
    expect(repository.getClaim(world.id, claim.id)).toMatchObject({ status: 'archived' })
    expect(repository.restoreClaim(world.id, claim.id)).toMatchObject({ status: 'active' })
    expect(repository.isSuppressed(world.id, 'claim', `claim:${entity.id}:is:旧事实`)).toBe(false)
    expect(repository.upsertClaim({ workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: entity.id, predicate: 'is', objectText: '旧事实', evidenceIds: [evidence.id], id: claim.id })).toMatchObject({ status: 'active' })
  })

  it('keeps graph rows when history pruning removes telemetry', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '保留测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '保留世界', templateId: 'cyber-company' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const entity = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'concept', canonicalName: '保留' })
    const evidence = repository.createEvidence({ workspaceId: workspace.id, worldId: world.id, sourceType: 'manual', createdBy: 'owner', excerpt: '不可被历史清理删除' })
    repository.upsertClaim({ workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: entity.id, predicate: 'status', objectText: 'active', evidenceIds: [evidence.id] })
    store.pruneHistory({ workspaceId: workspace.id, before: '2999-01-01T00:00:00.000Z' })
    expect(repository.getEntity(world.id, entity.id)).toBeDefined()
    expect(repository.getEvidence(world.id, evidence.id)).toBeDefined()
    expect(repository.listClaims(world.id)).toHaveLength(1)
  })

  it('searches entities and claims in SQLite with world scope and relevance ordering', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '搜索测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '搜索世界', templateId: 'cyber-company' })
    const otherWorld = store.createWorld({ workspaceId: workspace.id, name: '另一个世界', templateId: 'cyber-company' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const exact = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'project', canonicalName: '星图', summary: '值班安排' })
    const prefix = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'project', canonicalName: '星图计划' })
    repository.upsertEntity({ workspaceId: workspace.id, worldId: otherWorld.id, type: 'project', canonicalName: '星图' })
    const evidence = repository.createEvidence({ workspaceId: workspace.id, worldId: world.id, sourceType: 'manual', createdBy: 'owner', excerpt: '星图负责夜间值班' })
    const claim = repository.upsertClaim({ workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: exact.id, predicate: '负责', objectText: '夜间值班', evidenceIds: [evidence.id], confidence: 0.9 })

    expect(repository.searchEntities(world.id, '星图', 10).map((item) => item.id)).toEqual([exact.id, prefix.id])
    expect(repository.searchClaims(world.id, '夜间', 10).map((item) => item.id)).toEqual([claim.id])
    expect(repository.searchEntities(otherWorld.id, '值班', 10)).toEqual([])
  })

  it('applies an extraction batch atomically and is idempotent after restart', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '整理批次' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '整理世界', templateId: 'cyber-company' })
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '事实整理' })
    const message = store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '项目使用证据' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const job = repository.enqueueConsolidationJob({ workspaceId: workspace.id, worldId: world.id, sourceType: 'conversation', sourceId: session.id, fromCursor: 0, toCursor: message.sequence })
    expect(repository.claimConsolidationJob(job.id)).toMatchObject({ status: 'running' })
    const extraction = {
      entities: [
        { key: 'project', type: 'project' as const, canonicalName: '知识项目', aliases: [], evidenceRefs: ['e1'] },
        { key: 'evidence', type: 'concept' as const, canonicalName: '证据', aliases: [], evidenceRefs: ['e1'] },
      ],
      claims: [{ key: 'claim', type: 'fact' as const, subjectKey: 'project', predicate: 'uses', objectKey: 'evidence', confidence: 0.9, evidenceRefs: ['e1'] }],
      relations: [{ key: 'relation', fromKey: 'project', toKey: 'evidence', predicate: 'depends-on', confidence: 0.8, evidenceRefs: ['e1'] }],
      evidenceRefs: [{ sourceType: 'conversation' as const, sourceId: session.id, evidenceId: 'e1' }],
    }
    const evidence = [{ evidenceId: 'e1', sourceType: 'conversation' as const, sourceId: session.id, excerpt: message.content, worldId: world.id, workspaceId: workspace.id, sessionId: session.id, messageId: message.id, sequence: message.sequence }]
    const apply = { jobId: job.id, workspaceId: workspace.id, worldId: world.id, extraction, evidence, sourceType: 'conversation' as const, sourceId: session.id, now: new Date().toISOString() }
    repository.applyKnowledgeExtraction(apply)
    repository.applyKnowledgeExtraction(apply)
    expect(repository.listEntities(world.id)).toHaveLength(2)
    expect(repository.listClaims(world.id)).toHaveLength(1)
    expect(repository.listRelations(world.id)).toHaveLength(1)
    expect(repository.completeConsolidationJob({ jobId: job.id, toCursor: message.sequence }).status).toBe('completed')
    expect(repository.getConversationCursor(world.id, session.id)?.processedThroughSequence).toBe(message.sequence)
  })

  it('supersedes weaker assistant claims and keeps equally trusted owner claims conflicted', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '冲突整理' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '冲突世界', templateId: 'cyber-company' })
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '数据库决策' })
    const messages = [
      store.appendMessage({ sessionId: session.id, senderId: 'assistant', senderKind: 'employee', kind: 'assistant', content: '数据库使用 MySQL' }),
      store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '数据库改为 SQLite' }),
      store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '数据库改为 PostgreSQL' }),
    ]
    const repository = new WorldKnowledgeGraphRepository(store.database)

    for (const [index, message] of messages.entries()) {
      const job = repository.enqueueConsolidationJob({
        workspaceId: workspace.id,
        worldId: world.id,
        sourceType: 'conversation',
        sourceId: session.id,
        fromCursor: message.sequence - 1,
        toCursor: message.sequence,
      })
      repository.claimConsolidationJob(job.id)
      const objectText = ['MySQL', 'SQLite', 'PostgreSQL'][index]!
      repository.applyKnowledgeExtraction({
        jobId: job.id,
        workspaceId: workspace.id,
        worldId: world.id,
        sourceType: 'conversation',
        sourceId: session.id,
        extraction: {
          entities: [{ key: 'database', type: 'technology', canonicalName: '数据库', aliases: [], evidenceRefs: [`e${index}`] }],
          claims: [{ key: `claim-${index}`, type: 'decision', subjectKey: 'database', predicate: '使用', objectText, confidence: 0.9, evidenceRefs: [`e${index}`] }],
          relations: [],
          evidenceRefs: [{ sourceType: 'conversation', sourceId: session.id, evidenceId: `e${index}` }],
        },
        evidence: [{
          evidenceId: `e${index}`,
          sourceType: 'conversation',
          sourceId: session.id,
          excerpt: message.content,
          worldId: world.id,
          workspaceId: workspace.id,
          sessionId: session.id,
          messageId: message.id,
          sequence: message.sequence,
        }],
        now: new Date(Date.now() + index).toISOString(),
      })
    }

    const claims = repository.listClaims(world.id, { includeArchived: true })
    const mysql = claims.find((claim) => claim.objectText === 'MySQL')
    const sqlite = claims.find((claim) => claim.objectText === 'SQLite')
    const postgres = claims.find((claim) => claim.objectText === 'PostgreSQL')
    expect(mysql).toMatchObject({ status: 'superseded', supersededById: sqlite?.id })
    expect(sqlite).toMatchObject({ status: 'active' })
    expect(postgres).toMatchObject({ status: 'conflicted', conflictGroup: sqlite?.conflictGroup })
    expect(sqlite?.conflictGroup).toBeTruthy()
  })

  it('applies owner-confirmed manual extraction without creating an automatic job', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '手动整理' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '手动世界', templateId: 'cyber-company' })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const extraction = {
      entities: [{ key: 'topic', type: 'topic' as const, canonicalName: '用户确认主题', aliases: [], evidenceRefs: ['manual-1'] }],
      claims: [{ key: 'claim', type: 'fact' as const, subjectKey: 'topic', predicate: '状态', objectText: '已确认', confidence: 1, evidenceRefs: ['manual-1'] }],
      relations: [],
      evidenceRefs: [{ sourceType: 'manual' as const, sourceId: 'note-1', evidenceId: 'manual-1' }],
    }
    const input = {
      workspaceId: workspace.id,
      worldId: world.id,
      extraction,
      evidence: [{ evidenceId: 'manual-1', sourceType: 'manual' as const, sourceId: 'note-1', excerpt: '用户确认主题已确认', worldId: world.id, workspaceId: workspace.id, createdBy: 'owner' as const }],
      sourceId: 'note-1',
      now: new Date().toISOString(),
    }
    repository.applyManualKnowledgeExtraction(input)
    repository.applyManualKnowledgeExtraction(input)
    expect(repository.listConsolidationJobs(world.id)).toEqual([])
    expect(repository.listClaims(world.id)).toMatchObject([expect.objectContaining({ source: 'manual' })])
    expect(repository.listEvidence(world.id)).toMatchObject([{ sourceType: 'manual', sourceWeight: 1 }])
  })

  it('keeps a per-version chunk cursor that only moves forward from the expected watermark', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '分块游标' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '分块世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/long.md', title: '长资料',
      mimeType: 'text/markdown', byteLength: 64, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, Array.from({ length: 37 }, (_, ordinal) => ({
      ordinal, content: `第 ${ordinal} 块内容`, contentHash: hash(String(ordinal % 2)),
    })))
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const version = repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 37,
    })
    expect(version).toMatchObject({ contentHash: hash('a'), chunkTotal: 37, processedChunks: 0 })
    expect(version.completedAt).toBeUndefined()

    // Begin is idempotent: a resumed job must not reset a watermark.
    expect(repository.advanceKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), expectedProcessedChunks: 0, processedChunks: 12,
    })).toMatchObject({ processedChunks: 12 })
    expect(repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 37,
    })).toMatchObject({ processedChunks: 12 })

    // A stale window (the watermark moved on) never advances the cursor.
    expect(repository.advanceKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), expectedProcessedChunks: 0, processedChunks: 20,
    })).toMatchObject({ processedChunks: 12 })

    expect(repository.getKnowledgeSourceVersion({ worldId: world.id, sourceType: 'document', sourceId: document.id }))
      .toMatchObject({ processedChunks: 12, chunkTotal: 37 })
    expect(repository.advanceKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), expectedProcessedChunks: 12, processedChunks: 37,
    })).toMatchObject({ processedChunks: 37, completedAt: expect.any(String) })
  })

  it('starts a new version for changed content and leaves the previous claims for a later downgrade', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '来源版本' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '版本世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/changing.md', title: '会更新的资料',
      mimeType: 'text/markdown', byteLength: 8, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '第一版内容', contentHash: hash('a') }])
    const repository = new WorldKnowledgeGraphRepository(store.database)
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 1,
    })
    repository.advanceKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), expectedProcessedChunks: 0, processedChunks: 1,
    })
    const evidence = repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', documentId: document.id,
      chunkId: library.listChunks(world.id, document.id)[0]!.id, excerpt: '第一版内容',
    })
    const subject = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'topic', canonicalName: '第一版主题' })
    repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: '来自', objectText: '第一版内容', evidenceIds: [evidence.id],
    })

    const next = repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('b'), chunkTotal: 4,
    })
    expect(next).toMatchObject({ contentHash: hash('b'), chunkTotal: 4, processedChunks: 0 })
    expect(repository.getKnowledgeSourceVersion({ worldId: world.id, sourceType: 'document', sourceId: document.id }))
      .toMatchObject({ contentHash: hash('b') })
    // The invalidation seam: the old version is marked, never silently dropped,
    // and its claims stay active until an explicit downgrade pass decides.
    expect(repository.listSupersededKnowledgeSourceVersions(world.id))
      .toMatchObject([{ contentHash: hash('a'), supersededByHash: hash('b'), supersededAt: expect.any(String) }])
    expect(repository.listClaims(world.id)).toMatchObject([{ status: 'active', predicate: '来自' }])
  })

  it('reports the source watermark on consolidation jobs and resumes a manual run mid-document', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '水位投影' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '水位世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/watermark.md', title: '水位资料',
      mimeType: 'text/markdown', byteLength: 16, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, Array.from({ length: 8 }, (_, ordinal) => ({
      ordinal, content: `水位第 ${ordinal} 块`, contentHash: hash(String(ordinal % 2)),
    })))
    const repository = new WorldKnowledgeGraphRepository(store.database)
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 8,
    })
    repository.advanceKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), expectedProcessedChunks: 0, processedChunks: 3,
    })
    // A manual "吸收到知识图谱" run resumes at chunk 3 rather than starting over.
    const job = repository.createConsolidationJob({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
    })
    expect(job).toMatchObject({ fromCursor: 3, processedChunks: 3, chunkTotal: 8 })
    expect(repository.listConsolidationJobs(world.id))
      .toMatchObject([{ id: job.id, processedChunks: 3, chunkTotal: 8 }])
  })

  it('reopens a completed window that no source version accounts for', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '迁移前任务' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '迁移前世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/legacy.md', title: '迁移前资料',
      mimeType: 'text/markdown', byteLength: 32, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, Array.from({ length: 6 }, (_, ordinal) => ({
      ordinal, content: `旧第 ${ordinal} 块`, contentHash: hash(String(ordinal % 2)),
    })))
    const repository = new WorldKnowledgeGraphRepository(store.database)
    // The pre-42 shape: one window over the whole source, completed, and no
    // version row saying how many chunks it actually read. The revision is the
    // source row's own timestamp, which indexing has already moved once.
    const revision = Date.parse(library.getDocument(world.id, document.id)!.updatedAt)
    const legacy = repository.enqueueConsolidationJob({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      fromCursor: 0, toCursor: revision,
    })
    repository.completeConsolidationJob({ jobId: legacy.id })
    expect(repository.getKnowledgeSourceVersion({ worldId: world.id, sourceType: 'document', sourceId: document.id })).toBeUndefined()

    // Enqueueing that window again must not hand back a completion nobody can
    // verify, and must not invent a watermark for it either.
    expect(repository.createConsolidationJob({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
    })).toMatchObject({ id: legacy.id, status: 'queued', fromCursor: 0, toCursor: revision })
    expect(repository.listKnowledgeSourceVersions(world.id, 'document', document.id)).toEqual([])

    // Once the walk has recorded a complete watermark, the same window is
    // idempotent again: a completion under the new rules is trusted.
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 6,
    })
    repository.advanceKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), expectedProcessedChunks: 0, processedChunks: 6,
    })
    repository.completeConsolidationJob({ jobId: legacy.id })
    expect(repository.enqueueConsolidationJob({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      fromCursor: 0, toCursor: revision,
    })).toMatchObject({ id: legacy.id, status: 'completed', processedChunks: 6, chunkTotal: 6 })
  })

  it('downgrades only the statements a superseded version left without live evidence', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '证据失效' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '失效世界', templateId: 'cyber-company' })
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '讨论' })
    const message = store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '这条会话证据不随资料改写而消失。' })
    const library = new WorldKnowledgeRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/policy.md', title: '政策',
      mimeType: 'text/markdown', byteLength: 8, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '第一版政策', contentHash: hash('a') }])
    const repository = new WorldKnowledgeGraphRepository(store.database)
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 1,
    })
    repository.advanceKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), expectedProcessedChunks: 0, processedChunks: 1,
    })
    const fromDocument = repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', documentId: document.id,
      chunkId: library.listChunks(world.id, document.id)[0]!.id, excerpt: '第一版政策',
    })
    const fromChat = repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'conversation', sessionId: session.id,
      messageId: message.id, sequence: message.sequence, excerpt: message.content,
    })
    const subject = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'topic', canonicalName: '政策' })
    const team = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'organization', canonicalName: '团队' })
    const orphaned = repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: '只有资料证据', objectText: '第一版政策', evidenceIds: [fromDocument.id],
    })
    const coSupported = repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: '还有会话证据', objectText: '第一版政策', evidenceIds: [fromDocument.id, fromChat.id],
    })
    const orphanedRelation = repository.upsertRelation({
      workspaceId: workspace.id, worldId: world.id, fromEntityId: subject.id, toEntityId: team.id,
      predicate: '写给', evidenceIds: [fromDocument.id],
    })

    // The owner edits the source: new text, new hash, previous version superseded.
    library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/policy.md', title: '政策',
      mimeType: 'text/markdown', byteLength: 9, sha256: hash('b'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '第二版政策', contentHash: hash('b') }])
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('b'), chunkTotal: 1,
    })

    expect(repository.listPendingKnowledgeSourceInvalidations(world.id)).toMatchObject([{ contentHash: hash('a') }])
    expect(repository.invalidateKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id, contentHash: hash('a'),
    })).toMatchObject({ claims: 1, relations: 1 })

    expect(repository.getClaim(world.id, orphaned.id)).toMatchObject({
      notCurrent: { sourceType: 'document', sourceId: document.id, contentHash: hash('a'), since: expect.any(String) },
    })
    expect(repository.getClaim(world.id, coSupported.id)?.notCurrent).toBeUndefined()
    expect(repository.getRelation(world.id, orphanedRelation.id)?.notCurrent).toMatchObject({ contentHash: hash('a') })

    // Nothing was deleted: every row the owner gathered is still readable.
    expect(repository.listClaims(world.id, { includeArchived: true }).map((claim) => claim.id).sort())
      .toEqual([orphaned.id, coSupported.id].sort())
    expect(repository.getEvidence(world.id, fromDocument.id)).toMatchObject({ id: fromDocument.id, excerpt: '第一版政策' })
    expect(repository.getRelation(world.id, orphanedRelation.id)).toMatchObject({ id: orphanedRelation.id, predicate: '写给' })

    // Idempotent: the work list is empty and a forced re-run changes nothing.
    const downgraded = repository.getClaim(world.id, orphaned.id)
    expect(repository.listPendingKnowledgeSourceInvalidations(world.id)).toEqual([])
    expect(repository.invalidateKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id, contentHash: hash('a'),
    })).toMatchObject({ claims: 0, relations: 0 })
    expect(repository.getClaim(world.id, orphaned.id)).toEqual(downgraded)
  })

  it('keeps a downgraded claim out of retrieval while the library still lists it', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '检索排除' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '检索世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/pricing.md', title: '定价',
      mimeType: 'text/markdown', byteLength: 8, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '旧定价', contentHash: hash('a') }])
    const repository = new WorldKnowledgeGraphRepository(store.database)
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 1,
    })
    const evidence = repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', documentId: document.id,
      chunkId: library.listChunks(world.id, document.id)[0]!.id, excerpt: '旧定价',
    })
    const subject = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'topic', canonicalName: '定价' })
    const claim = repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: '每席位月费', objectText: '99 元', evidenceIds: [evidence.id],
    })
    expect(repository.searchClaims(world.id, '每席位月费', 10).map((item) => item.id)).toEqual([claim.id])

    library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/pricing.md', title: '定价',
      mimeType: 'text/markdown', byteLength: 9, sha256: hash('b'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '新定价', contentHash: hash('b') }])
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('b'), chunkTotal: 1,
    })
    repository.invalidateKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id, contentHash: hash('a'),
    })

    // A superseded fact must stop reaching the model, and stay visible to the owner.
    expect(repository.searchClaims(world.id, '每席位月费', 10)).toEqual([])
    expect(repository.listClaims(world.id).map((item) => item.id)).toEqual([claim.id])
  })

  it('retires the version of a removed document and of an archived artifact, then reinstates a restored one', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '删除归档' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '归档世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/removed.md', title: '会删除的资料',
      mimeType: 'text/markdown', byteLength: 8, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '待删除内容', contentHash: hash('a') }])
    const artifacts = new WorldArtifactRepository(store.database)
    const published = artifacts.publish({
      workspaceId: workspace.id, worldId: world.id, title: '归档产物', kind: 'markdown',
      relativePath: 'artifacts/archived/v1.md', byteLength: 12, sha256: hash('c'),
      createdByKind: 'owner', createdById: 'owner-1',
    })
    const repository = new WorldKnowledgeGraphRepository(store.database)
    for (const source of [
      { sourceType: 'document' as const, sourceId: document.id, contentHash: hash('a') },
      { sourceType: 'artifact' as const, sourceId: published.artifact.id, contentHash: 'v1' },
    ]) {
      repository.beginKnowledgeSourceVersion({ workspaceId: workspace.id, worldId: world.id, ...source, chunkTotal: 1 })
    }
    const documentEvidence = repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', documentId: document.id,
      chunkId: library.listChunks(world.id, document.id)[0]!.id, excerpt: '待删除内容',
    })
    const artifactEvidence = repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'artifact', artifactId: published.artifact.id,
      artifactVersion: 1, excerpt: '归档产物内容',
    })
    const subject = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'topic', canonicalName: '归档主题' })
    const fromDocument = repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: '来自被删除资料', objectText: '待删除内容', evidenceIds: [documentEvidence.id],
    })
    const fromArtifact = repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: '来自被归档产物', objectText: '归档产物内容', evidenceIds: [artifactEvidence.id],
    })

    library.deleteDocument(world.id, document.id)
    artifacts.archive(world.id, published.artifact.id)
    // Deletion and archival travel the same seam: the version is superseded,
    // with no replacement hash because no replacement content exists.
    expect(repository.retireRemovedKnowledgeSources(world.id).map((version) => version.sourceId).sort())
      .toEqual([document.id, published.artifact.id].sort())
    expect(repository.listSupersededKnowledgeSourceVersions(world.id))
      .toMatchObject([{ supersededAt: expect.any(String) }, { supersededAt: expect.any(String) }])
    expect(repository.listSupersededKnowledgeSourceVersions(world.id).every((version) => version.supersededByHash === undefined)).toBe(true)
    for (const version of repository.listPendingKnowledgeSourceInvalidations(world.id)) {
      repository.invalidateKnowledgeSourceVersion({ workspaceId: workspace.id, ...version })
    }
    expect(repository.getClaim(world.id, fromDocument.id)?.notCurrent).toMatchObject({ sourceType: 'document', sourceId: document.id })
    expect(repository.getClaim(world.id, fromArtifact.id)?.notCurrent).toMatchObject({ sourceType: 'artifact', sourceId: published.artifact.id })
    expect(repository.getEvidence(world.id, documentEvidence.id)).toBeDefined()

    // Restoring the artifact makes its version current again, so the claim that
    // stood on it is current again too — without re-running extraction.
    artifacts.restore(world.id, published.artifact.id)
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'artifact', sourceId: published.artifact.id,
      contentHash: 'v1', chunkTotal: 1,
    })
    expect(repository.reinstateCurrentKnowledgeSourceVersions(world.id)).toMatchObject({ claims: 1, relations: 0 })
    expect(repository.getClaim(world.id, fromArtifact.id)?.notCurrent).toBeUndefined()
    expect(repository.getClaim(world.id, fromDocument.id)?.notCurrent).toMatchObject({ sourceId: document.id })
  })

  it('clears the not-current mark when a live version re-states the same claim', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '重新核对' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '核对世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/reverify.md', title: '复核资料',
      mimeType: 'text/markdown', byteLength: 8, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '第一版结论', contentHash: hash('a') }])
    const repository = new WorldKnowledgeGraphRepository(store.database)
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 1,
    })
    const job = repository.enqueueConsolidationJob({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id, fromCursor: 0, toCursor: 1,
    })
    const firstChunk = library.listChunks(world.id, document.id)[0]!
    const extraction = (chunkId: string, evidenceId: string) => ({
      entities: [{ key: 'topic', type: 'topic' as const, canonicalName: '复核主题', aliases: [], evidenceRefs: [evidenceId] }],
      claims: [{ key: 'claim', type: 'fact' as const, subjectKey: 'topic', predicate: '结论', objectText: '保持不变', confidence: 0.9, evidenceRefs: [evidenceId] }],
      relations: [],
      evidenceRefs: [{ sourceType: 'document' as const, sourceId: document.id, evidenceId }],
    })
    const evidenceInput = (chunkId: string, evidenceId: string) => ([{
      evidenceId, sourceType: 'document' as const, sourceId: document.id, excerpt: '结论保持不变',
      worldId: world.id, workspaceId: workspace.id, documentId: document.id, chunkId,
    }])
    repository.applyKnowledgeExtraction({
      jobId: job.id, workspaceId: workspace.id, worldId: world.id,
      extraction: extraction(firstChunk.id, 'evidence-v1'), evidence: evidenceInput(firstChunk.id, 'evidence-v1'),
      sourceType: 'document', sourceId: document.id, now: new Date().toISOString(),
    })

    library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/reverify.md', title: '复核资料',
      mimeType: 'text/markdown', byteLength: 9, sha256: hash('b'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '第二版正文，结论未变', contentHash: hash('b') }])
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('b'), chunkTotal: 1,
    })
    repository.invalidateKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id, contentHash: hash('a'),
    })
    const claimId = repository.listClaims(world.id)[0]!.id
    expect(repository.getClaim(world.id, claimId)?.notCurrent).toMatchObject({ contentHash: hash('a') })
    expect(repository.searchClaims(world.id, '结论', 10)).toEqual([])

    // The new version re-states the same fact: it stands on live evidence again.
    const secondChunk = library.listChunks(world.id, document.id)[0]!
    const next = repository.enqueueConsolidationJob({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id, fromCursor: 1, toCursor: 2,
    })
    repository.applyKnowledgeExtraction({
      jobId: next.id, workspaceId: workspace.id, worldId: world.id,
      extraction: extraction(secondChunk.id, 'evidence-v2'), evidence: evidenceInput(secondChunk.id, 'evidence-v2'),
      sourceType: 'document', sourceId: document.id, now: new Date().toISOString(),
    })
    expect(repository.getClaim(world.id, claimId)?.notCurrent).toBeUndefined()
    expect(repository.searchClaims(world.id, '结论', 10).map((item) => item.id)).toEqual([claimId])
  })
})
