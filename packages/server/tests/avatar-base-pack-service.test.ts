import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { CyberPackageManifest, InstalledPackage } from '@dsh-cyber/contracts'
import {
  AVATAR_BASE_PACK_CAPABILITY,
  AVATAR_BASE_PACK_MANIFEST_PATH,
  assertAvatarBaseVrmEnvelope,
  parseInstalledAvatarBasePackManifest,
} from '../src/avatar-base-pack-manifest.js'
import { AvatarBasePackService } from '../src/services/avatar-base-pack-service.js'
import type { WorldPackageInstanceService } from '../src/services/world-package-instance-service.js'

describe('AvatarBasePackService', () => {
  it('serves only a verified active world pack and rewrites Base VRMs to world-scoped URLs', async () => {
    const fixture = await packFixture()
    const service = new AvatarBasePackService(fakeWorldPackages([fixture.installed]))

    await expect(service.list('world-1')).resolves.toEqual([expect.objectContaining({
      id: 'official-avatar-studio',
      version: '1.0.0',
      quality: 'production',
      bases: [expect.objectContaining({
        baseModel: 'female-a',
        assetUrl: '/api/worlds/world-1/avatar-base-packs/official-avatar-studio/1.0.0/assets/models/female.vrm',
      })],
    })])
    const asset = await service.readBaseAsset('world-1', 'official-avatar-studio', '1.0.0', 'models/female.vrm')
    expect(asset.contentType).toBe('model/gltf-binary')
    expect(asset.byteLength).toBe(fixture.vrm.byteLength)
    expect((await collect(asset.body)).equals(fixture.vrm)).toBe(true)
  })

  it('does not turn an arbitrary declared package file into a downloadable avatar asset', async () => {
    const fixture = await packFixture()
    const service = new AvatarBasePackService(fakeWorldPackages([fixture.installed]))
    await expect(service.readBaseAsset('world-1', 'official-avatar-studio', '1.0.0', AVATAR_BASE_PACK_MANIFEST_PATH))
      .rejects.toThrow('3D 角色基础模型不存在')
  })

  it('rejects a tampered Base VRM before it reaches the browser catalog', async () => {
    const fixture = await packFixture()
    await writeFile(join(fixture.root, 'models', 'female.vrm'), Buffer.from('tampered'))
    const service = new AvatarBasePackService(fakeWorldPackages([fixture.installed]))
    await expect(service.list('world-1')).rejects.toThrow(/hash mismatch/u)
  })

  it('requires capability, asset package kind and canonical manifest path', async () => {
    const fixture = await packFixture()
    const noCapability = structuredClone(fixture.installed)
    noCapability.capabilities = []
    noCapability.manifest.capabilities = []
    await expect(new AvatarBasePackService(fakeWorldPackages([noCapability])).list('world-1')).resolves.toEqual([])
  })
})

describe('Avatar Base Pack manifest', () => {
  it('rejects undeclared, traversing and non-VRM Base paths', async () => {
    const fixture = await packFixture()
    const base = fixture.manifestDocument
    expect(() => parseInstalledAvatarBasePackManifest({ ...base, bases: [{ baseModel: 'female-a', assetPath: '../female.vrm' }] }, fixture.installed)).toThrow(/safe|相对路径/u)
    expect(() => parseInstalledAvatarBasePackManifest({ ...base, bases: [{ baseModel: 'female-a', assetPath: 'models/missing.vrm' }] }, fixture.installed)).toThrow(/files/u)
    expect(() => parseInstalledAvatarBasePackManifest({ ...base, bases: [{ baseModel: 'female-a', assetPath: AVATAR_BASE_PACK_MANIFEST_PATH }] }, fixture.installed)).toThrow(/\.vrm/u)
  })

  it('requires a self-contained VRM 1.0 humanoid rather than a generic GLB', () => {
    const generic = glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 0 }] })
    expect(() => assertAvatarBaseVrmEnvelope(generic, 'generic.vrm')).toThrow(/VRM 1\.0/u)

    const external = glb(vrmDocument({ images: [{ uri: 'https://example.com/face.png' }] }))
    expect(() => assertAvatarBaseVrmEnvelope(external, 'external.vrm')).toThrow(/外链纹理/u)

    expect(() => assertAvatarBaseVrmEnvelope(glb(vrmDocument()), 'valid.vrm')).not.toThrow()
  })
})

async function packFixture(): Promise<{
  root: string
  vrm: Buffer
  installed: InstalledPackage
  manifestDocument: Record<string, unknown>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-pack-'))
  await mkdir(join(root, 'models'))
  const vrm = glb(vrmDocument())
  const manifestDocument = {
    schemaVersion: 1,
    id: 'official-avatar-studio',
    version: '1.0.0',
    displayName: 'Official Avatar Studio',
    license: 'CC0-1.0',
    publisher: 'DSH Cyber',
    quality: 'production',
    bases: [{ baseModel: 'female-a', assetPath: 'models/female.vrm' }],
    parts: [
      { id: 'long-layered', kind: 'hair', meshNames: ['Hair_Long'] },
      { id: 'professional', kind: 'outfit', meshNames: ['Outfit_Professional'] },
    ],
    materialSlots: [
      { id: 'skin', materialNames: ['Skin'] },
      { id: 'hair', materialNames: ['Hair'] },
      { id: 'outfit', materialNames: ['Outfit'] },
      { id: 'accent', materialNames: ['Accent'] },
    ],
  }
  const manifestBody = Buffer.from(`${JSON.stringify(manifestDocument)}\n`, 'utf8')
  await writeFile(join(root, AVATAR_BASE_PACK_MANIFEST_PATH), manifestBody)
  await writeFile(join(root, 'models', 'female.vrm'), vrm)
  const packageManifest: CyberPackageManifest = {
    schemaVersion: 1,
    id: 'official-avatar-studio',
    version: '1.0.0',
    kind: 'asset',
    displayName: 'Official Avatar Studio',
    summary: 'High quality shared avatar base pack.',
    license: 'CC0-1.0',
    publisher: 'DSH Cyber',
    capabilities: [AVATAR_BASE_PACK_CAPABILITY],
    dataEgress: [],
    files: [
      { path: AVATAR_BASE_PACK_MANIFEST_PATH, sha256: sha(manifestBody) },
      { path: 'models/female.vrm', sha256: sha(vrm) },
    ],
  }
  const installed: InstalledPackage = {
    workspaceId: 'workspace-1',
    packageId: packageManifest.id,
    version: packageManifest.version,
    kind: packageManifest.kind,
    status: 'active',
    installedPath: root,
    capabilities: packageManifest.capabilities,
    manifest: packageManifest,
    installedAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  }
  return { root, vrm, installed, manifestDocument }
}

function fakeWorldPackages(items: InstalledPackage[]): WorldPackageInstanceService {
  return { listRuntimePackages: async (_worldId: string) => items } as unknown as WorldPackageInstanceService
}

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
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
        meta: { name: 'Test Avatar', authors: ['test'] },
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
