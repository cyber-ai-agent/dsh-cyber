import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CyberPackageManifest, InstalledPackage } from '@dsh-cyber/contracts'

import { applyInstalledPromptTransforms, loadInstalledBlueprints } from '../src/installed-package-runtime.js'

describe('installed package entrypoints', () => {
  it('applies an installed command plugin to the runtime prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-entrypoint-'))
    const content = `${JSON.stringify({ schemaVersion: 1, commands: [{ trigger: '/meeting-summary', instruction: '输出决策、负责人和截止日期。' }] })}\n`
    await writeFile(join(root, 'commands.json'), content, 'utf8')
    const installed = packageRecord(root, {
      kind: 'plugin',
      files: [{ path: 'commands.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'commands', kind: 'prompt-transform', path: 'commands.json' }],
    })
    await expect(applyInstalledPromptTransforms([installed], '/meeting-summary 今天的发布会')).resolves.toContain('输出决策、负责人和截止日期。')
    await expect(applyInstalledPromptTransforms([installed], '普通消息')).resolves.toBe('普通消息')
  })

  it('loads installable talent blueprints from an active package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-talent-'))
    const blueprint = {
      id: 'archivist',
      version: 1,
      worldTemplateId: 'cyber-company',
      displayName: '档案管理员',
      role: '知识档案管理员',
      summary: '整理历史对话和知识。',
      persona: '引用来源并维护知识索引。',
      requestedSkills: ['knowledge-management'],
      requestedCapabilities: ['workspace:read'],
      createdAt: '2026-08-20T00:00:00.000Z',
    }
    const content = `${JSON.stringify(blueprint)}\n`
    await writeFile(join(root, 'blueprint.json'), content, 'utf8')
    const installed = packageRecord(root, {
      kind: 'employee-blueprint',
      files: [{ path: 'blueprint.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'archivist', kind: 'employee-blueprint', path: 'blueprint.json' }],
    })
    await expect(loadInstalledBlueprints([installed])).resolves.toEqual([blueprint])
  })
})

function packageRecord(root: string, overrides: Partial<CyberPackageManifest>): InstalledPackage {
  const manifest: CyberPackageManifest = {
    schemaVersion: 1,
    id: '@dsh-cyber/test-package',
    version: '1.0.0',
    kind: 'plugin',
    displayName: '测试包',
    summary: '测试已安装入口。',
    license: 'BUSL-1.1',
    publisher: 'DSH Cyber',
    capabilities: [],
    dataEgress: [],
    files: [],
    ...overrides,
  }
  return {
    workspaceId: 'workspace-1',
    packageId: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    status: 'active',
    installedPath: root,
    capabilities: manifest.capabilities,
    manifest,
    installedAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  }
}
