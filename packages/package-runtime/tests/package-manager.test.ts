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
    const content = `${JSON.stringify({ schemaVersion: 1, commands: [{ trigger: '/meeting-summary', instruction: '输出会议纪要。' }] }, null, 2)}\n`
    await writeFile(join(source, 'commands.json'), content, 'utf8')
    const packageManifest: CyberPackageManifest = {
      schemaVersion: 1,
      id: '@dsh-cyber/meeting-notes',
      version: '1.0.0',
      kind: 'plugin',
      displayName: '会议纪要插件',
      summary: '把斜杠命令转换为可执行的会议纪要提示。',
      license: 'BUSL-1.1',
      publisher: 'DSH Cyber',
      capabilities: ['conversation:transform'],
      dataEgress: [],
      files: [{ path: 'commands.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'commands', kind: 'prompt-transform', path: 'commands.json' }],
    }
    packageManifest.certification = {
      authority: 'DSH Cyber',
      level: 'official',
      contentSha256: packageContentDigest(packageManifest),
    }
    await writeFile(join(source, 'dsh-cyber.package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8')

    const catalog = new LocalPackageCatalog(directory)
    const results = await catalog.list({ market: 'plugin', query: '会议' })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ market: 'plugin', verified: true })
    expect(results[0]?.manifest.entrypoints?.[0]?.kind).toBe('prompt-transform')

    await writeFile(join(source, 'commands.json'), '{"tampered":true}\n', 'utf8')
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
  })

  it('restores the previous active pointer and database state when activation commit fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-package-'))
    const sourceV1 = join(directory, 'source-v1')
    const sourceV2 = join(directory, 'source-v2')
    const { mkdir } = await import('node:fs/promises')
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
      beginPackageInstall: store.beginPackageInstall.bind(store),
      markPackageInstallStaged: store.markPackageInstallStaged.bind(store),
      completePackageInstall: () => {
        throw new Error('simulated database commit failure')
      },
      rollbackPackageInstall: store.rollbackPackageInstall.bind(store),
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
})
