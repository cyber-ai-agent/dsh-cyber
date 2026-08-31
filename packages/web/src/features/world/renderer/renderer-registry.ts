import type {
  RendererKind,
  RendererRegistry,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRendererFactory,
} from '@dsh-cyber/contracts'

import { PixiWorldRenderer } from './pixi-world-renderer.js'
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
}

export function createWorldRendererRegistry(
  options: WorldRendererRegistryOptions = {},
): RendererRegistry<HTMLElement> {
  const registry = new DefaultRendererRegistry()
  registry.register('pixi-2d', (callbacks) => new PixiWorldRenderer(callbacks, options.locomotion))
  return registry
}
