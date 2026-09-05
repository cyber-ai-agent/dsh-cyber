import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CyberPackageManifest, InstalledPackage } from '@dsh-cyber/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { LocalPackageCatalog } from '../src/local-package-catalog.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * One cause per diagnostic.
 *
 * Every branch below used to collapse into the same "文件清单或内容摘要需要更新"
 * line, which told a contributor nothing about which file to look at. Each test
 * pins one cause and the fix hint that names the prepare command.
 */
describe('LocalPackageCatalog validation diagnostics', () => {
  it('names a declared file that is missing from the directory', async () => {
    const { catalog, packageRoot } = await buildCatalog()
    await rm(join(packageRoot, 'SKILL.md'))

    await expect(catalog.list({ market: 'plugin' })).resolves.toEqual([])
    const reason = onlyReason(catalog)
    expect(reason).toContain('缺少已声明的文件：SKILL.md')
    expect(reason).toContain('pnpm package:prepare')
  })

  it('names an undeclared file that was added to the directory', async () => {
    const { catalog, packageRoot } = await buildCatalog()
    await writeFile(join(packageRoot, 'NOTES.md'), '# scratch\n', 'utf8')

    await expect(catalog.list({ market: 'plugin' })).resolves.toEqual([])
    const reason = onlyReason(catalog)
    expect(reason).toContain('未声明的文件：NOTES.md')
    expect(reason).toContain('pnpm package:prepare')
  })

  it('names the file whose content no longer matches its recorded hash', async () => {
    const { catalog, packageRoot } = await buildCatalog()
    await writeFile(join(packageRoot, 'SKILL.md'), '# edited skill\n', 'utf8')

    await expect(catalog.list({ market: 'plugin' })).resolves.toEqual([])
    const reason = onlyReason(catalog)
    expect(reason).toContain('清单哈希待更新：SKILL.md')
    expect(reason).toContain('pnpm package:prepare')
  })

  it('separates a stale content summary from a stale file hash', async () => {
    const { catalog } = await buildCatalog((manifest) => ({
      ...manifest,
      certification: { authority: 'Community', level: 'community', contentSha256: 'a'.repeat(64) },
    }))

    await expect(catalog.list({ market: 'plugin' })).resolves.toEqual([])
    const reason = onlyReason(catalog)
    expect(reason).toContain('内容摘要与清单不一致')
    expect(reason).toContain('pnpm package:prepare')
  })

  it('reports which manifest field the schema rejected', async () => {
    const { catalog } = await buildCatalog((manifest) => ({ ...manifest, version: '1.0' }))

    await expect(catalog.list({ market: 'plugin' })).resolves.toEqual([])
    const reason = onlyReason(catalog)
    expect(reason).toContain('清单字段无效')
    expect(reason).toContain('version')
    expect(reason).toContain('pnpm package:prepare')
  })

  it('explains that a declared hidden or development path is never packaged', async () => {
    const hidden = await buildCatalog((manifest) => ({
      ...manifest,
      files: [...manifest.files, { path: '.env', sha256: 'b'.repeat(64) }],
    }))
    await expect(hidden.catalog.list({ market: 'plugin' })).resolves.toEqual([])
    expect(onlyReason(hidden.catalog)).toContain('.env')
    expect(onlyReason(hidden.catalog)).toContain('不会打包')

    const tooling = await buildCatalog((manifest) => ({
      ...manifest,
      files: [...manifest.files, { path: 'node_modules/tool.js', sha256: 'b'.repeat(64) }],
    }))
    await mkdir(join(tooling.packageRoot, 'node_modules'), { recursive: true })
    await writeFile(join(tooling.packageRoot, 'node_modules', 'tool.js'), 'export {}\n', 'utf8')
    await expect(tooling.catalog.list({ market: 'plugin' })).resolves.toEqual([])
    const reason = onlyReason(tooling.catalog)
    expect(reason).toContain('node_modules/tool.js')
    expect(reason).toContain('不会打包')
    expect(reason).toContain('pnpm package:prepare')
  })

  it('warns that an installed version with different content cannot be overwritten', async () => {
    const { catalog, manifest } = await buildCatalog()
    const installed = installedRecord({ ...manifest, files: [{ path: 'SKILL.md', sha256: 'c'.repeat(64) }] })

    // The directory itself is valid, so it stays listed; the diagnostic explains
    // why installing it over the immutable installed version would be refused.
    await expect(catalog.list({ market: 'plugin', installed })).resolves.toHaveLength(1)
    const reason = onlyReason(catalog)
    expect(reason).toContain('已安装的 1.0.0 内容与本地不同')
    expect(reason).toContain('pnpm package:prepare')
    expect(reason).toContain('--dev')

    // Reinstalling the same bytes is allowed, so the warning has to disappear.
    await expect(catalog.list({ market: 'plugin', installed: installedRecord(manifest) })).resolves.toHaveLength(1)
    expect(catalog.diagnostics()).toEqual([])
  })

  it('refuses a symbolic link with its own diagnostic', async () => {
    const { catalog, packageRoot } = await buildCatalog()
    // Link a declared file, so the symbolic link is the only thing left to fault.
    await symlink(join(packageRoot, 'SKILL.md'), join(packageRoot, 'link.md'))

    await expect(catalog.list({ market: 'plugin' })).resolves.toEqual([])
    expect(onlyReason(catalog)).toContain('符号链接')
  })

  it('drops the cached diagnostic once the package directory is deleted', async () => {
    const { catalog, packageRoot } = await buildCatalog()
    await writeFile(join(packageRoot, 'SKILL.md'), '# edited skill\n', 'utf8')
    await expect(catalog.list({ market: 'plugin' })).resolves.toEqual([])
    expect(catalog.diagnostics()).toHaveLength(1)

    await rm(packageRoot, { recursive: true, force: true })

    await expect(catalog.list({ market: 'plugin' })).resolves.toEqual([])
    expect(catalog.diagnostics()).toEqual([])
    expect(catalog.diagnostics({ market: 'plugin' })).toEqual([])
  })
})

