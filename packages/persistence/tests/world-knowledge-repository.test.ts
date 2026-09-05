import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore, WorldKnowledgeRepository } from '../src/index.js'

const stores: SqliteStore[] = []
const digest = (value: string): string => (value === 'b' ? 'b' : 'a').repeat(64)

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function database(): Promise<SqliteStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-knowledge-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  return store
}

describe('WorldKnowledgeRepository', () => {
  it('keeps collections, documents, and replaceable chunks world-scoped', async () => {
    const store = await database()
    const workspaceA = store.createWorkspace({ name: '知识 A' })
    const workspaceB = store.createWorkspace({ name: '知识 B' })
    const worldA = store.createWorld({ workspaceId: workspaceA.id, name: '世界 A', templateId: 'cyber-company' })
    const worldB = store.createWorld({ workspaceId: workspaceB.id, name: '世界 B', templateId: 'cyber-company' })
    const repository = new WorldKnowledgeRepository(store.database)
    const collection = repository.createCollection({
      worldId: worldA.id,
      name: '算法资料',
      origin: 'folder',
      relativeRoot: 'algorithms',
    })
    const document = repository.createDocument({
      workspaceId: workspaceA.id,
      worldId: worldA.id,
      collectionId: collection.id,
      relativePath: 'algorithms/graph.md',
      title: '图算法',
      mimeType: 'text/markdown',
      byteLength: 40,
      sha256: digest('a'),
      origin: 'upload',
    })
    expect(collection.documentCount).toBe(0)
    expect(repository.getCollection(worldA.id, collection.id)?.documentCount).toBe(1)

    const first = repository.replaceChunks(worldA.id, document.id, [{
      ordinal: 0,
      content: 'Dijkstra 适合非负权图。',
      contentHash: digest('a'),
      startOffset: 0,
      endOffset: 22,
    }])
    expect(first).toHaveLength(1)
    expect(repository.getDocument(worldA.id, document.id)).toMatchObject({ status: 'indexed', chunkCount: 1 })
    expect(repository.search({ worldId: worldA.id, query: 'Dijkstra', limit: 10 })).toEqual([
      expect.objectContaining({ documentId: document.id, content: 'Dijkstra 适合非负权图。' }),
    ])
    expect(['fts5-trigram', 'fts5', 'like']).toContain(repository.searchCapability)
    expect(repository.searchIndexed({ worldId: worldA.id, query: 'Dijkstra', limit: 10 })).toEqual([
      expect.objectContaining({ worldId: worldA.id, documentId: document.id }),
    ])
    expect(repository.search({ worldId: worldB.id, query: 'Dijkstra', limit: 10 })).toEqual([])
    expect(repository.searchIndexed({ worldId: worldB.id, query: 'Dijkstra', limit: 10 })).toEqual([])

    const second = repository.replaceChunks(worldA.id, document.id, [{
      ordinal: 0,
      content: 'Bellman-Ford 可以处理负权边。',
      contentHash: digest('b'),
    }])
    expect(second).toHaveLength(1)
    expect(repository.listChunks(worldA.id, document.id)).toEqual([
      expect.objectContaining({ content: 'Bellman-Ford 可以处理负权边。' }),
    ])
    expect(repository.search(worldA.id, 'Dijkstra', 10)).toEqual([])
    expect(repository.search(worldA.id, 'Bellman-Ford', 10)).toEqual([
      expect.objectContaining({ documentId: document.id }),
    ])
    expect(store.doctor().counts).toMatchObject({
      knowledgeCollections: 1,
      knowledgeDocuments: 1,
      knowledgeChunks: 1,
      knowledgeDocumentsMissing: 0,
    })
  })

  it('marks missing sources without preventing startup and invalidates changed metadata', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '知识工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '资料世界', templateId: 'personal-world' })
    const repository = new WorldKnowledgeRepository(store.database)
    const document = repository.createDocument({
      workspaceId: workspace.id,
      worldId: world.id,
      relativePath: 'notes/source.txt',
      title: '源资料',
      mimeType: 'text/plain',
      byteLength: 4,
      sha256: digest('a'),
      origin: 'filesystem',
    })
    repository.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '原始内容', contentHash: digest('a') }])
    expect(repository.markMissing(world.id, document.id).status).toBe('missing')
    expect(store.doctor()).toMatchObject({ ok: true, counts: { knowledgeDocumentsMissing: 1 } })

    const updated = repository.saveDocument({
      id: document.id,
      workspaceId: workspace.id,
      worldId: world.id,
      relativePath: 'notes/source.txt',
      title: '已更新资料',
      mimeType: 'text/plain',
      byteLength: 5,
      sha256: digest('b'),
      origin: 'filesystem',
    })
    expect(updated).toMatchObject({ title: '已更新资料', status: 'pending', chunkCount: 0 })
    expect(repository.listChunks(world.id, document.id)).toEqual([])
    expect(store.doctor()).toMatchObject({ ok: true, counts: { knowledgeDocumentsMissing: 0, knowledgeChunks: 0 } })
  })

  it('reads a bounded chunk window in ordinal order and keeps it world-scoped', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '窗口工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '窗口世界', templateId: 'personal-world' })
    const other = store.createWorld({ workspaceId: workspace.id, name: '旁观世界', templateId: 'personal-world' })
    const repository = new WorldKnowledgeRepository(store.database)
    const document = repository.createDocument({
      workspaceId: workspace.id,
      worldId: world.id,
      relativePath: 'notes/long.md',
      title: '长资料',
      mimeType: 'text/markdown',
      byteLength: 120,
      sha256: digest('a'),
      origin: 'paste',
    })
    repository.replaceChunks(world.id, document.id, Array.from({ length: 5 }, (_, ordinal) => ({
      ordinal,
      content: `第 ${ordinal + 1} 段`,
      contentHash: digest('a'),
    })))

    expect(repository.listChunkWindow(world.id, document.id, { offset: 1, limit: 2 })).toEqual({
      total: 5,
      items: [expect.objectContaining({ ordinal: 1, content: '第 2 段' }), expect.objectContaining({ ordinal: 2, content: '第 3 段' })],
    })
    expect(repository.listChunkWindow(world.id, document.id, { offset: 4, limit: 8 }).items).toHaveLength(1)
    // Past the end still reports the real total so a caller can say 共 5.
    expect(repository.listChunkWindow(world.id, document.id, { offset: 9 })).toEqual({ total: 5, items: [] })
    expect(repository.listChunkWindow(other.id, document.id)).toEqual({ total: 0, items: [] })
    expect(() => repository.listChunkWindow(world.id, document.id, { offset: -1 })).toThrow(/non-negative integer/)
  })
})
