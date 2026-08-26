import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { InstalledPackage, Workspace, World } from '@dsh-cyber/contracts'
import { LocalPackageCatalog } from '@dsh-cyber/package-runtime'

import { BrowserSkillAdapter } from '../src/skills/browser-skill-adapter.js'
import { SkillCatalogService } from '../src/services/skill-catalog-service.js'

const marketplaceRoot = fileURLToPath(new URL('../../../marketplace', import.meta.url))

describe('Browser package catalog and World availability', () => {
  it('keeps Browser globally known but unavailable until the current World pins the package', async () => {
    const workspace: Workspace = {
      id: 'workspace-browser-catalog', name: 'Browser 工作区', status: 'active',
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }
    const worldA: World = {
      id: 'world-browser-a', workspaceId: workspace.id, name: '甲世界', templateId: 'personal-world', status: 'active',
      createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
    }
    const worldB: World = {
      id: 'world-browser-b', workspaceId: workspace.id, name: '乙世界', templateId: 'personal-world', status: 'active',
      createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
    }
    const market = await new LocalPackageCatalog(marketplaceRoot).find('official-browser')
    expect(market).toBeDefined()
    const installed = installedPackage(workspace.id, market!.manifest, market!.sourceDirectory)
    const installedPackages: InstalledPackage[] = []
    const runtimePackages = new Map<string, InstalledPackage[]>()
    const store = {
      getWorkspace: (id: string) => id === workspace.id ? workspace : undefined,
      getWorld: (id: string) => id === worldA.id ? worldA : id === worldB.id ? worldB : undefined,
      listInstalledPackages: (_workspaceId: string) => installedPackages,
    }
    const browser = new BrowserSkillAdapter({ store: { getWorld: store.getWorld } })
    const service = new SkillCatalogService({
      store,
      registry: { list: (_workspaceId?: string) => browser.descriptors.slice() },
      worldPackages: { listRuntimePackages: async (worldId: string) => runtimePackages.get(worldId) ?? [] },
    })

    expect(await service.listWorld(worldA.id)).toContainEqual(expect.objectContaining({
      id: 'browser.read', packageId: 'official-browser', globalKnown: true, worldAvailable: false, availability: 'unavailable',
    }))

    installedPackages.push(installed)
    expect(await service.listWorkspace(workspace.id)).toContainEqual(expect.objectContaining({
      id: 'browser.read', source: 'plugin', worldAvailable: true, packageId: 'official-browser',
    }))
    runtimePackages.set(worldA.id, [installed])
    expect(await service.listWorld(worldA.id)).toContainEqual(expect.objectContaining({
      id: 'browser.read', source: 'plugin', scope: 'world', worldAvailable: true, availability: 'available',
    }))
    expect(await service.listWorld(worldB.id)).toContainEqual(expect.objectContaining({
      id: 'browser.read', globalKnown: true, worldAvailable: false, availability: 'unavailable',
    }))
  })
})

function installedPackage(workspaceId: string, manifest: InstalledPackage['manifest'], installedPath: string): InstalledPackage {
  return {
    workspaceId,
    packageId: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    status: 'active',
    installedPath,
    capabilities: [...manifest.capabilities],
    manifest,
    installedAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  }
}
