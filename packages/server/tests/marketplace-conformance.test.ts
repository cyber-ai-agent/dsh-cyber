import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type {
  CyberMarketPackage,
  InstalledPackage,
  WorldActivityKind,
} from '@dsh-cyber/contracts'
import { LocalPackageCatalog } from '@dsh-cyber/package-runtime'

import {
  applyInstalledPromptTransforms,
  loadInstalledBlueprints,
  loadInstalledWorldThemes,
} from '../src/installed-package-runtime.js'

const marketplaceRoot = fileURLToPath(new URL('../../../marketplace', import.meta.url))
const requiredActivities: WorldActivityKind[] = [
  'idle',
  'walking',
  'thinking',
  'working',
  'talking',
  'meeting',
  'blocked',
  'celebrating',
]
const requiredActivityEvents = [
  'task.started',
  'turn.started',
  'tool.started',
  'message.appended',
  'task.blocked',
  'task.completed',
  'meeting.started',
  'meeting.finished',
]
const blueprintKeys = [
  'createdAt',
  'displayName',
  'id',
  'persona',
  'requestedCapabilities',
  'requestedSkills',
  'role',
  'schemaVersion',
  'summary',
  'version',
  'worldTemplateId',
]

describe('community marketplace contract', () => {
  it('keeps every checked-in package discoverable and aligned with its current entrypoint contract', async () => {
    const catalog = new LocalPackageCatalog(marketplaceRoot)
    const items = await catalog.list()
    expect(items).toHaveLength(await packageDirectoryCount())

    for (const item of items) {
      expect(item.manifest.files.length).toBeGreaterThan(0)
      expect(new Set(item.manifest.files.map((file) => file.path)).size).toBe(item.manifest.files.length)
      for (const file of item.manifest.files) {
        expect(file.path).toMatch(/^[a-z0-9][a-z0-9./-]*$/)
        expect(file.path.split('/').some((segment) => segment.startsWith('.'))).toBe(false)
      }

      if (item.market === 'theme') await expectTheme(item)
      else if (item.manifest.kind === 'skill') await expectSkill(item)
      else if (item.market === 'talent') await expectBlueprint(item)
      else await expectPlugin(item)
    }
  })
})

