import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorldKnowledgeRepository } from '@dsh-cyber/persistence'

import { createCyberServer, type CyberServer } from '../src/server.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface PreviewResponse {
  documentId: string
  title: string
  mimeType: string
  status: string
  previewable: boolean
  reason?: string
  total: number
  offset: number
  nextOffset?: number
  paragraphs: Array<{ ordinal: number; text: string }>
}

describe('knowledge document body preview route', () => {
  it('returns one truthful paragraph window at a time instead of the whole document', async () => {
    const { origin, world } = await fixture('dsh-knowledge-preview-window-')
    const current = servers.at(-1)!
    // Long enough that the parser keeps one paragraph per chunk, so the window
    // the route reports lines up with what a reader actually sees.
    const paragraphs = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 段正文，${'说明本地知识库如何按窗口读取长文档而不是一次性载入。'.repeat(24)}`)
    const document = await current.knowledge.createFromText({
      workspaceId: world.workspaceId,
      worldId: world.id,
      title: '窗口预览资料',
      text: paragraphs.join('\n\n'),
    })
    expect(document.chunkCount).toBeGreaterThan(1)

    const first = await getJson<PreviewResponse>(`${origin}${previewPath(world.id, document.id)}?limit=2`)
    expect(first.status).toBe(200)
    expect(first.body.previewable).toBe(true)
    expect(first.body.total).toBe(document.chunkCount)
    expect(first.body.offset).toBe(0)
    expect(first.body.paragraphs).toHaveLength(2)
    expect(first.body.paragraphs[0]?.ordinal).toBe(0)
    expect(first.body.nextOffset).toBe(2)
    expect(first.body.paragraphs.map((item) => item.text).join('\n')).toContain('第 1 段正文')
    // The window is the promise the UI repeats back to the user: a response
    // that quietly carried the tail as well would make 第 1–2 段 a lie.
    expect(JSON.stringify(first.body)).not.toContain('第 6 段正文')

    const second = await getJson<PreviewResponse>(`${origin}${previewPath(world.id, document.id)}?offset=2&limit=2`)
    expect(second.body.offset).toBe(2)
    expect(second.body.paragraphs[0]?.ordinal).toBe(2)
    expect(second.body.paragraphs.map((item) => item.text).join('\n')).not.toContain('第 1 段正文')

    const past = await getJson<PreviewResponse>(`${origin}${previewPath(world.id, document.id)}?offset=${document.chunkCount}`)
    expect(past.body.paragraphs).toEqual([])
    expect(past.body.nextOffset).toBeUndefined()
    expect(past.body.total).toBe(document.chunkCount)
  })

  it('refuses a source the library never parsed into text instead of guessing PDF or decoding bytes', async () => {
    const { origin, world, stateRoot } = await fixture('dsh-knowledge-preview-binary-')
    const current = servers.at(-1)!
    const repository = new WorldKnowledgeRepository(current.store.database)
    const relativePath = 'office/季度报告.docx'
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0xff, 0xfe, 0x00, 0x81, 0x9f, 0x92])
    const libraryPath = join(stateRoot, 'worlds', encodeURIComponent(world.id), 'knowledge', 'library', 'office')
    await mkdir(libraryPath, { recursive: true })
    await writeFile(join(libraryPath, '季度报告.docx'), bytes)
    const document = repository.upsertDocument({
      workspaceId: world.workspaceId,
      worldId: world.id,
      relativePath,
      title: '季度报告',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteLength: bytes.byteLength,
      sha256: 'a'.repeat(64),
      origin: 'upload',
      status: 'pending',
      chunkCount: 0,
    })

    const response = await getJson<PreviewResponse>(`${origin}${previewPath(world.id, document.id)}`)
    expect(response.status).toBe(200)
    expect(response.body.previewable).toBe(false)
    expect(response.body.reason).toBe('unsupported')
    expect(response.body.paragraphs).toEqual([])
    expect(response.body.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const raw = JSON.stringify(response.body)
    expect(raw).not.toContain('application/pdf')
    expect(raw).not.toContain('�')
    expect(raw).not.toContain('PK')
  })

  it('reports an honest empty body for a text source with no indexed paragraphs', async () => {
    const { origin, world } = await fixture('dsh-knowledge-preview-empty-')
    const current = servers.at(-1)!
    const repository = new WorldKnowledgeRepository(current.store.database)
    const document = repository.upsertDocument({
      workspaceId: world.workspaceId,
      worldId: world.id,
      relativePath: 'notes/pending.md',
      title: '尚未索引的资料',
      mimeType: 'text/markdown',
      byteLength: 12,
      sha256: 'b'.repeat(64),
      origin: 'paste',
      status: 'pending',
      chunkCount: 0,
    })

    const response = await getJson<PreviewResponse>(`${origin}${previewPath(world.id, document.id)}`)
    expect(response.status).toBe(200)
    expect(response.body.previewable).toBe(true)
    expect(response.body.total).toBe(0)
    expect(response.body.paragraphs).toEqual([])
    expect(response.body.reason).toBeUndefined()
  })

  it('does not expose a document that belongs to another world', async () => {
    const { origin, world } = await fixture('dsh-knowledge-preview-scope-')
    const current = servers.at(-1)!
    const other = current.store.createWorld({ workspaceId: world.workspaceId, name: '另一个资料世界', templateId: 'personal-world' })
    const document = await current.knowledge.createFromText({
      workspaceId: world.workspaceId,
      worldId: other.id,
      title: '他世界资料',
      text: '这份资料只属于另一个世界。',
    })

    const crossWorld = await getJson<{ error?: { code?: string } }>(`${origin}${previewPath(world.id, document.id)}`)
    expect(crossWorld.status).toBe(404)
    expect(JSON.stringify(crossWorld.body)).not.toContain('这份资料只属于另一个世界')

    const missingWorld = await getJson<unknown>(`${origin}${previewPath('world-does-not-exist', document.id)}`)
    expect(missingWorld.status).toBe(404)

    const owner = await getJson<PreviewResponse>(`${origin}${previewPath(other.id, document.id)}`)
    expect(owner.status).toBe(200)
    expect(owner.body.paragraphs[0]?.text).toContain('这份资料只属于另一个世界')
  })
})

function previewPath(worldId: string, documentId: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/library/documents/${encodeURIComponent(documentId)}/preview`
}

async function fixture(prefix: string) {
  const stateRoot = await mkdtemp(join(tmpdir(), prefix))
  roots.push(stateRoot)
  const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true })
  servers.push(server)
  const origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  return { stateRoot, origin, workspace, world }
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url)
  return { status: response.status, body: await response.json() as T }
}
