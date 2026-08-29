import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  CharacterSkillDescriptor,
  CyberPackageManifest,
  InstalledPackage,
  SkillCatalogEntry,
  Workspace,
  World,
} from '@dsh-cyber/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { SkillCatalogService } from '../src/services/skill-catalog-service.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('SkillCatalogService', () => {
  it('separates installed plugin discovery from pinned World availability and preserves package routing metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-catalog-'))
    roots.push(root)
    const workspace: Workspace = {
      id: 'workspace-a', name: '本地工作区', status: 'active',
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }
    const worldA: World = {
      id: 'world-a', workspaceId: workspace.id, name: '甲世界', templateId: 'personal-world', status: 'active',
      createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
    }
    const worldB: World = {
      id: 'world-b', workspaceId: workspace.id, name: '乙世界', templateId: 'personal-world', status: 'active',
      createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
    }
    const installed = await skillPackage(root)
    const builtin = descriptor('coding', '软件实现', 'builtin.recipe', 'recipe')
    const firecrawl = {
      ...descriptor('web.search.firecrawl', '联网搜索', 'builtin.firecrawl', 'integration'),
      packageId: installed.packageId,
      routingHints: ['联网'],
    }
    const installedPackages: InstalledPackage[] = []
    const registry = {
      list: (_workspaceId?: string): CharacterSkillDescriptor[] => [builtin, firecrawl],
    }
    const store = {
      getWorkspace: (id: string) => id === workspace.id ? workspace : undefined,
      getWorld: (id: string) => id === worldA.id ? worldA : id === worldB.id ? worldB : undefined,
      listInstalledPackages: (_workspaceId: string) => installedPackages,
    }
    const worldPackages = {
      listRuntimePackages: async (worldId: string) => worldId === worldA.id && installedPackages.length > 0 ? [installed] : [],
    }
    const service = new SkillCatalogService({ store, registry, worldPackages })

    const beforeInstall = await service.listWorld(worldA.id)
    expect(find(beforeInstall, 'web.search.firecrawl')).toMatchObject({
      source: 'plugin', globalKnown: true, worldAvailable: false, availability: 'unavailable',
    })
    installedPackages.push(installed)

    const workspaceItems = await service.listWorkspace(workspace.id)
    expect(find(workspaceItems, 'coding')).toMatchObject({
      source: 'builtin', scope: 'builtin', globalKnown: true, worldAvailable: true, availability: 'available',
    })
    expect(find(workspaceItems, 'web.search.firecrawl')).toMatchObject({
      source: 'plugin', packageId: installed.packageId, packageVersion: installed.version,
      globalKnown: true, worldAvailable: true, availability: 'available',
    })

    const worldAItems = await service.listWorld(worldA.id)
    const worldAFirecrawl = find(worldAItems, 'web.search.firecrawl')
    expect(worldAFirecrawl).toMatchObject({
      source: 'plugin', scope: 'world', worldAvailable: true, availability: 'available',
      packageVersion: installed.version,
      adapterId: 'builtin.firecrawl',
    })
    expect(worldAFirecrawl.routingHints).toEqual(['联网', '搜索官网', 'firecrawl search'])

    const worldBItems = await service.listWorld(worldB.id)
    expect(find(worldBItems, 'web.search.firecrawl')).toMatchObject({
      source: 'plugin', scope: 'world', globalKnown: true, worldAvailable: false, availability: 'unavailable',
      packageVersion: installed.version,
    })
    expect(await service.isAvailable({ workspaceId: workspace.id, worldId: worldA.id, skillId: 'web.search.firecrawl' })).toBe(true)
    expect(await service.isAvailable({ workspaceId: workspace.id, worldId: worldB.id, skillId: 'web.search.firecrawl' })).toBe(false)
  })

  it('keeps MCP workspace scope without requiring a World Package Instance', async () => {
    const workspace: Workspace = {
      id: 'workspace-mcp', name: 'MCP 工作区', status: 'active',
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }
    const world: World = {
      id: 'world-mcp', workspaceId: workspace.id, name: 'MCP 世界', templateId: 'personal-world', status: 'active',
      createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
    }
    const registry = {
      list: (_workspaceId?: string): CharacterSkillDescriptor[] => [descriptor('mcp.search', 'MCP 搜索', 'builtin.mcp', 'integration')],
    }
    const store = {
      getWorkspace: (id: string) => id === workspace.id ? workspace : undefined,
      getWorld: (id: string) => id === world.id ? world : undefined,
      listInstalledPackages: (_workspaceId: string) => [],
    }
    const service = new SkillCatalogService({
      store,
      registry,
      worldPackages: { listRuntimePackages: async () => [] },
    })
    expect(await service.listWorld(world.id)).toContainEqual(expect.objectContaining({
      id: 'mcp.search', source: 'mcp', scope: 'workspace', globalKnown: true, worldAvailable: true,
    }))
  })

  it('does not make a package declaration executable without a trusted descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-catalog-unbound-'))
    roots.push(root)
    const workspace: Workspace = {
      id: 'workspace-unbound', name: '未绑定工作区', status: 'active',
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    }
    const world: World = {
      id: 'world-unbound', workspaceId: workspace.id, name: '未绑定世界', templateId: 'personal-world', status: 'active',
      createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
    }
    const installed = await skillPackage(root, 'unbound.skill')
    const store = {
      getWorkspace: (id: string) => id === workspace.id ? workspace : undefined,
      getWorld: (id: string) => id === world.id ? world : undefined,
      listInstalledPackages: (_workspaceId: string) => [installed],
    }
    const service = new SkillCatalogService({
      store,
      registry: { list: (_workspaceId?: string) => [] },
      worldPackages: { listRuntimePackages: async () => [installed] },
    })
    const item = (await service.listWorld(world.id)).find((entry) => entry.id === 'web.search.firecrawl')
    expect(item).toMatchObject({
      source: 'plugin', globalKnown: true, worldAvailable: false, availability: 'unavailable', adapterId: 'unbound.package',
    })
    expect(item?.routingHints).toEqual(['搜索官网', 'firecrawl search'])
  })
})