async function packageDirectoryCount(): Promise<number> {
  const directories = await Promise.all(['themes', 'plugins', 'talent'].map(async (market) =>
    (await readdir(fileURLToPath(new URL(`../../../marketplace/${market}/`, import.meta.url)), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).length))
  return directories.reduce((total, count) => total + count, 0)
}

async function expectSkill(item: CyberMarketPackage): Promise<void> {
  expect(item.manifest.kind).toBe('skill')
  expect(item.manifest.dataEgress.every((value) => value.startsWith('https://'))).toBe(true)
  const entrypoints = item.manifest.entrypoints?.filter((entrypoint) => entrypoint.kind === 'skill') ?? []
  expect(entrypoints).toHaveLength(1)
  for (const entrypoint of entrypoints) {
    const definition = JSON.parse(await readFile(join(item.sourceDirectory, ...entrypoint.path.split('/')), 'utf8')) as Record<string, unknown>
    expect(Object.keys(definition).sort()).toEqual(['dataEgress', 'displayName', 'id', 'instructions', 'integrationId', 'schemaVersion', 'summary'])
    expect(definition.id).toBe(entrypoint.id)
    expect(definition.schemaVersion).toBe(1)
    expect(typeof definition.instructions === 'string' && definition.instructions.trim().length > 0).toBe(true)
  }
}

async function expectTheme(item: CyberMarketPackage): Promise<void> {
  expect(item.manifest.kind).toBe('world-theme')
  expect(item.manifest.capabilities).toContain('world:render')
  expect(item.manifest.dataEgress).toEqual([])
  const entrypoints = item.manifest.entrypoints?.filter((entrypoint) => entrypoint.kind === 'world-theme') ?? []
  expect(entrypoints).toHaveLength(1)

  const themes = await loadInstalledWorldThemes([installed(item)])
  expect(themes).toHaveLength(entrypoints.length)
  for (const { manifest } of themes) {
    for (const asset of manifest.assets) {
      expect(asset.src).toMatch(/^assets\/[a-z0-9][a-z0-9./-]*$/)
      expect(item.manifest.files.some((file) => file.path === asset.src)).toBe(true)
    }
    for (const actorSet of manifest.actorSets) {
      for (const activity of requiredActivities) {
        expect(Object.values(actorSet.clips[activity]).some((frames) => (frames?.length ?? 0) > 0)).toBe(true)
      }
    }
    for (const event of requiredActivityEvents) expect(manifest.activityMapping[event]).toBeDefined()
  }
}

async function expectBlueprint(item: CyberMarketPackage): Promise<void> {
  expect(item.manifest.kind).toBe('employee-blueprint')
  expect(item.manifest.capabilities).toContain('employee:blueprint')
  expect(item.manifest.dataEgress).toEqual([])
  const entrypoints = item.manifest.entrypoints?.filter((entrypoint) => entrypoint.kind === 'employee-blueprint') ?? []
  expect(entrypoints).toHaveLength(1)
  const blueprints = await loadInstalledBlueprints([installed(item)])
  expect(blueprints).toHaveLength(1)
  for (const capability of blueprints[0]!.requestedCapabilities) {
    expect(item.manifest.capabilities).toContain(capability)
  }

  for (const entrypoint of entrypoints) {
    const raw = JSON.parse(await readFile(join(item.sourceDirectory, ...entrypoint.path.split('/')), 'utf8')) as unknown
    expect(Array.isArray(raw)).toBe(false)
    expect(Object.keys(raw as Record<string, unknown>).sort()).toEqual(blueprintKeys)
  }
}

async function expectPlugin(item: CyberMarketPackage): Promise<void> {
  expect(item.manifest.kind).toBe('plugin')
  expect(item.manifest.capabilities).toContain('prompt:transform')
  expect(item.manifest.dataEgress).toEqual([])
  const entrypoints = item.manifest.entrypoints?.filter((entrypoint) => entrypoint.kind === 'prompt-transform') ?? []
  expect(entrypoints.length).toBeGreaterThan(0)

  for (const entrypoint of entrypoints) {
    const definition = JSON.parse(await readFile(join(item.sourceDirectory, ...entrypoint.path.split('/')), 'utf8')) as {
      schemaVersion: unknown
      transforms: Array<Record<string, unknown>>
    }
    expect(Object.keys(definition).sort()).toEqual(['schemaVersion', 'transforms'])
    expect(definition.schemaVersion).toBe(1)
    expect(definition.transforms.length).toBeGreaterThan(0)
    for (const transform of definition.transforms) {
      expect(Object.keys(transform).sort()).toEqual(['description', 'id', 'instruction', 'mode', 'priority', 'trigger'])
      expect(transform.id).toMatch(/^[a-z0-9-]+$/)
      expect(transform.trigger === 'always' || /^\/[a-z0-9-]+$/.test(String(transform.trigger))).toBe(true)
      expect(typeof transform.description === 'string' && transform.description.trim().length > 0 && String(transform.description).length <= 200).toBe(true)
      expect(typeof transform.instruction === 'string' && transform.instruction.trim().length > 0 && String(transform.instruction).length <= 2000).toBe(true)
      expect(['prepend', 'append', 'replace']).toContain(transform.mode)
      expect(Number.isInteger(transform.priority) && Number.isFinite(transform.priority)).toBe(true)
      const original = `${String(transform.trigger)} request`
      const transformed = await applyInstalledPromptTransforms([installed(item)], original)
      expect(transformed).toContain(String(transform.instruction).trim())
      if (transform.mode !== 'replace') expect(transformed).toContain(original)
    }
  }
}

function installed(item: CyberMarketPackage): InstalledPackage {
  const now = '2026-08-20T00:00:00.000Z'
  return {
    workspaceId: 'community-conformance',
    packageId: item.manifest.id,
    version: item.manifest.version,
    kind: item.manifest.kind,
    status: 'active',
    installedPath: item.sourceDirectory,
    capabilities: item.manifest.capabilities,
    manifest: item.manifest,
    installedAt: now,
    updatedAt: now,
  }
}
