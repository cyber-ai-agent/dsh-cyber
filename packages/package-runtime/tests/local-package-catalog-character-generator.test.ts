import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalPackageCatalog } from '../src/local-package-catalog.js'
import { packageContentDigest } from '../src/package-manager.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LocalPackageCatalog Character Generator roots', () => {
  it('discovers generated talent packages as unverified local packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-catalog-'))
    roots.push(root)
    const generatedRoot = join(root, 'generated-marketplace')
    const packageRoot = await writeTalentPackage(generatedRoot, { packageId: 'workshop.ai-engineer', withCertification: false })
    const catalog = new LocalPackageCatalog(root, { additionalRoots: [generatedRoot] })

    const items = await catalog.list({ market: 'talent' })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      market: 'talent',
      verified: false,
      manifest: { id: 'workshop.ai-engineer', kind: 'employee-blueprint' },
      sourceDirectory: packageRoot,
    })
  })

  it('keeps certification from turning a generated local package into trusted provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-catalog-certified-'))
    roots.push(root)
    const generatedRoot = join(root, 'generated-marketplace')
    await mkdir(join(root, 'talent'), { recursive: true })
    await writeTalentPackage(generatedRoot, { packageId: 'workshop.certified-looking', withCertification: true })
    const catalog = new LocalPackageCatalog(root, { additionalRoots: [generatedRoot], trustedAuthorities: ['DSH Cyber'] })

    const item = (await catalog.list({ market: 'talent' }))[0]
    expect(item?.verified).toBe(false)
    expect(item?.manifest.publisher).toBe('Local Character Generator')
  })

  it('omits a package after declared content is tampered and rejects reads outside the package root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-catalog-integrity-'))
    roots.push(root)
    const packageRoot = await writeTalentPackage(root, { packageId: 'workshop.tamper-proof', withCertification: false })
    const catalog = new LocalPackageCatalog(root)
    const item = (await catalog.list({ market: 'talent' }))[0]
    expect(item).toBeDefined()
    await writeFile(join(packageRoot, 'blueprint.json'), '{"tampered":true}\n', 'utf8')

    await expect(catalog.list({ market: 'talent' })).resolves.toEqual([])
    await expect(catalog.readDeclaredFile(item!, '../outside.txt')).rejects.toThrow()
    await expect(catalog.readDeclaredFile(item!, 'blueprint.json')).rejects.toThrow('hash mismatch')
  })
})

async function writeTalentPackage(root: string, options: { packageId: string; withCertification: boolean }): Promise<string> {
  const packageRoot = join(root, 'talent', options.packageId)
  await mkdir(packageRoot, { recursive: true })
  const blueprint = `${JSON.stringify({
    schemaVersion: 1,
    id: options.packageId,
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: 'AI 工程师',
    role: '机器学习工程师',
    summary: '测试角色',
    persona: '只依据当前世界事实工作。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-09-01T00:00:00.000Z',
  }, null, 2)}\n`
  await writeFile(join(packageRoot, 'blueprint.json'), blueprint, 'utf8')
  const digest = createHash('sha256').update(blueprint).digest('hex')
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id: options.packageId,
    version: '0.1.0',
    kind: 'employee-blueprint',
    displayName: 'AI 工程师',
    summary: '本地 Character Generator fixture',
    license: 'MIT',
    publisher: 'Local Character Generator',
    capabilities: ['employee:blueprint'],
    dataEgress: [],
    files: [{ path: 'blueprint.json', sha256: digest }],
    entrypoints: [{ id: 'role-blueprint', kind: 'employee-blueprint', path: 'blueprint.json' }],
  }
  if (options.withCertification) {
    const unsignedCertification = {
      authority: 'DSH Cyber',
      level: 'official',
    }
    manifest.certification = { ...unsignedCertification, contentSha256: packageContentDigest({ ...manifest, certification: { ...unsignedCertification, contentSha256: '0'.repeat(64) } } as any) }
  }
  await writeFile(join(packageRoot, 'dsh-cyber.package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await expect(readFile(join(packageRoot, 'blueprint.json'), 'utf8')).resolves.toContain('AI 工程师')
  return packageRoot
}
