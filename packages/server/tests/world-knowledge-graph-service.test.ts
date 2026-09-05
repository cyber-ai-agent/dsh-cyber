import { describe, expect, it } from 'vitest'

import {
  WorldKnowledgeGraphRetrievalService,
  WorldKnowledgeGraphService,
  knowledgeRetrievalQueries,
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

  it('preserves repository-ranked semantic matches instead of applying a second substring filter', async () => {
    const repository = graphRepository()
    repository.searchEntities = ({ worldId, query }) => worldId === 'world-a' && query === '值班安排' ? [entityA] : []
    repository.searchClaims = () => []
    const result = await new WorldKnowledgeGraphService({ repository }).search({ worldId: 'world-a', query: '值班安排' })
    expect(result.entities).toEqual([entityA])
  })

  it('never composes a not-current claim into the prompt context', async () => {
    const notCurrent: KnowledgeGraphClaim = {
      id: 'claim-not-current', workspaceId: 'workspace-a', worldId: 'world-a', type: 'fact',
      subjectEntityId: entityA.id, predicate: '负责', objectText: '已经撤销的观测计划', confidence: 0.95,
      status: 'active', source: 'auto', evidenceIds: ['evidence-a'],
      notCurrent: { since: '2026-09-05T00:00:00.000Z', sourceType: 'document', sourceId: 'document-a', contentHash: 'a'.repeat(64) },
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    }
    const repository = graphRepository()
    repository.searchClaims = ({ worldId, limit }) => worldId === 'world-a' ? [notCurrent, claim].slice(0, limit) : []
    const retrieval = new WorldKnowledgeGraphRetrievalService({ graph: new WorldKnowledgeGraphService({ repository }) })
    const context = await retrieval.retrieve({ worldId: 'world-a', query: '负责', limit: 4 })
    expect(context?.text).not.toContain('已经撤销的观测计划')
    expect(context?.hits.map((hit) => hit.id)).not.toContain(notCurrent.id)
    // The still-supported fact on the same subject keeps standing.
    expect(context?.hits.map((hit) => hit.id)).toContain(claim.id)
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

  it('accepts only current-batch evidence and ignores unknown fields', () => {
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
    // Provider tolerance: an invented field no longer discards a valid batch.
    const tolerant = parseKnowledgeExtraction({
      entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'], injected: 'ignore' }],
      claims: [], relations: [], evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
    }, { sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput })
    expect(tolerant.entities[0]?.canonicalName).toBe('林澈')
  })

  it('accepts a single fenced JSON document and a UTF-8 BOM from model output', () => {
    const payload = {
      entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'] }],
      claims: [], relations: [],
      evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
    }
    const result = parseKnowledgeExtraction(`\uFEFF\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``, {
      sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput,
    })
    expect(result.entities[0]?.canonicalName).toBe('林澈')
  })

  it('reads the JSON object out of an answer wrapped in sentences', () => {
    const payload = {
      entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'] }],
      claims: [], relations: [],
      evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
    }
    const result = parseKnowledgeExtraction('好的，以下是抽取结果：\n```json\n' + JSON.stringify(payload) + '\n```\n希望对你有帮助。', {
      sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput,
    })
    expect(result.entities[0]?.canonicalName).toBe('林澈')
  })

  it('salvages whole members from an answer truncated mid-stream by the gateway', () => {
    // max_tokens capped the completion: evidenceRefs and entities closed, the
    // second claim died mid-key. Salvaging what completed beats losing it all.
    const truncated = '{"evidenceRefs":[{"sourceType":"conversation","sourceId":"session-a","evidenceId":"evidence-a"}],"entities":[{"key":"lin","type":"character","canonicalName":"林澈","aliases":[],"evidenceRefs":["evidence-a"]}],"claims":[{"key":"c1","type":"fact","subjectKey":"lin","predicate":"负责","objectText":"观测站","confidence":0.9,"evidenceRefs":["evidence-a"]},{"key":"c2","type":"fact","subject'
    const result = parseKnowledgeExtraction(truncated, { sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput })
    expect(result.entities.map((entity) => entity.canonicalName)).toEqual(['林澈'])
    expect(result.claims.map((claim) => claim.key)).toEqual(['c1'])
  })

  it('fails cleanly when truncation dropped the required evidence root', () => {
    const truncated = '{"entities":[{"key":"lin","type":"character","canonicalName":"林澈","aliases":[],"evidenceRefs":["evidence-a"]},{"key":"pa'
    expect(() => parseKnowledgeExtraction(truncated, { sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput })).toThrowError(KnowledgeExtractionError)
  })

  it('degrades an unknown entity type to other and drops only the claim with an unknown type', () => {
    const parsed = parseKnowledgeExtraction({
      entities: [{ key: 'lin', type: '神秘生物', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'] }],
      claims: [
        { key: 'good', type: 'fact', subjectKey: 'lin', predicate: '负责', objectText: '观测站', confidence: 0.9, evidenceRefs: ['evidence-a'] },
        { key: 'bad', type: '预言', subjectKey: 'lin', predicate: '预测', objectText: '未来', confidence: 0.5, evidenceRefs: ['evidence-a'] },
      ],
      relations: [],
      evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
    }, { sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput })
    expect(parsed.entities[0]?.type).toBe('other')
    expect(parsed.claims.map((claim) => claim.key)).toEqual(['good'])
  })

  it('rejects a root that declares no evidence instead of a false empty success', () => {
    expect(() => parseKnowledgeExtraction({}, { sourceType: 'conversation', sourceId: 'session-a', evidence: evidenceInput }))
      .toThrowError(KnowledgeExtractionError)
  })

  it('fails the batch for a malformed relation but still drops only a dangling edge', () => {
    const context = { sourceType: 'conversation' as const, sourceId: 'session-a', evidence: evidenceInput }
    const base = {
      entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'] }],
      claims: [],
      evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
    }
    expect(() => parseKnowledgeExtraction({ ...base, relations: [{ key: 'r1', fromKey: 'lin', toKey: 'lin', predicate: '关联', confidence: '很高', evidenceRefs: ['evidence-a'] }] }, context))
      .toThrowError(KnowledgeExtractionError)
    const dangling = parseKnowledgeExtraction({ ...base, relations: [{ key: 'r1', fromKey: 'lin', toKey: 'ghost', predicate: '关联', confidence: 0.5, evidenceRefs: ['evidence-a'] }] }, context)
    expect(dangling.relations).toEqual([])
  })

  it('demotes a dangling objectKey to text and prefers the entity pointer over prose', () => {
    const claimContext = { sourceType: 'conversation' as const, sourceId: 'session-a', evidence: evidenceInput }
    const shape = (extra: Record<string, unknown>) => ({
      entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'] }],
      claims: [{ key: 'claim', type: 'fact', subjectKey: 'lin', predicate: '负责', confidence: 0.8, evidenceRefs: ['evidence-a'], ...extra }],
      relations: [],
      evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }],
    })
    const dangling = parseKnowledgeExtraction(shape({ objectKey: '不存在的实体' }), claimContext)
    expect(dangling.claims[0]?.objectKey).toBeUndefined()
    expect(dangling.claims[0]?.objectText).toBe('不存在的实体')
    const both = parseKnowledgeExtraction(shape({ objectKey: 'lin', objectText: '多余文字' }), claimContext)
    expect(both.claims[0]?.objectKey).toBe('lin')
    expect(both.claims[0]?.objectText).toBeUndefined()
  })
})

describe('knowledge consolidation lifecycle', () => {
  it('uses the background boundary and never sends hidden/tool content to extraction', async () => {
    expect(shouldConsolidate({ visibleMessages: 6, characters: 1, idleMs: 60_000, mode: 'balanced' })).toBe(true)
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

  it('retries an unparseable answer once with the corrective hint', async () => {
    const jobs: KnowledgeConsolidationJob[] = [{
      id: 'job-reparse', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
      fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0,
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }]
    const base = graphRepository()
    const repository = {
      ...base,
      listConsolidationJobs: () => jobs.filter((job) => job.status === 'queued'),
      claimConsolidationJob: (jobId: string) => { const job = jobs.find((item) => item.id === jobId); if (job === undefined || job.status !== 'queued') return undefined; job.status = 'running'; job.attempt += 1; return job },
      applyKnowledgeExtraction: () => undefined,
      completeConsolidationJob: () => { jobs[0]!.status = 'completed'; return jobs[0]! },
      failConsolidationJob: () => { jobs[0]!.status = 'failed'; return jobs[0]! },
    } satisfies KnowledgeConsolidationRepository
    const hints: Array<boolean | undefined> = []
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources: { async load() { return { workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 0, toCursor: 1, items: [{ kind: 'user', text: '林澈负责远星观测站。', evidence: { evidenceId: 'evidence-a', sourceType: 'conversation', sourceId: 'session-a', excerpt: '林澈负责远星观测站。', worldId: 'world-a', workspaceId: 'workspace-a', sessionId: 'session-a', messageId: 'message-a', sequence: 1 } }] } } },
      extractor: {
        async extract(request) {
          hints.push(request.attemptHint)
          if (hints.length === 1) return { payload: '抱歉，我现在无法输出结构化结果。' }
          return { entities: [{ key: 'lin', type: 'character', canonicalName: '林澈', aliases: [], evidenceRefs: ['evidence-a'] }], claims: [], relations: [], evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }] }
        },
      },
    })
    await service.runNext()
    expect(hints).toEqual([undefined, true])
    expect(jobs[0]?.status).toBe('completed')
  })

  it('retries once when the gateway answers HTTP-OK with empty content', async () => {
    const jobs: KnowledgeConsolidationJob[] = [{
      id: 'job-empty', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
      fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0,
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }]
    const base = graphRepository()
    const repository = {
      ...base,
      listConsolidationJobs: () => jobs.filter((job) => job.status === 'queued'),
      claimConsolidationJob: (jobId: string) => { const job = jobs.find((item) => item.id === jobId); if (job === undefined || job.status !== 'queued') return undefined; job.status = 'running'; job.attempt += 1; return job },
      applyKnowledgeExtraction: () => undefined,
      completeConsolidationJob: () => { jobs[0]!.status = 'completed'; return jobs[0]! },
      failConsolidationJob: () => { jobs[0]!.status = 'failed'; return jobs[0]! },
    } satisfies KnowledgeConsolidationRepository
    let calls = 0
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources: { async load() { return { workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 0, toCursor: 1, items: [{ kind: 'user', text: '事实。', evidence: { evidenceId: 'evidence-a', sourceType: 'conversation', sourceId: 'session-a', excerpt: '事实。', worldId: 'world-a', workspaceId: 'workspace-a', sessionId: 'session-a', messageId: 'message-a', sequence: 1 } }] } } },
      extractor: {
        async extract() {
          calls += 1
          if (calls === 1) throw Object.assign(new Error('知识整理模型没有返回 JSON 内容。'), { code: 'knowledge_model_response_invalid' })
          return { payload: JSON.stringify({ entities: [], claims: [], relations: [], evidenceRefs: [{ sourceType: 'conversation', sourceId: 'session-a', evidenceId: 'evidence-a' }] }) }
        },
      },
    })
    await service.runNext()
    expect(calls).toBe(2)
    expect(jobs[0]?.status).toBe('completed')
  })

  it('advances the cursor only to the items actually sent, keeping the tail for the next job', async () => {
    // 25 messages of ~900 chars each: the 16k budget can only carry part of
    // them. The old code still completed at the batch's last sequence, which
    // silently skipped every message past the character cut — forever.
    const perItem = '話。'.repeat(450) // 900 chars
    const jobs: KnowledgeConsolidationJob[] = [{
      id: 'job-tail', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
      fromCursor: 0, toCursor: 25, status: 'queued', attempt: 0,
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }]
    let completedCursor: number | undefined
    const base = graphRepository()
    const repository = {
      ...base,
      listConsolidationJobs: () => jobs.filter((job) => job.status === 'queued'),
      claimConsolidationJob: (jobId: string) => { const job = jobs.find((item) => item.id === jobId); if (job === undefined || job.status !== 'queued') return undefined; job.status = 'running'; job.attempt += 1; return job },
      applyKnowledgeExtraction: () => undefined,
      completeConsolidationJob: (input: { jobId: string; toCursor?: number }) => { completedCursor = input.toCursor; jobs[0]!.status = 'completed'; return jobs[0]! },
      failConsolidationJob: () => { jobs[0]!.status = 'failed'; return jobs[0]! },
    } satisfies KnowledgeConsolidationRepository
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources: { async load() {
        return {
          workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 0, toCursor: 25,
          items: Array.from({ length: 25 }, (_, index) => ({
            kind: 'user' as const, text: perItem,
            evidence: { evidenceId: `evidence-${index + 1}`, sourceType: 'conversation' as const, sourceId: 'session-a', excerpt: perItem.slice(0, 100), worldId: 'world-a', workspaceId: 'workspace-a', sessionId: 'session-a', messageId: `message-${index + 1}`, sequence: index + 1 },
          })),
        }
      } },
      extractor: {
        async extract(request) {
          return { entities: [], claims: [], relations: [], evidenceRefs: request.evidence.map((item) => ({ sourceType: 'conversation' as const, sourceId: 'session-a', evidenceId: item.evidenceId })) }
        },
      },
    })
    await service.runNext()
    expect(jobs[0]?.status).toBe('completed')
    expect(completedCursor).toBeLessThan(25)
    expect(completedCursor! * 900).toBeLessThanOrEqual(16_000 + 900)
  })

  it('runs one pass across distinct worlds in parallel but keeps a world serial', async () => {
    const jobs: KnowledgeConsolidationJob[] = [
      { id: 'job-w1a', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' },
      { id: 'job-w2', workspaceId: 'workspace-a', worldId: 'world-b', sourceType: 'conversation', sourceId: 'session-b', fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' },
      { id: 'job-w1b', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a2', fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' },
    ]
    const base = graphRepository()
    const repository = {
      ...base,
      listConsolidationJobs: () => jobs.filter((job) => job.status === 'queued'),
      claimConsolidationJob: (jobId: string) => { const job = jobs.find((item) => item.id === jobId); if (job === undefined || job.status !== 'queued') return undefined; job.status = 'running'; return job },
      applyKnowledgeExtraction: () => undefined,
      completeConsolidationJob: ({ jobId }: { jobId: string }) => { const job = jobs.find((item) => item.id === jobId)!; job.status = 'completed'; return job },
      failConsolidationJob: ({ jobId }: { jobId: string }) => { const job = jobs.find((item) => item.id === jobId)!; job.status = 'failed'; return job },
    } satisfies KnowledgeConsolidationRepository
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources: { async load(input) {
        const worldId = input.worldId
        const sessionId = input.sourceId
        return { workspaceId: 'workspace-a', worldId, sourceType: 'conversation', sourceId: sessionId, fromCursor: 0, toCursor: 1, items: [{ kind: 'user', text: '事实。', evidence: { evidenceId: 'evidence-x', sourceType: 'conversation', sourceId: sessionId, excerpt: '事实。', worldId, workspaceId: 'workspace-a', sessionId, messageId: 'message-x', sequence: 1 } }] }
      } },
      extractor: {
        async extract(request) {
          return { entities: [], claims: [], relations: [], evidenceRefs: request.evidence.map((item) => ({ sourceType: 'conversation' as const, sourceId: request.sourceId, evidenceId: 'evidence-x' })) }
        },
      },
    })
    await service.runNext()
    // world-a and world-b advanced together; the second world-a job waits for
    // the next pass so one world never runs two model calls at once.
    expect(jobs[0]?.status).toBe('completed')
    expect(jobs[1]?.status).toBe('completed')
    expect(jobs[2]?.status).toBe('queued')
    await service.runNext()
    expect(jobs[2]?.status).toBe('completed')
  })

  it('never retries a transport failure into a second model call', async () => {
    const jobs: KnowledgeConsolidationJob[] = [{
      id: 'job-transport', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
      fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0,
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }]
    const base = graphRepository()
    const repository = {
      ...base,
      listConsolidationJobs: () => jobs.filter((job) => job.status === 'queued'),
      claimConsolidationJob: (jobId: string) => { const job = jobs.find((item) => item.id === jobId); if (job === undefined || job.status !== 'queued') return undefined; job.status = 'running'; job.attempt += 1; return job },
      completeConsolidationJob: () => { jobs[0]!.status = 'completed'; return jobs[0]! },
      failConsolidationJob: () => { jobs[0]!.status = 'failed'; return jobs[0]! },
    } satisfies KnowledgeConsolidationRepository
    let calls = 0
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources: { async load() { return { workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 0, toCursor: 1, items: [{ kind: 'user', text: '事实。', evidence: { evidenceId: 'evidence-a', sourceType: 'conversation', sourceId: 'session-a', excerpt: '事实。', worldId: 'world-a', workspaceId: 'workspace-a', sessionId: 'session-a', messageId: 'message-a', sequence: 1 } }] } } },
      extractor: {
        async extract() {
          calls += 1
          throw Object.assign(new Error('知识整理模型响应超时，请稍后重试。'), { code: 'knowledge_model_timeout' })
        },
      },
    })
    await service.runNext()
    expect(calls).toBe(1)
    expect(jobs[0]?.status).toBe('failed')
  })
})

describe('consolidation false-success guards', () => {
  it('fails the job when the model answers a root with no evidence, rather than completing empty', async () => {
    const jobs: KnowledgeConsolidationJob[] = [{
      id: 'job-empty-root', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
      fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0,
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }]
    const base = graphRepository()
    const repository = {
      ...base,
      listConsolidationJobs: () => jobs.filter((job) => job.status === 'queued'),
      claimConsolidationJob: (jobId: string) => { const job = jobs.find((item) => item.id === jobId); if (job === undefined || job.status !== 'queued') return undefined; job.status = 'running'; job.attempt += 1; return job },
      applyKnowledgeExtraction: () => undefined,
      completeConsolidationJob: () => { jobs[0]!.status = 'completed'; return jobs[0]! },
      failConsolidationJob: (input: { jobId: string; errorCode: string }) => { const job = jobs.find((item) => item.id === input.jobId)!; job.status = 'failed'; job.errorCode = input.errorCode; return job },
    } satisfies KnowledgeConsolidationRepository
    let calls = 0
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources: { async load() { return { workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 0, toCursor: 1, items: [{ kind: 'user', text: '事实。', evidence: { evidenceId: 'evidence-a', sourceType: 'conversation', sourceId: 'session-a', excerpt: '事实。', worldId: 'world-a', workspaceId: 'workspace-a', sessionId: 'session-a', messageId: 'message-a', sequence: 1 } }] } } },
      extractor: { async extract() { calls += 1; return { payload: '{}' } } },
    })
    await service.runNext()
    expect(calls).toBe(2) // one corrective retry, still unusable
    expect(jobs[0]?.status).toBe('failed')
    expect(jobs[0]?.errorCode).toBe('extraction_field_required')
  })

  it('clips an oversized first item into the declared request budget', async () => {
    const jobs: KnowledgeConsolidationJob[] = [{
      id: 'job-oversize', workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a',
      fromCursor: 0, toCursor: 1, status: 'queued', attempt: 0,
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }]
    const base = graphRepository()
    let completedCursor: number | undefined
    const repository = {
      ...base,
      listConsolidationJobs: () => jobs.filter((job) => job.status === 'queued'),
      claimConsolidationJob: (jobId: string) => { const job = jobs.find((item) => item.id === jobId); if (job === undefined || job.status !== 'queued') return undefined; job.status = 'running'; return job },
      applyKnowledgeExtraction: () => undefined,
      completeConsolidationJob: (input: { jobId: string; toCursor?: number }) => { completedCursor = input.toCursor; jobs[0]!.status = 'completed'; return jobs[0]! },
      failConsolidationJob: () => { jobs[0]!.status = 'failed'; return jobs[0]! },
    } satisfies KnowledgeConsolidationRepository
    let sentText = ''
    const service = new WorldKnowledgeConsolidationService({
      repository,
      sources: { async load() { return { workspaceId: 'workspace-a', worldId: 'world-a', sourceType: 'conversation', sourceId: 'session-a', fromCursor: 0, toCursor: 1, items: [{ kind: 'user', text: '話'.repeat(16_000), evidence: { evidenceId: 'evidence-a', sourceType: 'conversation', sourceId: 'session-a', excerpt: '話', worldId: 'world-a', workspaceId: 'workspace-a', sessionId: 'session-a', messageId: 'message-a', sequence: 1 } }] } } },
      extractor: {
        async extract(request) {
          sentText = request.visibleText
          return { entities: [], claims: [], relations: [], evidenceRefs: [{ sourceType: 'conversation' as const, sourceId: 'session-a', evidenceId: 'evidence-a' }] }
        },
      },
    })
    await service.runNext()
    expect(Array.from(sentText).length).toBeLessThanOrEqual(16_000)
    expect(jobs[0]?.status).toBe('completed')
    expect(completedCursor).toBe(1)
  })
})

describe('knowledge retrieval queries', () => {
  it('keeps the phrase and adds ASCII words and CJK terms', () => {
    const terms = knowledgeRetrievalQueries('请分析 NVDA 与英伟达在2026年的供货合同，包括 TSMC 的产能')
    expect(terms[0]).toContain('请分析')
    expect(terms).toContain('NVDA')
    expect(terms).toContain('TSMC')
    expect(terms.some((term) => term.length >= 2 && '英伟达'.includes(term))).toBe(true)
    expect(terms.length).toBeLessThanOrEqual(9)
  })

  it('keeps a short query as a single phrase match', () => {
    expect(knowledgeRetrievalQueries('林澈')).toEqual(['林澈'])
    expect(knowledgeRetrievalQueries('')).toEqual([])
  })
})
