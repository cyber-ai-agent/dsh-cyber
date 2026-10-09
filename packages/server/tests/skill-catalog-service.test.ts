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
      availabilityReason: 'package-unavailable',
    })
    expect(find(await service.listWorkspace(workspace.id), 'web.search.firecrawl').availabilityReason).toBe('package-unavailable')
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
    for (const item of [...workspaceItems, ...worldAItems]) expect(item).not.toHaveProperty('availabilityReason')

    const worldBItems = await service.listWorld(worldB.id)
    expect(find(worldBItems, 'web.search.firecrawl')).toMatchObject({
      source: 'plugin', scope: 'world', globalKnown: true, worldAvailable: false, availability: 'unavailable',
      packageVersion: installed.version,
      availabilityReason: 'package-unavailable',
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
    expect(find(await service.listWorld(world.id), 'mcp.search')).not.toHaveProperty('availabilityReason')
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
      availabilityReason: 'adapter-unavailable',
    })
    expect(item?.routingHints).toEqual(['搜索官网', 'firecrawl search'])
    expect(find(await service.listWorkspace(workspace.id), 'web.search.firecrawl').availabilityReason).toBe('adapter-unavailable')
  })

  it.each(['workspace', 'world'] as const)('reports %s package conflicts without treating either declaration as available', async (conflictScope) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-catalog-conflict-')); roots.push(root)
    const installed = await skillPackage(root)
    const conflicting = await skillPackage(root, 'conflicting-firecrawl-search')
    const { workspace, world, store } = catalogFixture(conflictScope === 'workspace' ? [installed, conflicting] : [installed])
    const service = new SkillCatalogService({
      store,
      registry: { list: () => [{ ...descriptor('web.search.firecrawl', '联网搜索', 'builtin.firecrawl', 'integration'), packageId: installed.packageId }] },
      worldPackages: { listRuntimePackages: async () => conflictScope === 'world' ? [installed, conflicting] : [installed] },
    })
    expect(find(await service.listWorld(world.id), 'web.search.firecrawl')).toMatchObject({
      worldAvailable: false, availability: 'unavailable', availabilityReason: 'package-conflict',
    })
    const workspaceItem = find(await service.listWorkspace(workspace.id), 'web.search.firecrawl')
    if (conflictScope === 'workspace') expect(workspaceItem.availabilityReason).toBe('package-conflict')
    else expect(workspaceItem).not.toHaveProperty('availabilityReason')
    expect(await service.isAvailable({ workspaceId: workspace.id, worldId: world.id, skillId: 'web.search.firecrawl' })).toBe(false)
  })

  it.each([undefined, 'another-package'])('preserves host package binding checks for %s', async (packageId) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-catalog-binding-')); roots.push(root)
    const installed = await skillPackage(root)
    const { workspace, world, store } = catalogFixture([installed])
    const host = { ...descriptor('web.search.firecrawl', '联网搜索', 'builtin.firecrawl', 'integration'), ...(packageId === undefined ? {} : { packageId }) }
    const service = new SkillCatalogService({ store, registry: { list: () => [host] }, worldPackages: { listRuntimePackages: async () => [installed] } })
    for (const item of [find(await service.listWorkspace(workspace.id), host.id), find(await service.listWorld(world.id), host.id)]) {
      expect(item.worldAvailable).toBe(packageId === undefined)
      if (packageId === undefined) expect(item).not.toHaveProperty('availabilityReason')
      else expect(item.availabilityReason).toBe('adapter-package-mismatch')
    }
    expect(await service.isAvailable({ workspaceId: workspace.id, worldId: world.id, skillId: host.id })).toBe(packageId === undefined)
  })

  it('applies global defaults and exact World overrides without copying Skill definitions', async () => {
    const workspace: Workspace = { id: 'workspace-scope', name: '技能范围', status: 'active', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' }
    const world: World = { id: 'world-scope', workspaceId: workspace.id, name: '研发世界', templateId: 'personal-world', status: 'active', createdAt: workspace.createdAt, updatedAt: workspace.updatedAt }
    const records = new Map<string, { workspaceId: string; scope: 'workspace' | 'world'; scopeId: string; skillIds: string[]; updatedAt: string }>()
    const scopeSettings = {
      get: (_workspaceId: string, scope: 'workspace' | 'world', scopeId: string) => records.get(`${scope}:${scopeId}`),
      save: (input: { workspaceId: string; scope: 'workspace' | 'world'; scopeId: string; skillIds: readonly string[] }) => { const value = { ...input, skillIds: [...input.skillIds], updatedAt: workspace.updatedAt }; records.set(`${input.scope}:${input.scopeId}`, value); return value },
      clear: (_workspaceId: string, scope: 'workspace' | 'world', scopeId: string) => records.delete(`${scope}:${scopeId}`),
    }
    const service = new SkillCatalogService({
      store: { getWorkspace: (id: string) => id === workspace.id ? workspace : undefined, getWorld: (id: string) => id === world.id ? world : undefined, listWorlds: () => [world], listInstalledPackages: () => [] },
      registry: { list: () => [descriptor('coding', '软件实现', 'builtin.recipe', 'recipe'), descriptor('testing', '测试验证', 'builtin.recipe', 'recipe')] },
      worldPackages: { listRuntimePackages: async () => [] }, scopeSettings,
    })
    await service.saveSettings({ workspaceId: workspace.id, scope: 'workspace', scopeId: workspace.id, skillIds: ['coding'] })
    expect(Object.fromEntries((await service.listWorld(world.id)).map((item) => [item.id, item.worldAvailable]))).toEqual({ coding: true, testing: false })
    expect(find(await service.listWorld(world.id), 'testing').availabilityReason).toBe('workspace-disabled')
    expect(find(await service.listWorld(world.id), 'coding')).not.toHaveProperty('availabilityReason')
    // The workspace catalog is discovery; workspace settings govern inherited World selections.
    expect(find(await service.listWorkspace(workspace.id), 'testing')).not.toHaveProperty('availabilityReason')
    await service.saveSettings({ workspaceId: workspace.id, scope: 'world', scopeId: world.id, skillIds: ['testing'] })
    expect(Object.fromEntries((await service.listWorld(world.id)).map((item) => [item.id, item.worldAvailable]))).toEqual({ coding: false, testing: true })
    expect(find(await service.listWorld(world.id), 'coding').availabilityReason).toBe('world-disabled')
    expect(find(await service.listWorld(world.id), 'testing')).not.toHaveProperty('availabilityReason')
    expect((await service.listSettings(workspace.id)).worlds[0]).toMatchObject({ configured: true, inherited: false, skillIds: ['testing'] })
    await service.saveSettings({ workspaceId: workspace.id, scope: 'world', scopeId: world.id, skillIds: [] })
    for (const item of await service.listWorld(world.id)) expect(item).toMatchObject({ worldAvailable: false, availabilityReason: 'world-disabled' })
    await service.saveSettings({ workspaceId: workspace.id, scope: 'world', scopeId: world.id, inherit: true })
    expect(find(await service.listWorld(world.id), 'coding')).not.toHaveProperty('availabilityReason')
    expect(find(await service.listWorld(world.id), 'testing').availabilityReason).toBe('workspace-disabled')
    expect((await service.listSettings(workspace.id)).worlds[0]).toMatchObject({ configured: false, inherited: true, skillIds: ['coding'] })
  })

  it('loads generated declarative recipes without an executable Adapter and exposes their file tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-recipe-')); roots.push(root)
    const workspace: Workspace = { id: 'workspace-recipe', name: '技能编写', status: 'active', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' }
    const world: World = { id: 'world-recipe', workspaceId: workspace.id, name: '技能世界', templateId: 'personal-world', status: 'active', createdAt: workspace.createdAt, updatedAt: workspace.updatedAt }
    const installed = await recipePackage(root, workspace.id)
    const service = new SkillCatalogService({
      store: { getWorkspace: (id: string) => id === workspace.id ? workspace : undefined, getWorld: (id: string) => id === world.id ? world : undefined, listWorlds: () => [world], listInstalledPackages: () => [installed] },
      registry: { list: () => [] }, worldPackages: { listRuntimePackages: async () => [installed] },
    })
    expect(await service.listWorld(world.id)).toContainEqual(expect.objectContaining({ id: 'custom.release-check', kind: 'recipe', adapterId: 'builtin.recipe', worldAvailable: true }))
    expect(find(await service.listWorld(world.id), 'custom.release-check')).not.toHaveProperty('availabilityReason')
    expect(await service.instructionsForWorld({ workspaceId: workspace.id, worldId: world.id, skillIds: ['custom.release-check'] })).toEqual(['发布检查：核对测试、版本和回滚方案。'])
    const detail = await service.detailWorkspace(workspace.id, 'custom.release-check')
    expect(detail).toMatchObject({ editable: true, packageId: installed.packageId, tree: expect.arrayContaining([{ path: 'SKILL.md', kind: 'file' }]) })
    expect(detail.files.find((file) => file.path === 'SKILL.md')?.content).toContain('## 使用说明')
  })
})

