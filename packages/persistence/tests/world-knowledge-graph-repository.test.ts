import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore, WorldKnowledgeGraphRepository } from '../src/index.js'

const stores: SqliteStore[] = []

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
})
