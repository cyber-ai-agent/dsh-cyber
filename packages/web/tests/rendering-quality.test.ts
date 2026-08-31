import { describe, expect, it } from 'vitest'

import { TestSpatialCapabilityProvider, detectRenderingQuality, supportsSpatialRendering } from '../src/features/world/avatar/renderer/RenderingQuality.js'

describe('spatial capability injection', () => {
  it('allows tests to force a real spatial renderer without changing production detection', () => {
    const provider = new TestSpatialCapabilityProvider({ supported: true, quality: 'high' })
    expect(supportsSpatialRendering(provider)).toBe(true)
    expect(detectRenderingQuality(false, provider)).toBe('high')
  })

  it('keeps an injected unsupported device on the static tier', () => {
    const provider = new TestSpatialCapabilityProvider({ supported: false, quality: 'high' })
    expect(supportsSpatialRendering(provider)).toBe(false)
    expect(detectRenderingQuality(false, provider)).toBe('static')
  })

  it('still honors reduced-motion as a motion policy, not a capability veto', () => {
    const provider = new TestSpatialCapabilityProvider({ supported: true, quality: 'high' })
    expect(detectRenderingQuality(true, provider)).toBe('static')
    expect(supportsSpatialRendering(provider)).toBe(true)
  })
})
