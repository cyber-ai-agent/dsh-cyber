import type {
  RendererKind,
  RendererRegistry,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRendererFactory,
} from '@dsh-cyber/contracts'

import { PixiWorldRenderer } from './pixi-world-renderer.js'
import { LazyThreeWorldRenderer } from './lazy-three-world-renderer.js'
import type { AvatarLod } from './spatial/three-world-lod.js'
import type { WorldLocomotion } from '../runtime/world-locomotion.js'

export class DefaultRendererRegistry implements RendererRegistry<HTMLElement> {
  readonly #factories = new Map<RendererKind, WorldRendererFactory<HTMLElement>>()

  register(kind: RendererKind, factory: WorldRendererFactory<HTMLElement>): void {
    this.#factories.set(kind, factory)
  }

  supports(kind: RendererKind): boolean {
    return this.#factories.has(kind)
  }

  create(kind: RendererKind, callbacks: WorldRendererCallbacks): WorldRenderer<HTMLElement> {
    const factory = this.#factories.get(kind)
    if (factory === undefined) throw new Error(`尚未安装世界渲染器：${kind}`)
    return factory(callbacks)
  }
}

export interface WorldRendererRegistryOptions {
  /**
   * Where characters actually are while they walk.
   *
   * Shared across renderers on purpose: the store outlives any one of them, so
   * swapping 2D for 3D mid-stride redraws the world rather than restarting it.
   */
  locomotion?: WorldLocomotion
  /** Ceiling the device tier imposes on how much of a character to run. */
  lodCeiling?: AvatarLod
  shadows?: boolean
  pixelRatio?: number
  resolveAvatarUrl?: (entityId: string) => string | undefined
}

export function createWorldRendererRegistry(
  options: WorldRendererRegistryOptions = {},
): RendererRegistry<HTMLElement> {
  const registry = new DefaultRendererRegistry()
  registry.register('pixi-2d', (callbacks) => new PixiWorldRenderer(callbacks, options.locomotion))
  // The 3D world shares the locomotion store with the 2D one on purpose: that
  // is what makes switching between them a change of view rather than a change
  // of place. Its module is fetched on first mount, never on the first screen.
  registry.register('three-3d', (callbacks) => new LazyThreeWorldRenderer(callbacks, {
    ...(options.locomotion === undefined ? {} : { locomotion: options.locomotion }),
    ...(options.lodCeiling === undefined ? {} : { lodCeiling: options.lodCeiling }),
    ...(options.shadows === undefined ? {} : { shadows: options.shadows }),
    ...(options.pixelRatio === undefined ? {} : { pixelRatio: options.pixelRatio }),
    ...(options.resolveAvatarUrl === undefined ? {} : { resolveAvatarUrl: options.resolveAvatarUrl }),
  }))
  return registry
}