function find(items: SkillCatalogEntry[], id: string): SkillCatalogEntry {
  const item = items.find((entry) => entry.id === id)
  if (item === undefined) throw new Error(`Missing catalog item ${id}`)
  return item
}

function descriptor(id: string, displayName: string, adapterId: string, kind: 'recipe' | 'integration'): CharacterSkillDescriptor {
  return {
    id, displayName, summary: `${displayName}说明`, adapterId, risks: [], supportsScheduling: false,
    persistentApproval: 'forbidden', kind, recommendedByDefault: kind === 'recipe',
  }
}

async function skillPackage(root: string, packageId = 'official-firecrawl-search'): Promise<InstalledPackage> {
  const definition = JSON.stringify({
    schemaVersion: 1,
    id: 'web.search.firecrawl',
    displayName: '联网搜索',
    summary: '通过受信任的网页搜索连接查找公开资料。',
    routingHints: ['搜索官网', 'firecrawl search'],
    integrationId: 'builtin.firecrawl',
    dataEgress: ['搜索查询文本'],
    instructions: '只在用户明确要求联网搜索时使用。',
  })
  const path = join(root, 'skill.json')
  await writeFile(path, definition, 'utf8')
  const manifest: CyberPackageManifest = {
    schemaVersion: 1,
    id: packageId,
    version: '1.0.0',
    kind: 'skill',
    displayName: '联网搜索 Skill',
    summary: '为当前世界声明联网搜索能力。',
    license: 'MIT',
    publisher: 'DSH Cyber',
    capabilities: ['integration:firecrawl'],
    dataEgress: ['https://api.firecrawl.dev'],
    files: [{ path: 'skill.json', sha256: createHash('sha256').update(definition).digest('hex') }],
    entrypoints: [{ id: 'web.search.firecrawl', kind: 'skill', path: 'skill.json' }],
  }
  return {
    workspaceId: 'workspace-a', packageId, version: manifest.version, kind: 'skill', status: 'active',
    installedPath: root, capabilities: manifest.capabilities, manifest,
    installedAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
  }
}
