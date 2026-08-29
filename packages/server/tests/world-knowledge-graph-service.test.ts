import { describe, expect, it } from 'vitest'

import {
  WorldKnowledgeGraphRetrievalService,
  WorldKnowledgeGraphService,
  type KnowledgeGraphClaim,
  type KnowledgeGraphEntity,
  type KnowledgeGraphEvidence,
  type KnowledgeGraphRelation,
  type KnowledgeGraphRepositoryPort,
} from '../src/services/world-knowledge-graph-service.js'
import { parseKnowledgeExtraction, KnowledgeExtractionError } from '../src/services/knowledge-extraction.js'
import {
  WorldKnowledgeConsolidationService,
  shouldConsolidate,
  type KnowledgeConsolidationJob,
  type KnowledgeConsolidationRepository,
  type KnowledgeSourceLoader,
} from '../src/services/world-knowledge-consolidation-service.js'

const entityA: KnowledgeGraphEntity = {
  id: 'entity-a', workspaceId: 'workspace-a', worldId: 'world-a', type: 'character',
  canonicalName: '林澈', aliases: [], summary: '负责观测。', status: 'active',
  createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
}
const entityB: KnowledgeGraphEntity = {
  id: 'entity-b', workspaceId: 'workspace-a', worldId: 'world-a', type: 'place',
  canonicalName: '远星观测站', aliases: ['观测站'], summary: '当前世界的观测设施。', status: 'active',
  createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
}
const claim: KnowledgeGraphClaim = {
  id: 'claim-a', workspaceId: 'workspace-a', worldId: 'world-a', type: 'fact',
  subjectEntityId: entityA.id, predicate: '负责', objectEntityId: entityB.id, confidence: 0.9,
  status: 'active', source: 'auto', evidenceIds: ['evidence-a'],
  createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
}
const relation: KnowledgeGraphRelation = {
  id: 'relation-a', workspaceId: 'workspace-a', worldId: 'world-a',
  fromEntityId: entityA.id, toEntityId: entityB.id, predicate: '驻守', confidence: 0.8,
  status: 'active', source: 'auto', evidenceIds: ['evidence-a'],
  createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
}
const evidence: KnowledgeGraphEvidence = {
  id: 'evidence-a', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation',
  sessionId: 'session-a', messageId: 'message-a', sequence: 1, excerpt: '林澈负责远星观测站。',
  sourceWeight: 0.9, createdAt: '2026-08-26T00:00:00.000Z',
}

function graphRepository(): KnowledgeGraphRepositoryPort {
  return {
    listEntities: ({ worldId, limit }) => worldId === 'world-a' ? [entityA, entityB].slice(0, limit) : [],
    listClaims: ({ worldId, entityIds, limit }) => worldId === 'world-a' && (entityIds === undefined || entityIds.includes(entityA.id)) ? [claim].slice(0, limit) : [],
    listRelations: ({ worldId, entityIds, limit }) => worldId === 'world-a' && (entityIds === undefined || entityIds.includes(entityA.id)) ? [relation].slice(0, limit) : [],
    getEntity: ({ worldId, entityId }) => worldId === 'world-a' && entityId === entityA.id ? entityA : worldId === 'world-a' && entityId === entityB.id ? entityB : undefined,
    listEvidence: ({ worldId, limit }) => worldId === 'world-a' ? [evidence].slice(0, limit) : [],
    searchEntities: ({ worldId, query, limit }) => worldId === 'world-a' && query.includes('林') ? [entityA].slice(0, limit) : [],
    searchClaims: ({ worldId, query, limit }) => worldId === 'world-a' && query.includes('负责') ? [claim].slice(0, limit) : [],
  }
}

describe('World Knowledge Graph service', () => {
  it('keeps graph reads world-scoped and caps overview nodes', async () => {
    const service = new WorldKnowledgeGraphService({ repository: graphRepository() })
    const view = await service.graph({ worldId: 'world-a', limit: 1 })
    expect(view.entities).toHaveLength(1)
    expect(view.entities[0]?.worldId).toBe('world-a')
    expect(view.claims.every((item) => item.worldId === 'world-a')).toBe(true)
    expect(await service.detail({ worldId: 'world-b', entityId: entityA.id })).toBeUndefined()
  })

  it('expands evidence-backed internal knowledge without side effects', async () => {
    const graph = new WorldKnowledgeGraphService({ repository: graphRepository() })
    const retrieval = new WorldKnowledgeGraphRetrievalService({ graph })
    const context = await retrieval.retrieve({ worldId: 'world-a', query: '负责', limit: 4 })
    expect(context?.text).toContain('[当前世界长期知识]')
    expect(context?.text).toContain('林澈')
    expect(context?.hits.some((item) => item.kind === 'claim')).toBe(true)
  })
})

describe('strict knowledge extraction', () => {
  const evidenceInput = [{
    evidenceId: 'evidence-a',
    sourceType: 'conversation' as const,
    sourceId: 'session-a',
    excerpt: '林澈负责远星观测站。',
    worldId: 'world-a',
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
    messageId: 'message-a',
    sequence: 1,
  }]

  it('accepts only current-batch evidence and rejects unknown fields', () => {
    const result = parseKnowledgeExtraction({
      entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'] }],
      claims: [{ key: 'claim', type: 'fact', subjectKey: 'lin', predicate: '负责', objectText: '远星观测站', confidence: 0.9, evidenceRefs: ['evidence-a'] }],
      relations: [],
      evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
    }, { sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput })
    expect(result.claims[0]?.confidence).toBe(0.9)
    expect(() => parseKnowledgeExtraction({
      entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['foreign'] }],
      claims: [], relations: [], evidenceRefs: [{ sourceType: 'document', sourceId: 'other-world-doc', evidenceId: 'foreign' }],
    }, { sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput })).toThrowError(KnowledgeExtractionError)
    expect(() => parseKnowledgeExtraction({
      entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'], injected: 'ignore' }],
      claims: [], relations: [], evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
    }, { sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput })).toThrow(/未知字段/)
  })
})

