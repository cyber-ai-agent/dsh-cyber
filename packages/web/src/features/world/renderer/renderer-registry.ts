import type {
  RendererKind,
  RendererRegistry,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRendererFactory,
} from '@dsh-cyber/contracts'

import { PixiWorldRenderer } from './pixi-world-renderer.js'
import type { WorldLocomotion } from '../runtime/world-locomotion.js'

/** Core registry deliberately knows only about the lightweight world. */
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
    if (factory === undefined) throw new Error(`核心世界未提供渲染器：${kind}`)
    return factory(callbacks)
  }
}

export interface WorldRendererRegistryOptions {
  locomotion?: WorldLocomotion
}

export function createWorldRendererRegistry(
  options: WorldRendererRegistryOptions = {},
): RendererRegistry<HTMLElement> {
  const registry = new DefaultRendererRegistry()
  registry.register('pixi-2d', (callbacks) => new PixiWorldRenderer(callbacks, options.locomotion))
  return registry
}
