import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { LocalPackageCatalog } from '@dsh-cyber/package-runtime'

import { assertAvatarBaseVrmEnvelope } from '../src/avatar-base-pack-manifest.js'
import {
  AvatarBasePackService,
  OFFICIAL_AVATAR_BASE_PACK_ID,
} from '../src/services/avatar-base-pack-service.js'
import type { WorldPackageInstanceService } from '../src/services/world-package-instance-service.js'

const OFFICIAL_BASE_PATH = 'models/neutral.vrm'
const OFFICIAL_VERSION = '1.1.0'

describe('official avatar base pack delivery', () => {
  it('discovers the committed production pack from a clean checkout without copying it into the world', async () => {
    const listRuntimePackages = vi.fn(async () => [])
    const catalog = new LocalPackageCatalog(resolve(process.cwd(), 'marketplace'))
    const service = new AvatarBasePackService(
      { listRuntimePackages } as unknown as WorldPackageInstanceService,
      { catalog, builtInPackageIds: [OFFICIAL_AVATAR_BASE_PACK_ID] },
    )

    const packs = await service.list('world-clean')
    const official = packs.find((pack) => pack.id === OFFICIAL_AVATAR_BASE_PACK_ID)

    expect(official).toMatchObject({
      id: OFFICIAL_AVATAR_BASE_PACK_ID,
      version: OFFICIAL_VERSION,
      quality: 'production',
      license: 'CC0-1.0',
      bases: [{
        baseModel: 'neutral-a',
        cacheKey: `builtin-avatar-pack:${OFFICIAL_AVATAR_BASE_PACK_ID}@${OFFICIAL_VERSION}:neutral-a`,
      }],
    })
    expect(official?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'professional', kind: 'outfit' }),
      expect.objectContaining({ id: 'analyst', kind: 'outfit' }),
    ]))
    expect(official?.parts.some((part) => part.id === 'engineer' && part.kind === 'outfit')).toBe(false)
    expect(official?.bases[0]?.assetUrl).toContain(`/avatar-base-packs/${OFFICIAL_AVATAR_BASE_PACK_ID}/${OFFICIAL_VERSION}/assets/${OFFICIAL_BASE_PATH}`)
    expect(listRuntimePackages).toHaveBeenCalledWith('world-clean')

    const asset = await service.readBaseAsset(
      'world-clean',
      OFFICIAL_AVATAR_BASE_PACK_ID,
      OFFICIAL_VERSION,
      OFFICIAL_BASE_PATH,
    )
    expect(asset.contentType).toBe('model/gltf-binary')
    expect(asset.body.byteLength).toBeGreaterThan(6 * 1024 * 1024)
    expect(() => assertAvatarBaseVrmEnvelope(asset.body, 'official delivery fixture')).not.toThrow()
  })

  it('does not expose an arbitrary Marketplace asset through the built-in allow-list', async () => {
    const catalog = new LocalPackageCatalog(resolve(process.cwd(), 'marketplace'))
    const service = new AvatarBasePackService(
      { listRuntimePackages: async () => [] } as unknown as WorldPackageInstanceService,
      { catalog, builtInPackageIds: ['official-browser'] },
    )

    await expect(service.list('world-clean')).rejects.toThrow(/official verification/u)
  })
})
