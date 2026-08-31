import type {
  WorldCue,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
} from '@dsh-cyber/contracts'

import type { WorldLocomotion } from '../runtime/world-locomotion.js'
import type { WorldCameraMode } from '../runtime/world-view-mode.js'
import type { ThreeWorldRendererOptions } from './spatial/three-world-renderer.js'

/**
 * The 3D world, fetched only when somebody asks to see it.
 *
 * The 3D modules live under `spatial/`, not `three/`: the build assigns every
 * path containing `/three/` to the vrm-runtime chunk, so a directory named
 * that way pulled the whole chunk into anything importing it — the first
 * screen included. Only the real three library belongs in that chunk.
 *
 * `WorldRendererFactory` is synchronous, and three plus three-vrm are a large
 * chunk that must stay out of the first screen — a build budget enforces it,
 * and it holds only while every importer of three is lazy. So the registry gets
 * this shell immediately and the real renderer arrives during `mount`, which is
 * already async.
 *
 * Calls that land before the module resolves are not dropped: `mount` is
 * awaited by the caller, and everything else is recorded and replayed onto the
 * real renderer, so a snapshot or a selection arriving mid-load survives.
 */

type Pending = (renderer: WorldRenderer<HTMLElement>) => void

export class LazyThreeWorldRenderer implements WorldRenderer<HTMLElement> {
  readonly kind = 'three-3d' as const

  readonly #callbacks: WorldRendererCallbacks
  readonly #options: ThreeWorldRendererOptions
  readonly #pending: Pending[] = []
  readonly #pendingLatest = new Map<string, Pending>()
  #inner: WorldRenderer<HTMLElement> | undefined
  #destroyed = false
  #zoom = 1

  constructor(callbacks: WorldRendererCallbacks, options: ThreeWorldRendererOptions = {}) {
    this.#callbacks = callbacks
    this.#options = options
  }

  async mount(host: HTMLElement, manifest: WorldThemeManifestV1, snapshot: WorldRuntimeSnapshot): Promise<void> {
    const { ThreeWorldRenderer } = await import('./spatial/three-world-renderer.js')
    // The view can be abandoned while the chunk is in flight; mounting into a
    // host React has already thrown away would leak a WebGL context.
    if (this.#destroyed) return
    const renderer = new ThreeWorldRenderer(this.#callbacks, this.#options)
    this.#inner = renderer
    await renderer.mount(host, manifest, snapshot)
    if (this.#destroyed) {
      renderer.destroy()
      this.#inner = undefined
      return
    }
    for (const apply of this.#pending.splice(0)) apply(renderer)
    for (const apply of this.#pendingLatest.values()) apply(renderer)
    this.#pendingLatest.clear()
  }

  updateSnapshot(snapshot: WorldRuntimeSnapshot): void {
    this.#defer((renderer) => renderer.updateSnapshot(snapshot))
  }

  applyCues(cues: WorldCue[]): void {
    this.#defer((renderer) => renderer.applyCues(cues))
  }

  selectEntity(entityId?: string): void {
    this.#deferLatest('selected-entity', (renderer) => renderer.selectEntity(entityId))
  }

  selectObject(objectId?: string): void {
    this.#deferLatest('selected-object', (renderer) => renderer.selectObject(objectId))
  }

  focusEntity(entityId: string): void {
    this.#deferLatest('focus-entity', (renderer) => renderer.focusEntity(entityId))
  }

  setCameraMode(mode: WorldCameraMode, subjectId?: string): void {
    this.#deferLatest('camera', (renderer) => {
      const target = renderer as { setCameraMode?: (mode: WorldCameraMode, subjectId?: string) => void }
      target.setCameraMode?.(mode, subjectId)
    })
  }

  fitScene(): void {
    this.#zoom = 1
    this.#defer((renderer) => renderer.fitScene())
  }

  zoomBy(delta: number): void {
    this.#zoom = Math.min(2.2, Math.max(0.55, this.#zoom + delta))
    this.#defer((renderer) => renderer.zoomBy(delta))
  }

  getZoom(): number {
    return this.#inner?.getZoom() ?? this.#zoom
  }

  destroy(): void {
    this.#destroyed = true
    this.#pending.length = 0
    this.#pendingLatest.clear()
    this.#inner?.destroy()
    this.#inner = undefined
  }

  #defer(apply: Pending): void {
    if (this.#destroyed) return
    const renderer = this.#inner
    if (renderer === undefined) this.#pending.push(apply)
    else apply(renderer)
  }

  #deferLatest(key: string, apply: Pending): void {
    if (this.#destroyed) return
    const renderer = this.#inner
    if (renderer === undefined) this.#pendingLatest.set(key, apply)
    else apply(renderer)
  }
}

export type { WorldLocomotion }
