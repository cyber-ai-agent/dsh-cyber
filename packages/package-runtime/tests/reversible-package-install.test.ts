import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { LocalPackageRuntime, PackageManager } from '../src/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function manifest(version: string, content: string): CyberPackageManifest {
  return {
    schemaVersion: 1,
    id: '@cyber/reversible-example',
    version,
    kind: 'skill',
    displayName: '可逆安装示例',
    summary: '验证组合事务的可补偿安装句柄。',
    license: 'PolyForm-Noncommercial-1.0.0',
    publisher: 'DSH Cyber',
    capabilities: ['workspace:read'],
    dataEgress: [],
    files: [{ path: 'SKILL.md', sha256: createHash('sha256').update(content).digest('hex') }],
  }
}

describe('reversible package installation', () => {
  it('rolls the runtime pointer and persistence state back together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-reversible-package-'))
    const sourceV1 = join(root, 'source-v1')
    const sourceV2 = join(root, 'source-v2')
    await mkdir(sourceV1, { recursive: true })
    await mkdir(sourceV2, { recursive: true })
    await writeFile(join(sourceV1, 'SKILL.md'), '# V1\n', 'utf8')
    await writeFile(join(sourceV2, 'SKILL.md'), '# V2\n', 'utf8')

    const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const packageRoot = join(root, 'packages')
    const manager = new PackageManager({
      store,
      runtime: new LocalPackageRuntime(packageRoot),
    })

    const v1 = manifest('1.0.0', '# V1\n')
    await manager.install({
      workspaceId: workspace.id,
      manifest: v1,
      sourceDirectory: sourceV1,
      approvalToken: manager.preview(workspace.id, v1).approvalToken,
    })

    const v2 = manifest('2.0.0', '# V2\n')
    const reversible = await manager.installReversible({
      workspaceId: workspace.id,
      manifest: v2,
      sourceDirectory: sourceV2,
      approvalToken: manager.preview(workspace.id, v2).approvalToken,
    })

    expect(reversible.installed.version).toBe('2.0.0')
    expect(store.getActivePackage(workspace.id, v2.id)?.version).toBe('2.0.0')

    await manager.compensate(reversible, 'parent-transaction-failed')

    expect(store.getActivePackage(workspace.id, v1.id)?.version).toBe('1.0.0')
    expect(store.getPackageInstallTransaction(reversible.transactionId)).toMatchObject({
      status: 'rolled-back',
      errorCode: 'parent-transaction-failed',
    })
    const pointer = JSON.parse(
      await readFile(join(packageRoot, 'active', `${encodeURIComponent(v1.id)}.json`), 'utf8'),
    ) as { version: string }
    expect(pointer.version).toBe('1.0.0')
  })
})
