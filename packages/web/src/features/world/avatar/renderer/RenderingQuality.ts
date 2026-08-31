export type RenderingQuality = 'high' | 'balanced' | 'low' | 'static'

/**
 * The policy boundary between browser capability detection and world UI.
 * Tests can provide deterministic spatial capability without weakening the
 * production rule that refuses software WebGL.
 */
export interface SpatialCapabilityProvider {
  supportsSpatialRendering(): boolean
  quality(staticMode: boolean): RenderingQuality
}

/**
 * Whether this device can draw a 3D world at all.
 *
 * Deliberately separate from {@link detectRenderingQuality}, which also folds
 * in `prefers-reduced-motion`. Wanting less motion is not the same as having
 * no GPU: the 3D world answers it by damping its camera and dropping secondary
 * motion, and refusing to draw the world would take away a mode the user never
 * asked to lose.
 */
export class BrowserSpatialCapabilityProvider implements SpatialCapabilityProvider {
  readonly #spatial = typeof window !== 'undefined' && supportsWebGl()

  supportsSpatialRendering(): boolean {
    return this.#spatial
  }

  quality(staticMode: boolean): RenderingQuality {
    return detectRenderingQuality(staticMode, this)
  }
}

/** Deterministic provider for renderer integration and browser contract tests. */
export class TestSpatialCapabilityProvider implements SpatialCapabilityProvider {
  readonly #supported: boolean
  readonly #quality: RenderingQuality

  constructor(options: { supported?: boolean; quality?: RenderingQuality } = {}) {
    this.#supported = options.supported ?? true
    this.#quality = options.quality ?? 'high'
  }

  supportsSpatialRendering(): boolean {
    return this.#supported
  }

  quality(staticMode: boolean): RenderingQuality {
    return staticMode ? 'static' : this.#quality
  }
}

export const browserSpatialCapabilityProvider = new BrowserSpatialCapabilityProvider()

export function supportsSpatialRendering(provider: SpatialCapabilityProvider = browserSpatialCapabilityProvider): boolean {
  return provider.supportsSpatialRendering()
}

export function detectRenderingQuality(
  staticMode: boolean,
  provider: SpatialCapabilityProvider = browserSpatialCapabilityProvider,
): RenderingQuality {
  if (staticMode || typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'static'
  if (!provider.supportsSpatialRendering()) return 'static'
  const device = navigator as Navigator & { deviceMemory?: number }
  const memory = device.deviceMemory
  const cores = navigator.hardwareConcurrency
  if ((memory !== undefined && memory <= 4) || (cores > 0 && cores <= 4)) return 'low'
  if ((memory === undefined || memory >= 8) && (cores === 0 || cores >= 8)) return 'high'
  return 'balanced'
}

export function nextLowerQuality(current: RenderingQuality): RenderingQuality {
  if (current === 'high') return 'balanced'
  if (current === 'balanced') return 'low'
  return 'static'
}

function supportsWebGl(): boolean {
  try {
    // Headless browsers have no user-visible GPU surface and frequently expose
    // a software context that can block on readback/context creation.
    if (/HeadlessChrome/iu.test(navigator.userAgent)) return false
    const canvas = document.createElement('canvas')
    // Capability probing must not deliberately lose the shared GPU context.
    // On software renderers (including SwiftShader) a forced loss immediately
    // before Three creates its renderer can stall or poison the next context.
    const context = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
      ?? canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true })
    if (context === null) return false
    const rendererInfo = context.getExtension('WEBGL_debug_renderer_info')
    const renderer = rendererInfo === null ? '' : String(context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
    return !/swiftshader|software renderer|llvmpipe/iu.test(renderer)
  } catch {
    return false
  }
}
