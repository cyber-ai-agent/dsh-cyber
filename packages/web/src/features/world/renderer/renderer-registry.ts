import type {
  RendererKind,
  RendererRegistry,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRendererFactory,
} from '@dsh-cyber/contracts'

import { PixiWorldRenderer } from './pixi-world-renderer.js'

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

export function createWorldRendererRegistry(): RendererRegistry<HTMLElement> {
  const registry = new DefaultRendererRegistry()
  registry.register('pixi-2d', (callbacks) => new PixiWorldRenderer(callbacks))
  return registry
}
