import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { CyberPackageManifest } from '@dsh-cyber/contracts'

import { SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function manifest(version: string): CyberPackageManifest {
  return {
    schemaVersion: 1,
    id: '@cyber/compensation-example',
    version,
    kind: 'skill',
    displayName: '补偿事务示例',
    summary: '验证激活后的数据库补偿。',
    license: 'PolyForm-Noncommercial-1.0.0',
    publisher: 'DSH Cyber',
    capabilities: ['workspace:read'],
    dataEgress: [],
    files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64) }],
  }
}

describe('activated package compensation', () => {
  it('restores the previous active version and records a rolled-back transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-package-compensation-'))
    const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地工作区' })

    const v1 = manifest('1.0.0')
    const v1tx = store.beginPackageInstall({
      workspaceId: workspace.id,
      manifest: v1,
      approvedCapabilities: v1.capabilities,
    })
    store.markPackageInstallStaged(v1tx.id)
    store.completePackageInstall({
      transactionId: v1tx.id,
      manifest: v1,
      installedPath: join(root, 'packages', 'v1'),
    })

    const v2 = manifest('2.0.0')
    const v2tx = store.beginPackageInstall({
      workspaceId: workspace.id,
      manifest: v2,
      approvedCapabilities: v2.capabilities,
    })
    store.markPackageInstallStaged(v2tx.id)
    store.completePackageInstall({
      transactionId: v2tx.id,
      manifest: v2,
      installedPath: join(root, 'packages', 'v2'),
    })

    expect(store.getActivePackage(workspace.id, v2.id)?.version).toBe('2.0.0')

    const compensated = store.compensateActivatedPackageInstall({
      transactionId: v2tx.id,
      errorCode: 'bundle-build-failed',
    })

    expect(compensated).toMatchObject({
      status: 'rolled-back',
      previousVersion: '1.0.0',
      errorCode: 'bundle-build-failed',
    })
    expect(store.getActivePackage(workspace.id, v2.id)?.version).toBe('1.0.0')
    expect(store.listInstalledPackages(workspace.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: '1.0.0', status: 'active' }),
      expect.objectContaining({ version: '2.0.0', status: 'disabled' }),
    ]))
    expect(store.getPackageInstallTransaction(v2tx.id)?.status).toBe('rolled-back')
    expect(store.listDomainEvents(workspace.id).find((event) =>
      event.type === 'package.install.rolled-back'
      && event.correlationId === v2tx.id,
    )?.payload).toMatchObject({
      previousVersion: '1.0.0',
      compensatedAfterActivation: true,
    })
  })
})
