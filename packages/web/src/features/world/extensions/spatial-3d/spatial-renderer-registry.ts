import type { RendererRegistry } from '@dsh-cyber/contracts'

import { DefaultRendererRegistry } from '../../renderer/renderer-registry.js'
import { LazyThreeWorldRenderer } from '../../renderer/lazy-three-world-renderer.js'
import type { AvatarLod } from '../../renderer/spatial/three-world-lod.js'
import type { ThreeWorldRendererOptions } from '../../renderer/spatial/three-world-renderer.js'
import type { WorldLocomotion } from '../../runtime/world-locomotion.js'

export interface SpatialRendererRegistryOptions {
  locomotion: WorldLocomotion
  lodCeiling?: AvatarLod
  shadows?: boolean
  pixelRatio?: number
  resolveAvatarUrl?: (entityId: string) => string | undefined
  createRenderer?: ThreeWorldRendererOptions['createRenderer']
  loadAvatar?: ThreeWorldRendererOptions['loadAvatar']
}

/**
 * 3D renderer registration lives behind the optional extension boundary.
 * Importing the core world registry can no longer pull Three/VRM types into the
 * normal world path.
 */
export function createSpatialRendererRegistry(
  options: SpatialRendererRegistryOptions,
): RendererRegistry<HTMLElement> {
  const registry = new DefaultRendererRegistry()
  registry.register('three-3d', (callbacks) => new LazyThreeWorldRenderer(callbacks, {
    locomotion: options.locomotion,
    ...(options.lodCeiling === undefined ? {} : { lodCeiling: options.lodCeiling }),
    ...(options.shadows === undefined ? {} : { shadows: options.shadows }),
    ...(options.pixelRatio === undefined ? {} : { pixelRatio: options.pixelRatio }),
    ...(options.resolveAvatarUrl === undefined ? {} : { resolveAvatarUrl: options.resolveAvatarUrl }),
    ...(options.createRenderer === undefined ? {} : { createRenderer: options.createRenderer }),
    ...(options.loadAvatar === undefined ? {} : { loadAvatar: options.loadAvatar }),
  }))
  return registry
}
