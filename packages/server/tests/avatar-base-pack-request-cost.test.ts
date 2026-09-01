import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CyberPackageManifest, InstalledPackage } from '@dsh-cyber/contracts'

/**
 * Counting the real filesystem is the only deterministic way to prove this
 * regression stays fixed: wall clock is flaky in CI, and the cost lives deep
 * inside the catalog scan rather than at an injectable service seam.
 */
const reads: string[] = []
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    default: actual,
    readFile: (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string') reads.push(path)
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest)
    },
  }
})

const { LocalPackageCatalog, packageContentDigest } = await import('@dsh-cyber/package-runtime')
const { AVATAR_BASE_PACK_CAPABILITY, AVATAR_BASE_PACK_MANIFEST_PATH } = await import('../src/avatar-base-pack-manifest.js')
const { AvatarBasePackService } = await import('../src/services/avatar-base-pack-service.js')
type WorldPackageInstanceService = import('../src/services/world-package-instance-service.js').WorldPackageInstanceService

const PACKAGE_ID = 'official-avatar-base-fixture'
const BASE_PATH = 'models/neutral.vrm'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-avatar-cost-'))
  reads.length = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('avatar base pack request cost', () => {
  it('re-reads no marketplace bytes once the catalog scan and the pack are warm', async () => {
    const vrm = await writeMarketplace(root, glb(vrmDocument()))
    const service = buildService(root)

    await service.list('world-1')
    const warm = reads.length
    expect(reads.filter((path) => path.replaceAll('\\', '/').endsWith(BASE_PATH)).length).toBeGreaterThan(0)

    // Two more consecutive requests against the same unchanged marketplace.
    await service.list('world-1')
    const first = await service.readBaseAsset('world-1', PACKAGE_ID, '1.0.0', BASE_PATH)
    const second = await service.readBaseAsset('world-1', PACKAGE_ID, '1.0.0', BASE_PATH)

    // Before the fix these three requests re-read and re-hashed the whole
    // marketplace, including the Base VRM, eight further times.
    expect(reads.slice(warm)).toEqual([])

    expect(first.byteLength).toBe(vrm.byteLength)
    expect((await collect(first.body)).equals(vrm)).toBe(true)
    expect((await collect(second.body)).equals(vrm)).toBe(true)
  })

  it('serves replaced marketplace content instead of the memoized copy', async () => {
    await writeMarketplace(root, glb(vrmDocument()))
    const service = buildService(root)
    const initial = await service.readBaseAsset('world-1', PACKAGE_ID, '1.0.0', BASE_PATH)
    await collect(initial.body)

    const replaced = await writeMarketplace(root, glb(vrmDocument({ scenes: [{ nodes: [0] }] })))
    const asset = await service.readBaseAsset('world-1', PACKAGE_ID, '1.0.0', BASE_PATH)

    expect(asset.byteLength).toBe(replaced.byteLength)
    expect((await collect(asset.body)).equals(replaced)).toBe(true)
  })

  it('drops a pack whose Base VRM was tampered with after it was cached', async () => {
    await writeMarketplace(root, glb(vrmDocument()))
    const service = buildService(root)
    await expect(service.list('world-1')).resolves.toHaveLength(1)

    await writeFile(join(root, 'plugins', PACKAGE_ID, BASE_PATH), Buffer.from('tampered payload'))

    await expect(service.list('world-1')).resolves.toEqual([])
    await expect(service.readBaseAsset('world-1', PACKAGE_ID, '1.0.0', BASE_PATH))
      .rejects.toThrow(/3D 角色基础包不存在或未启用/u)
  })

  it('drops a pack once an undeclared file is dropped into its directory', async () => {
    await writeMarketplace(root, glb(vrmDocument()))
    const service = buildService(root)
    await expect(service.list('world-1')).resolves.toHaveLength(1)

    await writeFile(join(root, 'plugins', PACKAGE_ID, 'models', 'extra.bin'), Buffer.from('undeclared'))

    await expect(service.list('world-1')).resolves.toEqual([])
  })
})

