import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'

import { validateAvatarBasePackSource } from '../src/services/avatar-base-pack-source-validator.js'

describe('avatar base pack source validation', () => {
  it('accepts a hash-matched self-contained VRM 1.0 package source', async () => {
    const fixture = await packageFixture()
    await expect(validateAvatarBasePackSource(fixture.manifest, fixture.root)).resolves.toBeUndefined()
  })

  it('rejects source bytes that changed after the package inventory was declared', async () => {
    const fixture = await packageFixture()
    await writeFile(join(fixture.root, 'base.vrm'), Buffer.from('tampered'))
    await expect(validateAvatarBasePackSource(fixture.manifest, fixture.root)).rejects.toThrow('哈希不匹配')
  })

  it('rejects an ordinary GLB that does not contain VRM 1.0 humanoid metadata', async () => {
    const fixture = await packageFixture({ vrm: glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 0 }] }) })
    await expect(validateAvatarBasePackSource(fixture.manifest, fixture.root)).rejects.toThrow('VRM 1.0')
  })

  it('requires the canonical avatar-base-pack.json declaration', async () => {
    const fixture = await packageFixture()
    fixture.manifest.files = fixture.manifest.files.filter((file) => file.path !== 'avatar-base-pack.json')
    await expect(validateAvatarBasePackSource(fixture.manifest, fixture.root)).rejects.toThrow('avatar-base-pack.json')
  })

  it('rejects a Base VRM reached through a symlinked parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-pack-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-avatar-pack-outside-'))
    const vrm = glb(vrmDocument())
    await writeFile(join(outside, 'base.vrm'), vrm)
    await mkdir(join(root, 'assets'))
    await symlink(outside, join(root, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const pack = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      id: 'test-avatar-symlink',
      version: '1.0.0',
      displayName: 'Test Avatar Symlink',
      license: 'CC0-1.0',
      publisher: 'test',
      quality: 'production',
      bases: [{ baseModel: 'neutral-a', assetPath: 'assets/linked/base.vrm' }],
      parts: [],
      materialSlots: [],
    })}\n`, 'utf8')
    await writeFile(join(root, 'avatar-base-pack.json'), pack)
    const manifest: CyberPackageManifest = {
      schemaVersion: 1,
      id: 'test-avatar-symlink',
      version: '1.0.0',
      kind: 'asset',
      displayName: 'Test Avatar Symlink',
      summary: 'Reject parent symlink',
      license: 'CC0-1.0',
      publisher: 'test',
      capabilities: ['avatar:base-pack'],
      dataEgress: [],
      files: [
        { path: 'avatar-base-pack.json', sha256: sha(pack) },
        { path: 'assets/linked/base.vrm', sha256: sha(vrm) },
      ],
    }
    await expect(validateAvatarBasePackSource(manifest, root)).rejects.toThrow('符号链接')
  })

  it('is a no-op for unrelated asset packages', async () => {
    const manifest: CyberPackageManifest = {
      schemaVersion: 1,
      id: 'ordinary-asset',
      version: '1.0.0',
      kind: 'asset',
      displayName: 'Ordinary asset',
      summary: 'Not an avatar pack',
      license: 'CC0-1.0',
      publisher: 'test',
      capabilities: ['asset:read'],
      dataEgress: [],
      files: [{ path: 'missing.bin', sha256: '0'.repeat(64) }],
    }
    await expect(validateAvatarBasePackSource(manifest, '/definitely/missing')).resolves.toBeUndefined()
  })
})

async function packageFixture(options: { vrm?: Buffer } = {}): Promise<{ root: string; manifest: CyberPackageManifest }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-pack-source-'))
  const vrm = options.vrm ?? glb(vrmDocument())
  const pack = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    id: 'test-avatar-pack',
    version: '1.0.0',
    displayName: 'Test Avatar Pack',
    license: 'CC0-1.0',
    publisher: 'test',
    quality: 'production',
    bases: [{ baseModel: 'neutral-a', assetPath: 'base.vrm' }],
    parts: [],
    materialSlots: [],
  })}\n`, 'utf8')
  await writeFile(join(root, 'base.vrm'), vrm)
  await writeFile(join(root, 'avatar-base-pack.json'), pack)
  const manifest: CyberPackageManifest = {
    schemaVersion: 1,
    id: 'test-avatar-pack',
    version: '1.0.0',
    kind: 'asset',
    displayName: 'Test Avatar Pack',
    summary: 'Test install source',
    license: 'CC0-1.0',
    publisher: 'test',
    capabilities: ['avatar:base-pack'],
    dataEgress: [],
    files: [
      { path: 'avatar-base-pack.json', sha256: sha(pack) },
      { path: 'base.vrm', sha256: sha(vrm) },
    ],
  }
  return { root, manifest }
}

function sha(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function vrmDocument(): Record<string, unknown> {
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
