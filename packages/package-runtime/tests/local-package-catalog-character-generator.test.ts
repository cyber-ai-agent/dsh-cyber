import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalPackageCatalog } from '../src/local-package-catalog.js'
import { packageContentDigest } from '../src/package-manager.js'
import { prepareLocalPackage } from '../src/package-authoring.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LocalPackageCatalog Character Generator roots', () => {
  it('explains an edited package and restores it after one prepare command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-edit-'))
    roots.push(root)
    const generatedRoot = join(root, 'generated')
    const packageRoot = await writeTalentPackage(generatedRoot, { packageId: 'workshop.editable', withCertification: false })
    const catalog = new LocalPackageCatalog(root, { additionalRoots: [generatedRoot] })
    const item = (await catalog.list({ market: 'talent' }))[0]!
    const file = join(packageRoot, item.manifest.files[0]!.path)
    await writeFile(file, `${await readFile(file, 'utf8')}\n`)
    expect(await catalog.list({ market: 'talent' })).toHaveLength(0)
    expect(catalog.diagnostics({ market: 'talent' })[0]?.reason).toContain('文件已修改')
    expect(catalog.diagnostics({ market: 'theme' })).toEqual([])
    await prepareLocalPackage(packageRoot)
    expect(await catalog.list({ market: 'talent' })).toHaveLength(1)
    expect(catalog.diagnostics()).toEqual([])
  })

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

  it('shows a workspace-scoped package only to the workspace that owns it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-catalog-scoped-'))
    roots.push(root)
    const container = join(root, 'generated', 'workspaces')
    const alphaRoot = join(container, 'alpha', 'marketplace')
    const betaRoot = join(container, 'beta', 'marketplace')
    await writeTalentPackage(alphaRoot, { packageId: 'workshop.alpha-role', withCertification: false })
    await writeTalentPackage(betaRoot, { packageId: 'workshop.beta-role', withCertification: false })
    const catalog = new LocalPackageCatalog(root, {
      workspaceRoots: {
        container,
        resolve: (workspaceId) => [join(container, workspaceId, 'marketplace')],
      },
    })

    const alpha = await catalog.list({ market: 'talent', workspaceId: 'alpha' })
    expect(alpha.map((item) => item.manifest.id)).toEqual(['workshop.alpha-role'])
    const beta = await catalog.list({ market: 'talent', workspaceId: 'beta' })
    expect(beta.map((item) => item.manifest.id)).toEqual(['workshop.beta-role'])
    // A query with no workspace fails closed rather than showing everything.
    await expect(catalog.list({ market: 'talent' })).resolves.toEqual([])

    await expect(catalog.find('workshop.alpha-role', undefined, { workspaceId: 'beta' })).resolves.toBeUndefined()
    await expect(catalog.find('workshop.alpha-role', undefined, { workspaceId: 'alpha' })).resolves.toBeDefined()

    // Reading a declared file is scoped too, so holding an item from another
    // workspace is not enough to read its bytes.
    const alphaItem = alpha[0]!
    await expect(catalog.readDeclaredFile(alphaItem, 'blueprint.json', { workspaceId: 'alpha' })).resolves.toBeInstanceOf(Buffer)
    await expect(catalog.readDeclaredFile(alphaItem, 'blueprint.json', { workspaceId: 'beta' })).rejects.toThrow('escaped the catalog root')
  })

  it('refuses an install source directory owned by another workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-catalog-install-'))
    roots.push(root)
    const container = join(root, 'generated', 'workspaces')
    const alphaPackage = await writeTalentPackage(join(container, 'alpha', 'marketplace'), { packageId: 'workshop.alpha-role', withCertification: false })
    const catalog = new LocalPackageCatalog(root, {
      workspaceRoots: {
        container,
        resolve: (workspaceId) => [join(container, workspaceId, 'marketplace')],
      },
    })

    expect(() => catalog.assertInstallSource('alpha', alphaPackage)).not.toThrow()
    expect(() => catalog.assertInstallSource('beta', alphaPackage)).toThrow('another workspace')
    expect(() => catalog.assertInstallSource(undefined, alphaPackage)).toThrow('another workspace')
    // Traversal back out of the caller's own root is still someone else's data.
    expect(() => catalog.assertInstallSource('beta', join(container, 'beta', 'marketplace', '..', '..', 'alpha', 'marketplace', 'talent', 'workshop.alpha-role'))).toThrow('another workspace')
    // Directories outside the workspace container keep their existing behaviour.
    expect(() => catalog.assertInstallSource('beta', join(root, 'talent', 'anything'))).not.toThrow()
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
