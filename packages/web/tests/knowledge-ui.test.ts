import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'

import { KnowledgeDock } from '../src/features/knowledge/KnowledgeDock.js'
import {
  knowledgeSearchPath,
  normalizeKnowledgeSearchResults,
  type KnowledgeCollection,
  type KnowledgeDocument,
} from '../src/features/knowledge/useWorldKnowledge.js'

const world: World = {
  id: 'world-knowledge-test',
  workspaceId: 'workspace-knowledge-test',
  name: '资料测试世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
}

const collection: KnowledgeCollection = {
  id: 'collection-1',
  worldId: world.id,
  name: '产品资料',
  origin: 'folder',
  relativeRoot: 'docs/product',
  documentCount: 1,
  indexedDocumentCount: 1,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:06:00.000Z',
}

const knowledgeDocument: KnowledgeDocument = {
  id: 'document-1',
  workspaceId: world.workspaceId,
  worldId: world.id,
  collectionId: collection.id,
  relativePath: 'docs/product/brief.md',
  title: '产品说明',
  mimeType: 'text/markdown',
  byteLength: 2048,
  sha256: 'sha256',
  origin: 'filesystem',
  status: 'indexed',
  chunkCount: 3,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:06:00.000Z',
  indexedAt: '2026-08-25T00:06:00.000Z',
}

describe('Knowledge Library UI', () => {
  it('renders the graph empty state and real library evidence without demo filler', () => {
    const html = renderToStaticMarkup(createElement(KnowledgeDock, {
      world,
      demoMode: true,
      initialCollections: [collection],
      initialDocuments: [knowledgeDocument],
    }))
    expect(html).toContain('知识图谱')
    expect(html).toContain('知识库')
    expect(html).toContain('产品说明')
    expect(html).toContain('来源 docs/product/brief.md')
    expect(html).toContain('索引')
    expect(html).toContain('更新')
    expect(html).toContain('演示世界未连接本地知识库')
    expect(html).not.toContain('WORLD KNOWLEDGE')
    expect(html).not.toContain('示例图谱')
  })

  it('exposes separate ZIP and folder import choices from the keyboard-accessible import menu', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ collections: [], documents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('EventSource', class TestEventSource extends EventTarget {
      readonly url: string
      constructor(url: string) { super(); this.url = url }
      close(): void {}
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(KnowledgeDock, { world, demoMode: false }))
    })
    const importButton = host.querySelector<HTMLButtonElement>('[aria-controls="knowledge-import-menu"]')
    expect(importButton).not.toBeNull()
    await act(async () => { importButton?.click() })
    expect(host.textContent).toContain('导入 ZIP 知识包')
    expect(host.textContent).toContain('导入文件夹')
    expect(host.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })
})

describe('Knowledge search contract', () => {
  it('normalizes the backend world/document/chunk/content contract and isolates worlds', () => {
    const results = normalizeKnowledgeSearchResults([{
      worldId: world.id,
      documentId: 'document-1',
      chunkId: 'chunk-2',
      title: 'SQLite 使用说明',
      relativePath: 'docs/sqlite.md',
      ordinal: 2,
      content: 'WAL 模式可以让读写并行。',
      score: 0.91,
    }, {
      worldId: 'another-world',
      documentId: 'other-document',
      chunkId: 'other-chunk',
      title: '不应出现',
      relativePath: 'other.md',
      ordinal: 0,
      content: '另一个世界',
      score: 0.8,
    }], world.id)
    expect(results).toEqual([expect.objectContaining({
      id: 'chunk-2',
      worldId: world.id,
      documentId: 'document-1',
      chunkId: 'chunk-2',
      ordinal: 2,
      snippet: 'WAL 模式可以让读写并行。',
      score: 0.91,
    })])
  })

  it('builds a world-scoped search route with an encoded query and limit', () => {
    expect(knowledgeSearchPath(world.id, 'SQLite WAL', 6)).toBe('/api/worlds/world-knowledge-test/knowledge/search?q=SQLite+WAL&limit=6')
  })
})