describe('knowledge consolidation lifecycle', () => {
  it('uses the background boundary and never sends hidden/tool content to extraction', async () => {
    expect(shouldConsolidate({ visibleMessages: 6, characters: 1, idleMs: 0, mode: 'balanced' })).toBe(true)
    expect(shouldConsolidate({ visibleMessages: 1, characters: 1, idleMs: 1, mode: 'off' })).toBe(false)

    const jobs: KnowledgeConsolidationJob[] = [{
      id: 'job-a', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
      fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0,
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }]
    let extractedText = ''
    let applied = 0
    const base = graphRepository()
    const repository = {
      ...base,
      listConsolidationJobs: () => jobs.filter((job) => job.status === 'queued'),
      createConsolidationJob: (input: Omit<KnowledgeConsolidationJob, 'status' | 'attempt' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: string }) => jobs[0]!,
      claimConsolidationJob: (jobId: string) => {
        const job = jobs.find((item) => item.id === jobId)
        if (job === undefined || job.status !== 'queued') return undefined
        job.status = 'running'; job.attempt += 1
        return job
      },
      applyKnowledgeExtraction: () => { applied += 1 },
      completeConsolidationJob: () => { jobs[0]!.status = 'completed'; return jobs[0]! },
      failConsolidationJob: (_input: { jobId: string; errorCode: string }) => { jobs[0]!.status = 'failed'; return jobs[0]! },
    } satisfies KnowledgeConsolidationRepository
    const sources: KnowledgeSourceLoader = {
      async load() {
        return {
          workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
          fromCursor: 0, toCursor: 1,
          items: [
            { kind: 'user', text: '林澈负责远星观测站。', evidence: { evidenceId: 'evidence-a', sourceType: 'conversation', sourceId: 'session-a', excerpt: '林澈负责远星观测站。', worldId: 'world-a', workspaceId: 'workspace-a', sessionId: 'session-a', messageId: 'message-a', sequence: 1 } },
          ],
        }
      },
    }
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources,
      extractor: {
        async extract(request) {
          extractedText = request.visibleText
          return {
            entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'] }],
            claims: [{ key: 'claim', type: 'fact', subjectKey: 'lin', predicate: '负责', objectText: '远星观测站', confidence: 0.9, evidenceRefs: ['evidence-a'] }],
            relations: [], evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
          }
        },
      },
    })
    await service.runNext()
    expect(extractedText).toContain('user：林澈负责')
    expect(applied).toBe(1)
    expect(jobs[0]?.status).toBe('completed')
  })

  it('lists failed jobs, requeues the exact world-scoped job, and completes it on retry', async () => {
    const jobs: KnowledgeConsolidationJob[] = [{
      id: 'job-retry', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
      fromCursor: 0, toCursor: 1, status: 'failed', attempt: 1, errorCode: 'knowledge_model_timeout',
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:01.000Z',
    }]
    const base = graphRepository()
    const repository = {
      ...base,
      listConsolidationJobs: ({ worldId, status }: { worldId?: string; status?: KnowledgeConsolidationJob['status']; limit: number }) => jobs.filter((job) => (worldId === undefined || job.worldId === worldId) && (status === undefined || job.status === status)),
      getConsolidationJob: (worldId: string, jobId: string) => jobs.find((job) => job.worldId === worldId && job.id === jobId),
      requeueConsolidationJob: (worldId: string, jobId: string) => { const job = jobs.find((item) => item.worldId === worldId && item.id === jobId)!; job.status = 'queued'; delete job.errorCode; return job },
      createConsolidationJob: () => jobs[0]!,
      claimConsolidationJob: (jobId: string) => { const job = jobs.find((item) => item.id === jobId); if (job?.status !== 'queued') return undefined; job.status = 'running'; job.attempt += 1; return job },
      applyKnowledgeExtraction: () => undefined,
      completeConsolidationJob: () => { jobs[0]!.status = 'completed'; return jobs[0]! },
      failConsolidationJob: (_input: { jobId: string; errorCode: string }) => { jobs[0]!.status = 'failed'; return jobs[0]! },
    } satisfies KnowledgeConsolidationRepository
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources: { async load() { return { workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 0, toCursor: 1, items: [{ kind: 'user', text: '需要重试的世界事实。', evidence: { evidenceId: 'retry-evidence', sourceType: 'conversation', sourceId: 'session-a', excerpt: '需要重试的世界事实。', worldId: 'world-a', workspaceId: 'workspace-a', sessionId: 'session-a', messageId: 'message-retry', sequence: 1 } }] } } },
      extractor: { async extract() { return { entities: [], claims: [], relations: [], evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'retry-evidence' }] } } },
    })
    expect(await service.listJobs('world-a', 'failed', 50)).toEqual([expect.objectContaining({ id: 'job-retry', errorCode: 'knowledge_model_timeout' })])
    await expect(service.getJob('world-b', 'job-retry')).resolves.toBeUndefined()
    await expect(service.retryJob('world-a', 'job-retry')).resolves.toMatchObject({ status: 'queued' })
    await expect(service.runNext()).resolves.toMatchObject({ status: 'completed', attempt: 2 })
  })
})
