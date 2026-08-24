import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { applyInstalledPromptTransforms } from '../src/installed-package-runtime.js'
import { WorldPackageInstanceService } from '../src/services/world-package-instance-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'

const resources: Array<{ root: string; store: SqliteStore }> = []

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.store.close()
    await rm(resource.root, { recursive: true, force: true })
  }
})

describe('WorldPackageInstanceService', () => {
  it('pins immutable prompt behavior per world across package library upgrades', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-package-'))
    const store = await SqliteStore.open(join(stateRoot, 'data', 'cyber.sqlite'))
    resources.push({ root: stateRoot, store })
    const workspace = store.createWorkspace({ name: '本地实例' })
    const firstWorld = store.createWorld({ workspaceId: workspace.id, name: '甲世界', templateId: 'personal-world' })
    const secondWorld = store.createWorld({ workspaceId: workspace.id, name: '乙世界', templateId: 'personal-world' })
    const roots = new WorldRootService(stateRoot)
    const service = new WorldPackageInstanceService(store, roots)

    const first = await installPromptPackage(store, stateRoot, workspace.id, '1.0.0', '甲世界约束')
    const firstInstance = await service.instantiate({ worldId: firstWorld.id, packageId: first.id, version: first.version })
    expect(await applyInstalledPromptTransforms(await service.listRuntimePackages(firstWorld.id), '原始消息'))
      .toBe('甲世界约束\n\n原始消息')
    expect(await applyInstalledPromptTransforms(await service.listRuntimePackages(secondWorld.id), '原始消息'))
      .toBe('原始消息')

    const second = await installPromptPackage(store, stateRoot, workspace.id, '2.0.0', '乙世界约束')
    await service.instantiate({ worldId: secondWorld.id, packageId: second.id, version: second.version })
    expect(await applyInstalledPromptTransforms(await service.listRuntimePackages(firstWorld.id), '原始消息'))
      .toBe('甲世界约束\n\n原始消息')
    expect(await applyInstalledPromptTransforms(await service.listRuntimePackages(secondWorld.id), '原始消息'))
      .toBe('乙世界约束\n\n原始消息')

    const firstRoot = await roots.ensure(firstWorld.id)
    const instanceFile = join(firstRoot.rootPath, firstInstance.originPath, 'transform.json')
    expect(JSON.parse(await readFile(instanceFile, 'utf8'))).toMatchObject({
      transforms: [{ instruction: '甲世界约束' }],
    })
    expect(store.listDomainEvents(workspace.id).filter((event) => event.type === 'world.package.instantiated')).toHaveLength(2)
  })

  it('is idempotent for the same pinned version and rejects implicit upgrades', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-package-idempotent-'))
    const store = await SqliteStore.open(join(stateRoot, 'data', 'cyber.sqlite'))
    resources.push({ root: stateRoot, store })
    const workspace = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '隔离世界', templateId: 'personal-world' })
    const service = new WorldPackageInstanceService(store, new WorldRootService(stateRoot))
    const first = await installPromptPackage(store, stateRoot, workspace.id, '1.0.0', '第一版')
    const original = await service.instantiate({ worldId: world.id, packageId: first.id, version: first.version })
    await expect(service.instantiate({ worldId: world.id, packageId: first.id, version: first.version })).resolves.toEqual(original)
    const second = await installPromptPackage(store, stateRoot, workspace.id, '2.0.0', '第二版')
    await expect(service.instantiate({ worldId: world.id, packageId: second.id, version: second.version }))
      .rejects.toMatchObject({ code: 'world_package_update_required' })
  })
})

async function installPromptPackage(
  store: SqliteStore,
  stateRoot: string,
  workspaceId: string,
  version: string,
  instruction: string,
): Promise<CyberPackageManifest> {
  const source = join(stateRoot, 'library-source', version)
  await mkdir(source, { recursive: true })
  const definition = JSON.stringify({
    schemaVersion: 1,
    transforms: [{ id: 'always', trigger: 'always', mode: 'prepend', instruction, description: instruction, priority: 1 }],
  })
  await writeFile(join(source, 'transform.json'), definition)
  const manifest: CyberPackageManifest = {
    schemaVersion: 1, id: 'local.prompt-policy', version, kind: 'plugin',
    displayName: '世界 Prompt 策略', summary: '验证世界隔离', license: 'MIT', publisher: 'Local',
    capabilities: ['prompt:transform'], dataEgress: [],
    files: [{ path: 'transform.json', sha256: createHash('sha256').update(definition).digest('hex') }],
    entrypoints: [{ id: 'prompt', kind: 'prompt-transform', path: 'transform.json' }],
  }
  const transaction = store.beginPackageInstall({ workspaceId, manifest, approvedCapabilities: manifest.capabilities })
  store.markPackageInstallStaged(transaction.id)
  store.completePackageInstall({ transactionId: transaction.id, manifest, installedPath: source })
  return manifest
}
