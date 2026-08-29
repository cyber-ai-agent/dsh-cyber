import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'

import { KnowledgeDock } from '../src/features/knowledge/KnowledgeDock.js'

const world: World = {
  id: 'knowledge-live-world',
  workspaceId: 'knowledge-live-workspace',
  name: '知识实时世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readonly #listeners = new Map<string, Set<(event: Event) => void>>()
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
  }

  emit(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(new Event(type))
  }

  close(): void { this.closed = true }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
})

describe('Knowledge live refresh', () => {
  it('shares /live and reloads only on world-knowledge events', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ collections: [], documents: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(KnowledgeDock, { world, demoMode: false })) })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe(`/api/worlds/${world.id}/live`)
    const libraryRequests = () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/knowledge') && !String(input).includes('/knowledge/consolidation-jobs')).length
    const jobRequests = () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/knowledge/consolidation-jobs')).length
    const beforeWorldState = { library: libraryRequests(), jobs: jobRequests() }

    await act(async () => { FakeEventSource.instances[0]?.emit('world-state') })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect({ library: libraryRequests(), jobs: jobRequests() }).toEqual(beforeWorldState)

    await act(async () => { FakeEventSource.instances[0]?.emit('world-knowledge') })
    await vi.waitFor(() => expect({ library: libraryRequests(), jobs: jobRequests() }).toEqual({
      library: beforeWorldState.library + 1,
      jobs: beforeWorldState.jobs + 1,
    }))

    await act(async () => { root.unmount() })
    host.remove()
  })
})