function onlyReason(catalog: LocalPackageCatalog): string {
  const diagnostics = catalog.diagnostics()
  expect(diagnostics).toHaveLength(1)
  return diagnostics[0]!.reason
}

function installedRecord(manifest: CyberPackageManifest): InstalledPackage[] {
  return [{
    workspaceId: 'workspace-1',
    packageId: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    status: 'active',
    installedPath: `/installed/${manifest.id}/${manifest.version}`,
    capabilities: [...manifest.capabilities],
    manifest,
    installedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }]
}

async function buildCatalog(
  edit: (manifest: CyberPackageManifest) => CyberPackageManifest = (manifest) => manifest,
): Promise<{ catalog: LocalPackageCatalog; packageRoot: string; manifest: CyberPackageManifest }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-package-diagnostics-'))
  roots.push(root)
  const packageRoot = join(root, 'plugins', 'community.example')
  await mkdir(packageRoot, { recursive: true })
  const body = '# example skill\n'
  await writeFile(join(packageRoot, 'SKILL.md'), body, 'utf8')
  const manifest = edit({
    schemaVersion: 1,
    id: 'community.example',
    version: '1.0.0',
    kind: 'skill',
    displayName: '示例技能',
    summary: '贡献者本地开发用的最小包',
    license: 'MIT',
    publisher: 'Community',
    capabilities: [],
    dataEgress: [],
    files: [{ path: 'SKILL.md', sha256: createHash('sha256').update(body).digest('hex') }],
  } as CyberPackageManifest)
  await writeFile(join(packageRoot, 'dsh-cyber.package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { catalog: new LocalPackageCatalog(root), packageRoot, manifest }
}
