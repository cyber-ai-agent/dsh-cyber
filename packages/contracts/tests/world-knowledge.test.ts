import { describe, expect, it } from 'vitest'

import {
  CYBER_SCHEMA_VERSION,
  type KnowledgeChunk,
  type KnowledgeCollection,
  type KnowledgeDocument,
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
    expect(CYBER_SCHEMA_VERSION).toBe(41)
  })
})
