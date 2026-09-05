import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchArtifactPreview, useWorldArtifacts, type ArtifactRecord } from '../src/features/artifacts/useWorldArtifacts.js'

const artifact: ArtifactRecord = {
  id: 'report', worldId: 'world-a', workspaceId: 'workspace', title: 'data.json', kind: 'data', status: 'active',
  currentVersion: 1, createdByKind: 'owner', createdById: 'owner', createdAt: '', updatedAt: '',
}
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('artifact raw-file preview', () => {
  it.each([null, 42, 'hello', ['one'], { content: 'not an envelope', src: 'https://example.com/private' }, { entries: [{ path: 'ordinary-data' }] }])('renders JSON data without interpreting envelope-like keys: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    const preview = await fetchArtifactPreview('world-a', artifact)
    expect(preview.content).toBe(JSON.stringify(body, null, 2))
    expect(preview.src).toBeUndefined()
    expect(preview.files).toBeUndefined()
  })
  it('recognizes a tree only at the project root', async () => {
    const body = { entries: [{ path: 'README.md', byteLength: 30 }] }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    expect((await fetchArtifactPreview('world-a', { ...artifact, kind: 'project' })).files).toEqual(body.entries)
    expect((await fetchArtifactPreview('world-a', { ...artifact, kind: 'project' }, 1, 'data.json')).content).toBe(JSON.stringify(body, null, 2))
  })
  it('opens a project HTML child with the controlled URL, not inline content', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const preview = await fetchArtifactPreview('world-a', { ...artifact, kind: 'project' }, 1, 'index.html')
    expect(preview.src).toContain('/preview/1?path=index.html')
    expect(preview.mimeType).toBe('text/html')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not guess that an Office document is PDF or decode it as text', async () => {
    const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0, 255]), { headers: { 'content-type': mimeType } })))
    const preview = await fetchArtifactPreview('world-a', { ...artifact, kind: 'document', title: 'report.docx' })
    expect(preview.mimeType).toBe(mimeType)
    expect(preview.content).toBeUndefined()
    expect(preview.src).toContain('/preview')
  })
})

describe('artifact list request ownership', () => {
  it('rejects late responses after a world or query change', async () => {
    vi.stubGlobal('EventSource', undefined)
    const requests: Array<{ resolve(value: Response): void }> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { requests.push({ resolve }) })))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let latest!: ReturnType<typeof useWorldArtifacts>
    function Probe({ worldId }: { worldId: string }) {
      latest = useWorldArtifacts({ worldId })
      return createElement('p', null, latest.artifacts.map((item) => item.title).join(','))
    }
    try {
      await act(async () => root.render(createElement(Probe, { worldId: 'world-a' })))
      await act(async () => root.render(createElement(Probe, { worldId: 'world-b' })))
      await act(async () => requests[1]!.resolve(Response.json({ artifacts: [{ ...artifact, worldId: 'world-b', title: 'B current' }] })))
      await act(async () => requests[0]!.resolve(Response.json({ artifacts: [{ ...artifact, title: 'A stale' }] })))
      expect(host.textContent).toBe('B current')
      await act(async () => latest.setQuery('old query'))
      await act(async () => latest.setQuery('new query'))
      await act(async () => requests[3]!.resolve(Response.json({ artifacts: [{ ...artifact, worldId: 'world-b', title: 'new query result' }] })))
      await act(async () => requests[2]!.resolve(Response.json({ artifacts: [] })))
      expect(host.textContent).toBe('new query result')
      expect(latest.loading).toBe(false)
    } finally { await act(async () => root.unmount()) }
  })
})
