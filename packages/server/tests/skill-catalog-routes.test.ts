import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { SkillCatalogEntry, Workspace, World } from '@dsh-cyber/contracts'
import { describe, expect, it } from 'vitest'

import { Router } from '../src/http/router.js'
import { registerPackageRoutes } from '../src/routes/package-routes.js'

class FakeResponse {
  statusCode = 0
  headersSent = false
  writableEnded = false
  readonly chunks: string[] = []

  writeHead(status: number): this {
    this.statusCode = status
    this.headersSent = true
    return this
  }

  end(value?: string | Buffer): this {
    if (value !== undefined) this.chunks.push(String(value))
    this.writableEnded = true
    return this
  }

  text(): string { return this.chunks.join('') }
}

describe('Skill Catalog routes', () => {
  it('returns the unified {items} shape for workspace and world catalogs', async () => {
    const workspace: Workspace = {
      id: 'workspace-1', name: '本地工作区', status: 'active',
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }
    const world: World = {
      id: 'world-1', workspaceId: workspace.id, name: '当前世界', templateId: 'personal-world', status: 'active',
      createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
    }
    const item: SkillCatalogEntry = {
      id: 'coding', displayName: '软件实现', summary: '安全实现。', adapterId: 'builtin.recipe', risks: [],
      supportsScheduling: false, persistentApproval: 'forbidden', kind: 'recipe', recommendedByDefault: true,
      source: 'builtin', scope: 'builtin', globalKnown: true, worldAvailable: true, availability: 'available',
    }
    const router = new Router()
    registerPackageRoutes(router, {
      store: {
        databasePath: 'C:/tmp/dsh-cyber.sqlite',
        getWorkspace: (id: string) => id === workspace.id ? workspace : undefined,
        getWorld: (id: string) => id === world.id ? world : undefined,
      } as never,
      packageManager: {} as never,
      packageCatalog: {} as never,
      skillRuntime: {} as never,
      worldMarketplace: {} as never,
      worldPackages: {} as never,
      worldAccess: { assertUnlocked: async () => undefined } as never,
      skillCatalog: {
        listWorkspace: async () => [item],
        listWorld: async () => [item],
      } as never,
    })

    const workspaceResponse = response()
    await router.dispatch(request(`/api/workspaces/${workspace.id}/skill-catalog`), workspaceResponse.node)
    expect(workspaceResponse.fake.statusCode).toBe(200)
    expect(JSON.parse(workspaceResponse.fake.text())).toEqual({ items: [item] })

    const worldResponse = response()
    await router.dispatch(request(`/api/worlds/${world.id}/skill-catalog`), worldResponse.node)
    expect(worldResponse.fake.statusCode).toBe(200)
    expect(JSON.parse(worldResponse.fake.text())).toEqual({ items: [item] })
  })
})

function request(url: string): IncomingMessage {
  const value = new EventEmitter() as IncomingMessage
  Object.assign(value, { method: 'GET', url, headers: {} })
  return value
}

function response(): { fake: FakeResponse; node: ServerResponse } {
  const fake = new FakeResponse()
  return { fake, node: fake as unknown as ServerResponse }
}