function catalogFixture(packages: InstalledPackage[]) {
  const workspace: Workspace = { id: 'workspace-a', name: '技能工作区', status: 'active', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' }
  const world: World = { id: 'world-a', workspaceId: workspace.id, name: '技能世界', templateId: 'personal-world', status: 'active', createdAt: workspace.createdAt, updatedAt: workspace.updatedAt }
  return {
    workspace, world,
    store: {
      getWorkspace: (id: string) => id === workspace.id ? workspace : undefined,
      getWorld: (id: string) => id === world.id ? world : undefined,
      listInstalledPackages: () => packages,
    },
  }
}

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

async function recipePackage(root: string, workspaceId: string): Promise<InstalledPackage> {
  const skill = JSON.stringify({ schemaVersion: 1, id: 'custom.release-check', displayName: '发布检查', summary: '检查发布条件。', routingHints: ['发布'], integrationId: 'builtin.recipe', dataEgress: [], instructions: '核对测试、版本和回滚方案。' }, null, 2)
  const markdown = '# 发布检查\n\n## 使用说明\n\n核对测试、版本和回滚方案。\n'
  await writeFile(join(root, 'skill.json'), skill, 'utf8'); await writeFile(join(root, 'SKILL.md'), markdown, 'utf8')
  const manifest: CyberPackageManifest = { schemaVersion: 1, id: 'generated.skill.release-check', version: '1.0.0', kind: 'skill', displayName: '发布检查', summary: '检查发布条件。', license: 'MIT', publisher: 'DSH Cyber Skill Center', capabilities: ['skill:recipe'], dataEgress: [], files: [{ path: 'skill.json', sha256: createHash('sha256').update(skill).digest('hex') }, { path: 'SKILL.md', sha256: createHash('sha256').update(markdown).digest('hex') }], entrypoints: [{ id: 'custom.release-check', kind: 'skill', path: 'skill.json' }] }
  return { workspaceId, packageId: manifest.id, version: manifest.version, kind: 'skill', status: 'active', installedPath: root, capabilities: manifest.capabilities, manifest, installedAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' }
}
