import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import {
  LocalPackageRuntime,
  LocalPackageCatalog,
  PackageApprovalRequiredError,
  PackageInstallError,
  PackageManager,
  packageContentDigest,
  type PackageStorePort,
  validatePackageManifest,
} from '../src/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function manifest(version: string, content: string, capabilities = ['workspace:read']): CyberPackageManifest {
  return {
    schemaVersion: 1,
    id: '@cyber/example-skill',
    version,
    kind: 'skill',
    displayName: '示例技能',
    summary: '用于验证事务安装。',
    license: 'PolyForm-Noncommercial-1.0.0',
    publisher: 'DSH Cyber',
    capabilities,
    dataEgress: [],
    files: [
      {
        path: 'SKILL.md',
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    ],
  }
}

describe('PackageManager', () => {
  it('searches independent market folders and verifies official package content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-market-'))
    const source = join(directory, 'plugins', 'meeting-notes')
    await mkdir(source, { recursive: true })
    const content = `${JSON.stringify({ schemaVersion: 1, transforms: [{ id: 'meeting-summary', trigger: '/meeting-summary', description: '整理会议事实。', instruction: '输出会议纪要。', mode: 'prepend', priority: 0 }] }, null, 2)}\n`
    await writeFile(join(source, 'transforms.json'), content, 'utf8')
    const packageManifest: CyberPackageManifest = {
      schemaVersion: 1,
      id: '@dsh-cyber/meeting-notes',
      version: '1.0.0',
      kind: 'plugin',
      displayName: '会议纪要插件',
      summary: '把斜杠命令转换为可执行的会议纪要提示。',
      license: 'BUSL-1.1',
      publisher: 'DSH Cyber',
      capabilities: ['prompt:transform'],
      dataEgress: [],
      files: [{ path: 'transforms.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'transforms', kind: 'prompt-transform', path: 'transforms.json' }],
    }
    packageManifest.certification = {
      authority: 'DSH Cyber',
      level: 'official',
      contentSha256: '0'.repeat(64),
    }
    packageManifest.certification.contentSha256 = packageContentDigest(packageManifest)
    await writeFile(join(source, 'dsh-cyber.package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8')

    const catalog = new LocalPackageCatalog(directory)
    const results = await catalog.list({ market: 'plugin', query: '会议' })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ market: 'plugin', verified: true })
    expect(results[0]?.manifest.entrypoints?.[0]?.kind).toBe('prompt-transform')

    await writeFile(join(source, 'transforms.json'), '{"tampered":true}\n', 'utf8')
    expect(await catalog.list({ market: 'plugin' })).toEqual([])
  })

  it('requires an exact permission approval and atomically activates a verified package', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-package-'))
    const source = join(directory, 'source-v1')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(source, { recursive: true }))
    await writeFile(join(source, 'SKILL.md'), '# Example\n', 'utf8')
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const runtime = new LocalPackageRuntime(join(directory, 'packages'))
    const manager = new PackageManager({ store, runtime })
    const packageManifest = manifest('1.0.0', '# Example\n')
    const preview = manager.preview(workspace.id, packageManifest)

    expect(preview.addedCapabilities).toEqual(['workspace:read'])
    expect(preview.approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(preview.approvalExpiresAt)).toBeGreaterThan(Date.now())
    await expect(
      manager.install({
        workspaceId: workspace.id,
        manifest: packageManifest,
        sourceDirectory: source,
        approvalToken: 'stale-approval',
      }),
    ).rejects.toBeInstanceOf(PackageApprovalRequiredError)
    expect(store.listPackageInstallTransactions(workspace.id)).toEqual([])

    const installed = await manager.install({
      workspaceId: workspace.id,
      manifest: packageManifest,
      sourceDirectory: source,
      approvalToken: preview.approvalToken,
    })
    expect(installed.status).toBe('active')
    expect(store.getActivePackage(workspace.id, packageManifest.id)?.version).toBe('1.0.0')
    expect(store.listPackageInstallTransactions(workspace.id)[0]?.status).toBe('activated')
    expect(
      store.listDomainEvents(workspace.id).map((event) => event.type),
    ).toEqual(expect.arrayContaining([
      'package.install.approved',
      'package.install.staged',
      'package.install.activated',
    ]))
    await expect(manager.install({
      workspaceId: workspace.id,
      manifest: packageManifest,
      sourceDirectory: source,
      approvalToken: preview.approvalToken,
    })).rejects.toBeInstanceOf(PackageApprovalRequiredError)
  })

  it('binds a one-time random grant to all manifest content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-approval-'))
    const source = join(directory, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '# Example\n', 'utf8')
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: 'Approval binding' })
    const manager = new PackageManager({ store, runtime: new LocalPackageRuntime(join(directory, 'packages')) })
    const original = manifest('1.0.0', '# Example\n')
    original.entrypoints = [{ id: 'skill', kind: 'skill', path: 'SKILL.md' }]
    const mutations: Array<(value: CyberPackageManifest) => void> = [
      (value) => { value.files[0]!.sha256 = 'a'.repeat(64) },
      (value) => { value.entrypoints![0]!.id = 'changed' },
      (value) => { value.publisher = 'Different publisher' },
      (value) => { value.license = 'MIT' },
    ]
    for (const mutate of mutations) {
      const preview = manager.preview(workspace.id, original)
      const changed = structuredClone(original)
      mutate(changed)
      await expect(manager.install({ workspaceId: workspace.id, manifest: changed, sourceDirectory: source, approvalToken: preview.approvalToken })).rejects.toBeInstanceOf(PackageApprovalRequiredError)
      await expect(manager.install({ workspaceId: workspace.id, manifest: original, sourceDirectory: source, approvalToken: preview.approvalToken })).rejects.toBeInstanceOf(PackageApprovalRequiredError)
    }
    expect(new Set(Array.from({ length: 32 }, () => manager.preview(workspace.id, original).approvalToken)).size).toBe(32)
  })

  it('expires grants and invalidates them when the active package changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-approval-expiry-'))
    const source = join(directory, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '# Example\n', 'utf8')
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: 'Approval expiry' })
    let now = new Date('2026-08-20T00:00:00.000Z')
    const manager = new PackageManager({
      store,
      runtime: new LocalPackageRuntime(join(directory, 'packages')),
      clock: () => now,
      approvalTtlMs: 1_000,
    })
    const first = manifest('1.0.0', '# Example\n')
    const expired = manager.preview(workspace.id, first)
    now = new Date('2026-08-20T00:00:01.000Z')
    await expect(manager.install({ workspaceId: workspace.id, manifest: first, sourceDirectory: source, approvalToken: expired.approvalToken })).rejects.toBeInstanceOf(PackageApprovalRequiredError)
    now = new Date('2026-08-20T00:00:02.000Z')
    await manager.install({ workspaceId: workspace.id, manifest: first, sourceDirectory: source, approvalToken: manager.preview(workspace.id, first).approvalToken })
    const future = manifest('3.0.0', '# Example\n')
    const stale = manager.preview(workspace.id, future)
    const replacement = manifest('2.0.0', '# Example\n')
    await manager.install({ workspaceId: workspace.id, manifest: replacement, sourceDirectory: source, approvalToken: manager.preview(workspace.id, replacement).approvalToken })
    await expect(manager.install({ workspaceId: workspace.id, manifest: future, sourceDirectory: source, approvalToken: stale.approvalToken })).rejects.toBeInstanceOf(PackageApprovalRequiredError)
  })

  it('rejects manifest fields, entrypoint capabilities, hidden paths, and unsupported declarative egress', () => {
    const plugin: CyberPackageManifest = {
      ...manifest('1.0.0', '# Example\n'),
      id: 'strict-plugin',
      kind: 'plugin',
      capabilities: ['prompt:transform'],
      files: [{ path: 'plugin.json', sha256: 'a'.repeat(64) }],
      entrypoints: [{ id: 'main', kind: 'prompt-transform', path: 'plugin.json' }],
    }
    expect(() => validatePackageManifest({
      ...plugin,
      capabilities: [],
    })).toThrow('requires capability prompt:transform')
    expect(() => validatePackageManifest({
      ...plugin,
      dataEgress: ['https://example.com/upload'],
    })).toThrow('does not support data egress')
    expect(() => validatePackageManifest({
      ...plugin,
      files: [{ path: '.hidden.json', sha256: 'a'.repeat(64) }],
      entrypoints: [{ id: 'main', kind: 'prompt-transform', path: '.hidden.json' }],
    })).toThrow('Unsafe package file path')
    expect(() => validatePackageManifest({
      ...plugin,
      futureField: true,
    } as CyberPackageManifest)).toThrow('Unknown package manifest field')
    expect(() => validatePackageManifest({
      ...plugin,
      id: 'strict-blueprint',
      kind: 'employee-blueprint',
      capabilities: ['employee:blueprint'],
      entrypoints: [
        { id: 'first', kind: 'employee-blueprint', path: 'plugin.json' },
        { id: 'second', kind: 'employee-blueprint', path: 'plugin.json' },
      ],
    })).toThrow('requires exactly one entrypoint')

    const certified = structuredClone(plugin)
    certified.certification = {
      authority: 'DSH Cyber',
      level: 'official',
      contentSha256: packageContentDigest({
        ...certified,
        certification: { authority: 'DSH Cyber', level: 'official', contentSha256: '0'.repeat(64) },
      }),
    }
    expect(() => validatePackageManifest(certified)).not.toThrow()
    expect(() => validatePackageManifest({ ...certified, publisher: 'Changed publisher' }))
      .toThrow('certification digest does not match')
  })

  it('restores the previous active pointer and database state when activation commit fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-package-'))
    const sourceV1 = join(directory, 'source-v1')
    const sourceV2 = join(directory, 'source-v2')
    await mkdir(sourceV1, { recursive: true })
    await mkdir(sourceV2, { recursive: true })
    await writeFile(join(sourceV1, 'SKILL.md'), '# V1\n', 'utf8')
    await writeFile(join(sourceV2, 'SKILL.md'), '# V2\n', 'utf8')
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const packageRoot = join(directory, 'packages')
    const runtime = new LocalPackageRuntime(packageRoot)
    const manager = new PackageManager({ store, runtime })
    const v1 = manifest('1.0.0', '# V1\n')
    await manager.install({
      workspaceId: workspace.id,
      manifest: v1,
      sourceDirectory: sourceV1,
      approvalToken: manager.preview(workspace.id, v1).approvalToken,
    })

    const failingStore: PackageStorePort = {
      getActivePackage: store.getActivePackage.bind(store),
      getPackageInstallTransaction: store.getPackageInstallTransaction.bind(store),
      beginPackageInstall: store.beginPackageInstall.bind(store),
      markPackageInstallStaged: store.markPackageInstallStaged.bind(store),
      completePackageInstall: () => {
        throw new Error('simulated database commit failure')
      },
      rollbackPackageInstall: store.rollbackPackageInstall.bind(store),
      compensateActivatedPackageInstall: store.compensateActivatedPackageInstall.bind(store),
    }
    const upgrade = new PackageManager({ store: failingStore, runtime })
    const v2 = manifest('2.0.0', '# V2\n', ['workspace:read', 'workspace:write'])
    await expect(
      upgrade.install({
        workspaceId: workspace.id,
        manifest: v2,
        sourceDirectory: sourceV2,
        approvalToken: upgrade.preview(workspace.id, v2).approvalToken,
      }),
    ).rejects.toBeInstanceOf(PackageInstallError)

    expect(store.getActivePackage(workspace.id, v1.id)?.version).toBe('1.0.0')
    expect(store.listPackageInstallTransactions(workspace.id)[0]).toMatchObject({
      version: '2.0.0',
      status: 'rolled-back',
    })
    const pointer = JSON.parse(
      await readFile(join(packageRoot, 'active', `${encodeURIComponent(v1.id)}.json`), 'utf8'),
    ) as { version: string }
    expect(pointer.version).toBe('1.0.0')
  })

  it('can replay compensation after a crash without re-breaking an already rolled-back package', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-package-compensate-'))
    const source = join(directory, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '# Reversible\n', 'utf8')
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: 'Crash recovery' })
    const manager = new PackageManager({
      store,
      runtime: new LocalPackageRuntime(join(directory, 'packages')),
    })
    const packageManifest = manifest('1.0.0', '# Reversible\n')
    const installation = await manager.installReversible({
      workspaceId: workspace.id,
      manifest: packageManifest,
      sourceDirectory: source,
      approvalToken: manager.preview(workspace.id, packageManifest).approvalToken,
    })

    await manager.compensate(installation, 'workshop-crash-recovery')
    await expect(manager.compensate(installation, 'workshop-crash-recovery')).resolves.toBeUndefined()

    expect(store.getActivePackage(workspace.id, packageManifest.id)).toBeUndefined()
    expect(store.getPackageInstallTransaction(installation.transactionId)).toMatchObject({
      status: 'rolled-back',
      errorCode: 'workshop-crash-recovery',
    })
  })

  it('rejects undeclared source inventory before staging a package', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-package-inventory-'))
    const source = join(directory, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '# Example\n', 'utf8')
    await writeFile(join(source, 'undeclared.txt'), 'not approved\n', 'utf8')
    const runtime = new LocalPackageRuntime(join(directory, 'packages'))
    await expect(runtime.stage(manifest('1.0.0', '# Example\n'), source))
      .rejects.toThrow('undeclared file')
  })
})
