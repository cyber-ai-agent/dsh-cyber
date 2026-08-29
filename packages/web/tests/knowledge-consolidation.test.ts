import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'

import { ArtifactDetail } from '../src/features/artifacts/ArtifactDetail.js'
import type { ArtifactRecord } from '../src/features/artifacts/useWorldArtifacts.js'
import { KnowledgeLibrary } from '../src/features/knowledge/KnowledgeLibrary.js'
import type { KnowledgeCollection, KnowledgeDocument, UseWorldKnowledgeResult } from '../src/features/knowledge/useWorldKnowledge.js'
import { setUiLocale } from '../src/i18n/runtime.js'

beforeEach(() => setUiLocale('zh-CN'))

const world: World = {
  id: 'world-consolidation-test',
  workspaceId: 'workspace-consolidation-test',
  name: '知识整理测试世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
}

const collection: KnowledgeCollection = {
  id: 'collection-consolidation-1',
  worldId: world.id,
  name: '整理资料',
  origin: 'folder',
  relativeRoot: 'docs',
  documentCount: 1,
  indexedDocumentCount: 1,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:06:00.000Z',
}

const document: KnowledgeDocument = {
  id: 'document-consolidation-1',
  workspaceId: world.workspaceId,
  worldId: world.id,
  collectionId: collection.id,
  relativePath: 'docs/brief.md',
  title: '整理说明',
  mimeType: 'text/markdown',
  byteLength: 1024,
  sha256: 'sha256',
  origin: 'filesystem',
  status: 'indexed',
  chunkCount: 2,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:06:00.000Z',
  indexedAt: '2026-08-25T00:06:00.000Z',
}

