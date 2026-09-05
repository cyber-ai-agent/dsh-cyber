import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'

import { KnowledgeDock } from '../src/features/knowledge/KnowledgeDock.js'
import { knowledgeDocumentPreviewPath, type KnowledgeDocument } from '../src/features/knowledge/useWorldKnowledge.js'

const world: World = {
  id: 'world-preview',
  workspaceId: 'workspace-preview',
  name: '正文预览世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const markdownDocument: KnowledgeDocument = {
  id: 'document-preview',
  workspaceId: world.workspaceId,
  worldId: world.id,
  relativePath: 'docs/handbook.md',
  title: '团队手册',
  mimeType: 'text/markdown',
  byteLength: 8_192,
  sha256: 'sha256',
  origin: 'upload',
  status: 'indexed',
  chunkCount: 6,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:04:00.000Z',
  indexedAt: '2026-09-01T00:04:00.000Z',
}

const officeDocument: KnowledgeDocument = {
  ...markdownDocument,
  id: 'document-office',
  relativePath: 'docs/季度报告.docx',
  title: '季度报告',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  status: 'pending',
  chunkCount: 0,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('knowledge document body preview', () => {
  it('renders a truthful paragraph window inside the expanded row', async () => {
    const preview = {
      documentId: markdownDocument.id,
      title: markdownDocument.title,
      mimeType: markdownDocument.mimeType,
      status: 'indexed',
      previewable: true,
      total: 6,
      offset: 0,
      nextOffset: 2,
      paragraphs: [
        { ordinal: 0, text: '第一段：值班规则与 <b>加粗</b> 记号。' },
        { ordinal: 1, text: '第二段：报销流程。' },
      ],
    }
    const { host, root, requests } = await mountLibrary([markdownDocument], preview)

    expect(requests.filter((url) => url.includes('/preview'))).toEqual([])
    await expandFirstDocument(host)

    expect(requests.some((url) => url.startsWith(knowledgeDocumentPreviewPath(world.id, markdownDocument.id)))).toBe(true)
    expect(host.textContent).toContain('第 1–2 段 · 共 6')
    expect(host.textContent).toContain('第一段：值班规则')
    expect(host.textContent).toContain('第二段：报销流程')
    // Imported text is data. It is shown as characters, never parsed as markup.
    expect(host.querySelector('.knowledge-preview__body b')).toBeNull()
    expect(host.textContent).toContain('<b>加粗</b>')

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('refuses a source the library never parsed into text', async () => {
    const { host, root } = await mountLibrary([officeDocument], {
      documentId: officeDocument.id,
      title: officeDocument.title,
      mimeType: officeDocument.mimeType,
      status: 'pending',
      previewable: false,
      reason: 'unsupported',
      total: 0,
      offset: 0,
      paragraphs: [],
    })
    await expandFirstDocument(host)

    expect(host.textContent).toContain('未解析为文本，无法预览')
    expect(host.textContent).not.toContain('第 1')
    expect(host.textContent).not.toContain('PDF')

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('says the body is empty rather than showing a blank reader', async () => {
    const { host, root } = await mountLibrary([{ ...markdownDocument, chunkCount: 0, status: 'pending' }], {
      documentId: markdownDocument.id,
      title: markdownDocument.title,
      mimeType: markdownDocument.mimeType,
      status: 'pending',
      previewable: true,
      total: 0,
      offset: 0,
      paragraphs: [],
    })
    await expandFirstDocument(host)

    expect(host.textContent).toContain('还没有解析出可预览的正文')
    expect(host.textContent).not.toContain('未解析为文本，无法预览')

    await act(async () => { root.unmount() })
    host.remove()
  })
})

async function mountLibrary(documents: KnowledgeDocument[], preview: unknown) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    requests.push(url)
    const body = url.includes('/preview')
      ? preview
      : url.includes('/consolidation-jobs')
        ? { items: [] }
        : { collections: [], documents }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  vi.stubGlobal('EventSource', class TestEventSource extends EventTarget {
    readonly url: string
    constructor(url: string) { super(); this.url = url }
    close(): void {}
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(KnowledgeDock, { world, demoMode: false, initialDocuments: documents }))
  })
  return { host, root, requests }
}

async function expandFirstDocument(host: HTMLElement): Promise<void> {
  const summary = host.querySelector<HTMLElement>('.knowledge-document summary')
  expect(summary).not.toBeNull()
  await act(async () => { summary?.click() })
  await act(async () => { await Promise.resolve() })
}
