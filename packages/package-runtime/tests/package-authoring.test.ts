import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalPackageRuntime, prepareLocalPackage, packageContentDigest } from '../src/index.js'

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
