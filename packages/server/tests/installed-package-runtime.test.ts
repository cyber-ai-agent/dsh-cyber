import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CyberPackageManifest, InstalledPackage } from '@dsh-cyber/contracts'
import { cyberCompanyTheme } from '@dsh-cyber/world-runtime'

import {
  applyInstalledPromptTransforms,
  InstalledPackageVerificationCache,
  loadInstalledBlueprints,
  loadInstalledPromptTransformCommands,
  loadInstalledWorldThemes,
  parsePromptTransformDefinition,
  readInstalledWorldThemeAsset,
} from '../src/installed-package-runtime.js'

describe('installed package entrypoints', () => {
  it('applies a canonical prompt-transform plugin to the runtime prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-entrypoint-'))
    const content = `${JSON.stringify({ schemaVersion: 1, transforms: [{ id: 'meeting-summary', trigger: '/meeting-summary', description: '整理会议事实。', instruction: '输出决策、负责人和截止日期。', mode: 'prepend', priority: 10 }] })}\n`
    await writeFile(join(root, 'commands.json'), content, 'utf8')
    const installed = packageRecord(root, {
      id: 'official-meeting-notes',
      kind: 'plugin',
      capabilities: ['prompt:transform'],
      files: [{ path: 'commands.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'commands', kind: 'prompt-transform', path: 'commands.json' }],
    })
    await expect(applyInstalledPromptTransforms([installed], '/meeting-summary 今天的发布会')).resolves.toBe('输出决策、负责人和截止日期。\n\n/meeting-summary 今天的发布会')
    await expect(applyInstalledPromptTransforms([installed], '/会议纪要 今天的发布会')).resolves.toBe('输出决策、负责人和截止日期。\n\n/会议纪要 今天的发布会')
    await expect(applyInstalledPromptTransforms([installed], '普通消息')).resolves.toBe('普通消息')
  })

  it('normalizes the legacy commands shape without executing package code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-legacy-plugin-'))
    const content = `${JSON.stringify({ schemaVersion: 1, commands: [{ trigger: '/meeting-summary', instruction: '输出纪要。' }] })}\n`
    await writeFile(join(root, 'commands.json'), content, 'utf8')
    const installed = packageRecord(root, {
      capabilities: ['prompt:transform'],
      files: [{ path: 'commands.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'commands', kind: 'prompt-transform', path: 'commands.json' }],
    })
    await expect(applyInstalledPromptTransforms([installed], '/meeting-summary 今天的发布会')).resolves.toBe('输出纪要。\n\n/meeting-summary 今天的发布会')
  })

  it('exposes only safe command metadata for the chat plugin picker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-plugin-commands-'))
    const content = `${JSON.stringify({ schemaVersion: 1, transforms: [{ id: 'research', trigger: '/research-brief', description: '整理研究简报。', instruction: '只在服务端使用。', mode: 'prepend', priority: 10 }] })}\n`
    await writeFile(join(root, 'commands.json'), content, 'utf8')
    const installed = packageRecord(root, {
      id: 'official-research-brief',
      displayName: 'Research Brief',
      summary: 'Research helper',
      capabilities: ['prompt:transform'],
      files: [{ path: 'commands.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'commands', kind: 'prompt-transform', path: 'commands.json' }],
    })
    await expect(loadInstalledPromptTransformCommands([installed])).resolves.toEqual([{
      packageId: 'official-research-brief',
      packageVersion: '1.0.0',
      displayName: 'Research Brief',
      summary: 'Research helper',
      trigger: '/research-brief',
      displayTrigger: '/研究简报',
      description: '整理研究简报。',
      automatic: false,
    }])
  })

  it('applies matching transforms by priority with deterministic mode semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-transform-order-'))
    const definition = {
      schemaVersion: 1,
      transforms: [
        { id: 'low-prepend', trigger: 'always', description: 'low', instruction: '低优先级前置', mode: 'prepend', priority: 10 },
        { id: 'high-prepend', trigger: 'always', description: 'high', instruction: '高优先级前置', mode: 'prepend', priority: 20 },
        { id: 'low-append', trigger: 'always', description: 'low', instruction: '低优先级后置', mode: 'append', priority: 10 },
        { id: 'high-append', trigger: 'always', description: 'high', instruction: '高优先级后置', mode: 'append', priority: 20 },
      ],
    }
    const content = `${JSON.stringify(definition)}\n`
    await writeFile(join(root, 'transforms.json'), content, 'utf8')
    const installed = packageRecord(root, {
      capabilities: ['prompt:transform'],
      files: [{ path: 'transforms.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'transforms', kind: 'prompt-transform', path: 'transforms.json' }],
    })
    const original = '普通消息'
    await expect(applyInstalledPromptTransforms([installed], original)).resolves.toBe(
      '高优先级前置\n\n低优先级前置\n\n普通消息\n\n高优先级后置\n\n低优先级后置',
    )
    expect(original).toBe('普通消息')
  })

  it('lets the highest-priority replacement define the base prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-transform-replace-'))
    const definition = {
      schemaVersion: 1,
      transforms: [
        { id: 'low-replace', trigger: 'always', description: 'low', instruction: '低优先级替换', mode: 'replace', priority: 10 },
        { id: 'high-replace', trigger: 'always', description: 'high', instruction: '高优先级替换', mode: 'replace', priority: 20 },
        { id: 'append', trigger: 'always', description: 'append', instruction: '追加约束', mode: 'append' },
      ],
    }
    const content = `${JSON.stringify(definition)}\n`
    await writeFile(join(root, 'transforms.json'), content, 'utf8')
    const installed = packageRecord(root, {
      capabilities: ['prompt:transform'],
      files: [{ path: 'transforms.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'transforms', kind: 'prompt-transform', path: 'transforms.json' }],
    })
    await expect(applyInstalledPromptTransforms([installed], '原始消息')).resolves.toBe('高优先级替换\n\n追加约束')
  })

  it('rejects invalid canonical definitions and inconsistent package boundaries', async () => {
    expect(() => parsePromptTransformDefinition({ schemaVersion: 1, transforms: [] })).toThrow(/at least one/)
    expect(() => parsePromptTransformDefinition({
      schemaVersion: 1,
      transforms: [{ id: 'bad', trigger: 'always', description: 'ok', instruction: 'ok', mode: 'prepend', priority: Number.POSITIVE_INFINITY }],
    })).toThrow(/finite safe integer/)
    expect(() => parsePromptTransformDefinition({
      schemaVersion: 1,
      transforms: [{ id: 'bad', trigger: 'always', description: 'ok', instruction: 'ok', mode: 'prepend', extra: true }],
    })).toThrow(/unexpected or missing fields/)
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-invalid-plugin-'))
    const content = `${JSON.stringify({ schemaVersion: 1, transforms: [] })}\n`
    await writeFile(join(root, 'transforms.json'), content, 'utf8')
    const installed = packageRecord(root, {
      files: [{ path: 'transforms.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'transforms', kind: 'prompt-transform', path: 'transforms.json' }],
    })
    await expect(applyInstalledPromptTransforms([installed], '普通消息')).rejects.toThrow(/prompt:transform capability/)
  })

  it('loads installable talent blueprints from an active package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-talent-'))
    const blueprint = {
      schemaVersion: 1,
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
      id: blueprint.id,
      kind: 'employee-blueprint',
      capabilities: ['employee:blueprint', 'workspace:read'],
      files: [{ path: 'blueprint.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'archivist', kind: 'employee-blueprint', path: 'blueprint.json' }],
    })
    await expect(loadInstalledBlueprints([installed])).resolves.toEqual([blueprint])
  })

  it('rejects undeclared traversal assets and tampered installed theme files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-theme-'))
    const unsafeTheme = structuredClone(cyberCompanyTheme)
    unsafeTheme.assets[0]!.src = '../outside.png'
    const content = `${JSON.stringify(unsafeTheme)}\n`
    await writeFile(join(root, 'theme.json'), content, 'utf8')
    const installed = packageRecord(root, {
      id: 'test-theme',
      kind: 'world-theme',
      capabilities: ['world:render'],
      files: [{ path: 'theme.json', sha256: createHash('sha256').update(content).digest('hex') }],
      entrypoints: [{ id: 'theme', kind: 'world-theme', path: 'theme.json' }],
    })
    await expect(loadInstalledWorldThemes([installed])).rejects.toThrow(/Invalid installed world theme|not a declared package file/)

    await writeFile(join(root, 'theme.json'), `${content}tampered`, 'utf8')
    await expect(loadInstalledWorldThemes([installed])).rejects.toThrow('hash mismatch')
  })

  it('verifies a package once and rehashes only the requested asset afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-theme-cache-'))
    const theme = structuredClone(cyberCompanyTheme)
    theme.assets[0]!.src = 'assets/scene.png'
    theme.assets[1]!.src = 'assets/roster.png'
    const themeContent = `${JSON.stringify(theme)}\n`
    const scene = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    const roster = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02])
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'theme.json'), themeContent, 'utf8')
    await writeFile(join(root, 'assets', 'scene.png'), scene)
    await writeFile(join(root, 'assets', 'roster.png'), roster)
    const installed = packageRecord(root, {
      id: 'cached-theme',
      kind: 'world-theme',
      capabilities: ['world:render'],
      files: [
        { path: 'theme.json', sha256: createHash('sha256').update(themeContent).digest('hex') },
        { path: 'assets/scene.png', sha256: createHash('sha256').update(scene).digest('hex') },
        { path: 'assets/roster.png', sha256: createHash('sha256').update(roster).digest('hex') },
      ],
      entrypoints: [{ id: 'theme', kind: 'world-theme', path: 'theme.json' }],
    })
    const cache = new InstalledPackageVerificationCache()
    await expect(loadInstalledWorldThemes([installed], cache)).resolves.toHaveLength(1)
    expect(cache.fullVerificationPasses).toBe(1)

    await writeFile(join(root, 'assets', 'roster.png'), 'tampered-unrequested', 'utf8')
    await expect(readInstalledWorldThemeAsset(installed, 'assets/scene.png', cache)).resolves.toMatchObject({ contentType: 'image/png' })
    expect(cache.fullVerificationPasses).toBe(1)
    await writeFile(join(root, 'assets', 'scene.png'), 'tampered-requested', 'utf8')
    await expect(readInstalledWorldThemeAsset(installed, 'assets/scene.png', cache)).rejects.toThrow('hash mismatch')
  })

  it('rejects symlinked theme assets before serving them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-theme-symlink-'))
    const theme = structuredClone(cyberCompanyTheme)
    theme.assets[0]!.src = 'assets/scene.png'
    theme.assets[1]!.src = 'assets/roster.png'
    const themeContent = `${JSON.stringify(theme)}\n`
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'theme.json'), themeContent, 'utf8')
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'scene.png'), png)
    await symlink(join(root, 'outside'), join(root, 'assets', 'scene.png'), 'junction')
    await writeFile(join(root, 'assets', 'roster.png'), png)
    const installed = packageRecord(root, {
      id: 'symlink-theme',
      kind: 'world-theme',
      capabilities: ['world:render'],
      files: [
        { path: 'theme.json', sha256: createHash('sha256').update(themeContent).digest('hex') },
        { path: 'assets/scene.png', sha256: createHash('sha256').update(png).digest('hex') },
        { path: 'assets/roster.png', sha256: createHash('sha256').update(png).digest('hex') },
      ],
      entrypoints: [{ id: 'theme', kind: 'world-theme', path: 'theme.json' }],
    })
    await expect(loadInstalledWorldThemes([installed])).rejects.toThrow('Symbolic links are not allowed')
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
