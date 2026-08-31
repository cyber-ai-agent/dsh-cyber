import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadWorldAvatarBasePacks } from '../src/features/world/avatar/avatar-base-pack-client.js'

afterEach(() => vi.restoreAllMocks())

describe('world avatar base pack client', () => {
  it('loads and validates a world-scoped local pack manifest', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{
      schemaVersion: 1,
      id: 'official-avatar-studio',
      version: '1.0.0',
      displayName: 'Official Avatar Studio',
      license: 'CC0-1.0',
      publisher: 'DSH Cyber',
      quality: 'production',
      bases: [{
        baseModel: 'female-a',
        assetUrl: '/api/worlds/world%201/avatar-base-packs/official-avatar-studio/1.0.0/assets/models/female.vrm',
        cacheKey: 'world-avatar-pack:world 1:official-avatar-studio@1.0.0:female-a',
      }],
      parts: [{ id: 'long-layered', kind: 'hair', meshNames: ['Hair_Long'] }],
      materialSlots: [{ id: 'hair', materialNames: ['Hair'] }],
    }] }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(loadWorldAvatarBasePacks('world 1')).resolves.toEqual([expect.objectContaining({
      id: 'official-avatar-studio',
      quality: 'production',
    })])
    expect(fetch).toHaveBeenCalledWith('/api/worlds/world%201/avatar-base-packs', expect.objectContaining({ headers: {} }))
  })

  it('rejects malformed server manifests instead of registering arbitrary URLs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{
      schemaVersion: 1,
      id: 'bad',
      version: '1.0.0',
      displayName: 'Bad',
      license: 'unknown',
      publisher: 'bad',
      quality: 'production',
      bases: [{ baseModel: 'female-a', assetUrl: 'javascript:alert(1)' }],
      parts: [], materialSlots: [],
    }] }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(loadWorldAvatarBasePacks('world-1')).rejects.toThrow(/站内绝对路径|HTTPS/u)
  })
})