const artifact: ArtifactRecord = {
  id: 'artifact-consolidation-1',
  workspaceId: world.workspaceId,
  worldId: world.id,
  title: '整理产物',
  description: '用于验证知识整理入口。',
  kind: 'markdown',
  status: 'active',
  currentVersion: 1,
  createdByKind: 'owner',
  createdById: 'owner-1',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:06:00.000Z',
  preview: { content: '# 整理产物\n\n有来源的内容。', mimeType: 'text/markdown' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Knowledge consolidation actions', () => {
  it('queues an indexed document and projects the durable job state', async () => {
    const reload = vi.fn(async () => undefined)
    const consolidate = vi.fn(async () => undefined)
    const state: UseWorldKnowledgeResult = {
      collections: [collection],
      documents: [document],
      consolidationJobs: [],
      loading: false,
      searching: false,
      searchQuery: '',
      searchResults: [],
      reload,
      search: vi.fn(async () => []),
      clearSearch: vi.fn(),
      importFile: vi.fn(async () => undefined),
      importPack: vi.fn(async () => undefined),
      createFromText: vi.fn(async () => undefined),
      importFromWeb: vi.fn(async () => undefined),
      rescan: vi.fn(async () => undefined),
      consolidate,
      retryConsolidation: vi.fn(async () => undefined),
    }
    const host = documentForTest()
    const root = createRoot(host)
    await act(async () => { root.render(createElement(KnowledgeLibrary, { world, demoMode: false, state })) })
    const button = host.querySelector<HTMLButtonElement>('.knowledge-row__consolidation-button')
    expect(button?.textContent).toContain('吸收到知识图谱')
    await act(async () => { button?.click() })
    expect(consolidate).toHaveBeenCalledWith('document', document.id)
    expect(reload).not.toHaveBeenCalled()
    await act(async () => { root.render(createElement(KnowledgeLibrary, { world, demoMode: false, state: { ...state, consolidationJobs: [{ id: 'job-document-1', workspaceId: world.workspaceId, worldId: world.id, sourceType: 'document', sourceId: document.id, fromCursor: 0, toCursor: 0, status: 'queued', attempt: 0, createdAt: world.createdAt, updatedAt: world.updatedAt }] } })) })
    expect(host.textContent).toContain('已排队')
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('queues an artifact and reports the result inline', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('/api/worlds/world-consolidation-test/knowledge/consolidate')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ sourceType: 'artifact', sourceId: artifact.id })
      return new Response(JSON.stringify({ job: { id: 'job-artifact-1', status: 'queued' } }), { status: 202, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const host = documentForTest()
    const root = createRoot(host)
    await act(async () => { root.render(createElement(ArtifactDetail, { worldId: world.id, artifact, onBack: vi.fn(), onRename: vi.fn(async () => undefined), onArchive: vi.fn(async () => undefined) })) })
    const button = findButton(host, '加入知识')
    expect(button).not.toBeNull()
    expect(button?.textContent).not.toContain('即将开放')
    await act(async () => { button?.click() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('已排队，后台整理中')
    expect(host.textContent).toContain('已排队')
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('shows persisted knowledge failures and retries the exact job', async () => {
    const retryConsolidation = vi.fn(async () => undefined)
    const state: UseWorldKnowledgeResult = {
      collections: [],
      documents: [],
      consolidationJobs: [{ id: 'job-timeout', workspaceId: world.workspaceId, worldId: world.id, sourceType: 'conversation', sourceId: 'session-timeout', fromCursor: 0, toCursor: 12, status: 'failed', attempt: 1, errorCode: 'knowledge_model_timeout', createdAt: world.createdAt, updatedAt: world.updatedAt }],
      loading: false,
      searching: false,
      searchQuery: '',
      searchResults: [],
      reload: vi.fn(async () => undefined),
      search: vi.fn(async () => []),
      clearSearch: vi.fn(),
      importFile: vi.fn(async () => undefined),
      importPack: vi.fn(async () => undefined),
      createFromText: vi.fn(async () => undefined),
      importFromWeb: vi.fn(async () => undefined),
      rescan: vi.fn(async () => undefined),
      consolidate: vi.fn(async () => undefined),
      retryConsolidation,
    }
    const host = documentForTest()
    const root = createRoot(host)
    await act(async () => { root.render(createElement(KnowledgeLibrary, { world, demoMode: false, state })) })
    expect(host.textContent).toContain('知识整理任务')
    expect(host.textContent).toContain('模型整理超时')
    const retry = findButton(host, '重试')
    expect(retry).not.toBeNull()
    await act(async () => { retry?.click() })
    expect(retryConsolidation).toHaveBeenCalledWith('job-timeout')
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('only acknowledges a durable queued job and keeps failures in the artifact detail', async () => {
    const queuedFetch = vi.fn(async () => new Response(JSON.stringify({ job: { id: 'job-artifact-1', status: 'queued' } }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', queuedFetch)
    const queuedHost = documentForTest()
    const queuedRoot = createRoot(queuedHost)
    await act(async () => { queuedRoot.render(createElement(ArtifactDetail, { worldId: world.id, artifact, onBack: vi.fn(), onRename: vi.fn(async () => undefined), onArchive: vi.fn(async () => undefined) })) })
    await act(async () => { findButton(queuedHost, '加入知识')?.click() })
    expect(queuedHost.textContent).toContain('已排队，后台整理中')
    expect(queuedHost.textContent).not.toContain('已加入知识图谱')
    await act(async () => { queuedRoot.unmount() })
    queuedHost.remove()

    const untrackedFetch = vi.fn(async () => new Response(JSON.stringify({ result: { changed: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', untrackedFetch)
    const untrackedHost = documentForTest()
    const untrackedRoot = createRoot(untrackedHost)
    await act(async () => { untrackedRoot.render(createElement(ArtifactDetail, { worldId: world.id, artifact, onBack: vi.fn(), onRename: vi.fn(async () => undefined), onArchive: vi.fn(async () => undefined) })) })
    await act(async () => { findButton(untrackedHost, '加入知识')?.click() })
    expect(untrackedHost.textContent).toContain('未返回可追踪的任务记录')
    expect(untrackedHost.querySelector('[role="alert"]')).not.toBeNull()
    await act(async () => { untrackedRoot.unmount() })
    untrackedHost.remove()

    const failureFetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: '知识整理服务暂时不可用' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', failureFetch)
    const failureHost = documentForTest()
    const failureRoot = createRoot(failureHost)
    await act(async () => { failureRoot.render(createElement(ArtifactDetail, { worldId: world.id, artifact, onBack: vi.fn(), onRename: vi.fn(async () => undefined), onArchive: vi.fn(async () => undefined) })) })
    await act(async () => { findButton(failureHost, '加入知识')?.click() })
    expect(failureHost.textContent).toContain('知识整理服务暂时不可用')
    expect(failureHost.querySelector('[role="alert"]')).not.toBeNull()
    await act(async () => { failureRoot.unmount() })
    failureHost.remove()
  })

  it('keeps the artifact action visible but disabled in demo mode and without permission', () => {
    const demoHtml = renderToStaticMarkup(createElement(ArtifactDetail, { worldId: world.id, artifact, demoMode: true, onBack: vi.fn(), onRename: vi.fn(async () => undefined), onArchive: vi.fn(async () => undefined) }))
    expect(demoHtml).toContain('加入知识')
    expect(demoHtml).not.toContain('即将开放')
    expect(demoHtml).toContain('演示模式下暂不可加入知识图谱')
    const restrictedHtml = renderToStaticMarkup(createElement(ArtifactDetail, { worldId: world.id, artifact, canAddToKnowledge: false, onBack: vi.fn(), onRename: vi.fn(async () => undefined), onArchive: vi.fn(async () => undefined) }))
    expect(restrictedHtml).toContain('当前没有加入知识图谱的权限')
  })
})

function documentForTest(): HTMLDivElement {
  const host = globalThis.document.createElement('div')
  globalThis.document.body.append(host)
  return host
}

function findButton(host: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes(text)) ?? null
}
