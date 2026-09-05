import { describe, expect, it } from 'vitest'

import {
  CYBER_SCHEMA_VERSION,
  type KnowledgeChunk,
  type KnowledgeCollection,
  type KnowledgeClaim,
  type KnowledgeConsolidationJob,
  type KnowledgeDocument,
  type KnowledgeSourceVersion,
} from '../src/index.js'

describe('World knowledge contracts', () => {
  it('exports the world-scoped collection, document, and rebuildable chunk shapes', () => {
    const collection: KnowledgeCollection = {
      id: 'collection-1',
      worldId: 'world-1',
      name: '手册',
      origin: 'folder',
      relativeRoot: 'manuals',
      documentCount: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    }
    const document: KnowledgeDocument = {
      id: 'document-1',
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      collectionId: collection.id,
      relativePath: 'manuals/guide.md',
      title: '指南',
      mimeType: 'text/markdown',
      byteLength: 10,
      sha256: 'a'.repeat(64),
      origin: 'filesystem',
      status: 'pending',
      chunkCount: 0,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
    }
    const chunk: KnowledgeChunk = {
      id: 'chunk-1',
      worldId: document.worldId,
      documentId: document.id,
      ordinal: 0,
      content: '检索内容',
      contentHash: 'b'.repeat(64),
      createdAt: collection.createdAt,
    }
    expect({ collection, document, chunk }).toMatchObject({
      collection: { worldId: 'world-1', documentCount: 1 },
      document: { workspaceId: 'workspace-1', chunkCount: 0 },
      chunk: { worldId: 'world-1', documentId: 'document-1' },
    })
    expect(CYBER_SCHEMA_VERSION).toBe(43)
  })

  it('exports a source version whose completion watermark counts chunks, not sources', () => {
    const version: KnowledgeSourceVersion = {
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      sourceType: 'document',
      sourceId: 'document-1',
      contentHash: 'c'.repeat(64),
      chunkTotal: 37,
      processedChunks: 12,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:01:00.000Z',
    }
    const superseded: KnowledgeSourceVersion = {
      ...version,
      contentHash: 'd'.repeat(64),
      processedChunks: 37,
      completedAt: '2026-09-05T00:02:00.000Z',
      supersededAt: '2026-09-05T00:03:00.000Z',
      supersededByHash: version.contentHash,
    }
    expect(version.processedChunks).toBeLessThan(version.chunkTotal)
    expect(version.completedAt).toBeUndefined()
    expect(superseded.completedAt).toBeDefined()

    // The job carries the watermark of its source version so a reader never has
    // to guess that "completed job" means "whole source processed".
    const job: KnowledgeConsolidationJob = {
      id: 'job-1', workspaceId: version.workspaceId, worldId: version.worldId,
      sourceType: 'document', sourceId: version.sourceId, fromCursor: 12, toCursor: 1_757_000_000_000,
      status: 'completed', attempt: 1, processedChunks: 24, chunkTotal: 37,
      createdAt: version.createdAt, updatedAt: version.updatedAt,
    }
    expect(job).toMatchObject({ processedChunks: 24, chunkTotal: 37 })
  })

  it('marks a claim as not current without changing its status or removing it', () => {
    const supported: KnowledgeClaim = {
      id: 'claim-1', workspaceId: 'workspace-1', worldId: 'world-1', type: 'fact',
      subjectEntityId: 'entity-1', predicate: '价格', objectText: '99 元', confidence: 0.9,
      status: 'active', source: 'auto', evidenceIds: ['evidence-1'],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    }
    const notCurrent: KnowledgeClaim = {
      ...supported,
      notCurrent: {
        since: '2026-09-05T01:00:00.000Z',
        sourceType: 'document',
        sourceId: 'document-1',
        contentHash: 'c'.repeat(64),
      },
    }
    // The downgrade is a separate fact, not a fifth status: the claim keeps its
    // own status, its evidence and its identity, and only retrieval changes.
    expect(supported.notCurrent).toBeUndefined()
    expect(notCurrent).toMatchObject({ status: 'active', evidenceIds: ['evidence-1'] })
    expect(notCurrent.notCurrent?.sourceId).toBe('document-1')

    // The job projection is what lets one library row say it out loud.
    const job: KnowledgeConsolidationJob = {
      id: 'job-2', workspaceId: 'workspace-1', worldId: 'world-1', sourceType: 'document',
      sourceId: 'document-1', fromCursor: 0, toCursor: 1_757_000_000_000, status: 'completed',
      attempt: 1, processedChunks: 4, chunkTotal: 4, notCurrentClaims: 2,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T01:00:00.000Z',
    }
    expect(job).toMatchObject({ status: 'completed', notCurrentClaims: 2 })
  })
})
