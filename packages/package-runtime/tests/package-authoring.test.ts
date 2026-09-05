import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import { describe, expect, it } from 'vitest'
import { LocalPackageRuntime, PackageVersionContentConflictError, prepareLocalPackage, packageContentDigest } from '../src/index.js'

describe('local package authoring', () => {
  it('refreshes edited/new files and certification, excludes developer files, and stages only payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-authoring-'))
    const source = join(root, 'source')
    await mkdir(join(source, '.git'), { recursive: true })
    await mkdir(join(source, 'node_modules'), { recursive: true })
    const manifest = { schemaVersion: 1, id: '@community/example', version: '1.0.0', kind: 'skill', displayName: '示例', summary: '本地开发', license: 'MIT', publisher: 'Community', capabilities: [], dataEgress: [],
      files: [{ path: 'SKILL.md', sha256: '0'.repeat(64) }], certification: { authority: 'Community', level: 'community', contentSha256: '0'.repeat(64) } }
    const path = join(source, 'dsh-cyber.package.json')
    await writeFile(path, JSON.stringify(manifest))
    await writeFile(join(source, 'SKILL.md'), '# edited skill')
    await writeFile(join(source, 'example.txt'), 'new payload')
    await writeFile(join(source, '.env'), 'LOCAL_DEVELOPMENT_ONLY=yes')
    await writeFile(join(source, '.git', 'config'), 'local repository')
    await writeFile(join(source, 'node_modules', 'local.js'), 'local tooling')
    try {
      const checked = await prepareLocalPackage(source, { check: true })
      expect(checked.changed).toBe(true)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(manifest)
      expect((await prepareLocalPackage(source)).files).toBe(2)
      const prepared = JSON.parse(await readFile(path, 'utf8'))
      expect(prepared.files.map((file: { path: string }) => file.path)).toEqual(['SKILL.md', 'example.txt'])
      expect(prepared.certification.contentSha256).toBe(packageContentDigest(prepared))
      expect(prepared.capabilities).toEqual([])
      expect((await prepareLocalPackage(source)).changed).toBe(false)
      const runtime = new LocalPackageRuntime(join(root, 'runtime'))
      const staged = await runtime.stage(prepared, source)
      expect((await readdir(staged.path)).sort()).toEqual(['SKILL.md', 'dsh-cyber.package.json', 'example.txt'].sort())
      expect(await readFile(join(source, '.env'), 'utf8')).toBe('LOCAL_DEVELOPMENT_ONLY=yes')
      await runtime.discard(staged)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

/**
 * A local development revision.
 *
 * The immutable-version rule stands: an installed version whose content changed
 * is still refused. `--dev` only gives the contributor an explicit, marked
 * revision to iterate on, so the released version's installation record is
 * never rewritten.
 */
describe('local package dev revisions', () => {
  it('bumps a marked dev revision instead of overwriting the installed release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-dev-revision-'))
    try {
      const source = join(root, 'source')
      await writeSkillPackage(source, '# first draft\n')
      const runtime = new LocalPackageRuntime(join(root, 'runtime'))
      const installedRoot = join(root, 'runtime', 'installed', encodeURIComponent('@community/example'))

      await prepareLocalPackage(source)
      await runtime.activate(await runtime.stage(await readManifest(source), source))
      expect(await readdir(installedRoot)).toEqual(['1.0.0'])

      // Editing the package without touching the version is still refused.
      await writeFile(join(source, 'SKILL.md'), '# second draft\n', 'utf8')
      await prepareLocalPackage(source)
      await expect(runtime.activate(await runtime.stage(await readManifest(source), source)))
        .rejects.toBeInstanceOf(PackageVersionContentConflictError)

      const bumped = await prepareLocalPackage(source, { devRevision: true })
      expect(bumped.version).toBe('1.0.0-dev.1')
      expect(bumped.changed).toBe(true)
      await runtime.activate(await runtime.stage(await readManifest(source), source))
      expect((await readdir(installedRoot)).sort()).toEqual(['1.0.0', '1.0.0-dev.1'])
      // The released install keeps the bytes its user approved.
      expect(await readFile(join(installedRoot, '1.0.0', 'SKILL.md'), 'utf8')).toBe('# first draft\n')
      expect(await readFile(join(installedRoot, '1.0.0-dev.1', 'SKILL.md'), 'utf8')).toBe('# second draft\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('bumps once per change and stays put when nothing changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-dev-revision-idempotent-'))
    try {
      const source = join(root, 'source')
      await writeSkillPackage(source, '# first draft\n')

      expect((await prepareLocalPackage(source, { devRevision: true })).version).toBe('1.0.0-dev.1')
      const unchanged = await prepareLocalPackage(source, { devRevision: true })
      expect(unchanged.version).toBe('1.0.0-dev.1')
      expect(unchanged.changed).toBe(false)

      await writeFile(join(source, 'SKILL.md'), '# second draft\n', 'utf8')
      expect((await prepareLocalPackage(source, { devRevision: true })).version).toBe('1.0.0-dev.2')
      expect((await readManifest(source)).version).toBe('1.0.0-dev.2')
      // A plain run never invents a revision on the contributor's behalf.
      await writeFile(join(source, 'SKILL.md'), '# third draft\n', 'utf8')
      expect((await prepareLocalPackage(source)).version).toBe('1.0.0-dev.2')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

async function readManifest(source: string): Promise<CyberPackageManifest> {
  return JSON.parse(await readFile(join(source, 'dsh-cyber.package.json'), 'utf8')) as CyberPackageManifest
}

async function writeSkillPackage(source: string, body: string): Promise<void> {
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), body, 'utf8')
  await writeFile(join(source, 'dsh-cyber.package.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: '@community/example',
    version: '1.0.0',
    kind: 'skill',
    displayName: '示例',
    summary: '本地开发',
    license: 'MIT',
    publisher: 'Community',
    capabilities: [],
    dataEgress: [],
    files: [{ path: 'SKILL.md', sha256: createHash('sha256').update(body).digest('hex') }],
  }, null, 2)}\n`, 'utf8')
}