function buildService(marketplaceRoot: string): InstanceType<typeof AvatarBasePackService> {
  return new AvatarBasePackService(
    { listRuntimePackages: async (): Promise<InstalledPackage[]> => [] } as unknown as WorldPackageInstanceService,
    { catalog: new LocalPackageCatalog(marketplaceRoot), builtInPackageIds: [PACKAGE_ID] },
  )
}

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Write (or rewrite) the fixture marketplace and return the Base VRM bytes. */
async function writeMarketplace(marketplaceRoot: string, vrm: Buffer): Promise<Buffer> {
  const packageRoot = join(marketplaceRoot, 'plugins', PACKAGE_ID)
  await mkdir(join(packageRoot, 'models'), { recursive: true })
  const packManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    id: PACKAGE_ID,
    version: '1.0.0',
    displayName: 'Avatar Base Fixture',
    license: 'CC0-1.0',
    publisher: 'DSH Cyber',
    quality: 'production',
    bases: [{ baseModel: 'neutral-a', assetPath: BASE_PATH }],
    parts: [{ id: 'professional', kind: 'outfit', meshNames: ['Outfit_Professional'] }],
    materialSlots: [
      { id: 'skin', materialNames: ['Skin'] },
      { id: 'hair', materialNames: ['Hair'] },
      { id: 'outfit', materialNames: ['Outfit'] },
      { id: 'accent', materialNames: ['Accent'] },
    ],
  })}\n`, 'utf8')
  await writeFile(join(packageRoot, AVATAR_BASE_PACK_MANIFEST_PATH), packManifest)
  await writeFile(join(packageRoot, BASE_PATH), vrm)

  const unsigned: CyberPackageManifest = {
    schemaVersion: 1,
    id: PACKAGE_ID,
    version: '1.0.0',
    kind: 'asset',
    displayName: 'Avatar Base Fixture',
    summary: 'Shared avatar base pack fixture.',
    license: 'CC0-1.0',
    publisher: 'DSH Cyber',
    capabilities: [AVATAR_BASE_PACK_CAPABILITY],
    dataEgress: [],
    files: [
      { path: AVATAR_BASE_PACK_MANIFEST_PATH, sha256: sha(packManifest) },
      { path: BASE_PATH, sha256: sha(vrm) },
    ],
    certification: { authority: 'DSH Cyber', level: 'official', contentSha256: '' },
  }
  const manifest: CyberPackageManifest = {
    ...unsigned,
    certification: { authority: 'DSH Cyber', level: 'official', contentSha256: packageContentDigest(unsigned) },
  }
  await writeFile(join(packageRoot, 'dsh-cyber.package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  return vrm
}

function sha(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function vrmDocument(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const humanBones = Object.fromEntries([
    'hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg',
  ].map((name, index) => [name, { node: index }]))
  return {
    asset: { version: '2.0' },
    nodes: Array.from({ length: 7 }, (_item, index) => ({ name: `bone-${index}` })),
    buffers: [{ byteLength: 0 }],
    extensionsUsed: ['VRMC_vrm'],
    extensions: {
      VRMC_vrm: {
        specVersion: '1.0',
        meta: { name: 'Cost Fixture', authors: ['test'] },
        humanoid: { humanBones },
        expressions: { preset: {}, custom: {} },
      },
    },
    ...extra,
  }
}

function glb(document: Record<string, unknown>): Buffer {
  const raw = Buffer.from(JSON.stringify(document), 'utf8')
  const jsonLength = Math.ceil(raw.length / 4) * 4
  const totalLength = 12 + 8 + jsonLength
  const output = Buffer.alloc(totalLength, 0x20)
  output.writeUInt32LE(0x46546c67, 0)
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(totalLength, 8)
  output.writeUInt32LE(jsonLength, 12)
  output.writeUInt32LE(0x4e4f534a, 16)
  raw.copy(output, 20)
  return output
}
