import { describe, expect, it } from 'vitest'

import { parsePackRendererUrl, rendererAvatarUrl } from '../src/features/world/avatar/avatar-representation-loader.js'

describe('avatar representation renderer keys', () => {
  it('leaves employee-published VRM URLs untouched', () => {
    expect(rendererAvatarUrl('employee-1', {
      source: 'published',
      key: 'published:/api/avatar.vrm',
      assetUrl: '/api/avatar.vrm',
    })).toBe('/api/avatar.vrm')
  })

  it('turns a Base Pack assembly into an opaque renderer key rather than leaking its shared URL as identity', () => {
    const url = rendererAvatarUrl('员工:A', {
      source: 'base-pack',
      key: 'base-pack:studio@1.0.0:female|bob|professional',
      assetUrl: '/assets/shared-female.vrm',
      cacheKey: 'avatar-pack:studio@1.0.0:female-a',
      identityScore: 0.96,
    })
    expect(url).toMatch(/^dsh-avatar-pack:/u)
    expect(url).not.toContain('/assets/shared-female.vrm')
    expect(parsePackRendererUrl(url!)).toEqual({
      employeeId: '员工:A',
      key: 'base-pack:studio@1.0.0:female|bob|professional',
    })
  })

  it('does not treat ordinary or malformed strings as pack renderer keys', () => {
    expect(parsePackRendererUrl('/api/avatar.vrm')).toBeUndefined()
    expect(parsePackRendererUrl('dsh-avatar-pack:missing-separator')).toBeUndefined()
    expect(parsePackRendererUrl('dsh-avatar-pack:%E0%A4%A:key')).toBeUndefined()
  })
})
