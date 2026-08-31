import type { BufferGeometry, Material, Object3D, Texture } from 'three'

/**
 * Who is still using a downloaded avatar.
 *
 * The name promised a cache long before there was one: every character loaded
 * its own copy of the same URL, so a room where five people share a base
 * avatar downloaded and parsed it five times and kept five copies of its
 * textures in GPU memory.
 *
 * Reference counting rather than a plain map, because the lifetime is the
 * problem: characters come and go independently, and freeing a shared model
 * when the first of them leaves would empty everybody else.
 */

interface Entry<T> {
  value: Promise<T>
  users: number
  controller: AbortController
  settled: boolean
  released: boolean
  cancelConsumers: Set<() => void>
  /** Frees the underlying GPU resources. Only ever called at zero users. */
  release: (value: T) => void
}

export interface ResourceLease<T> {
  /** Resolves with the shared value unless this consumer is cancelled. */
  promise: Promise<T>
  /** Idempotently releases this consumer's reference. */
  release(): void
}

export class ResourceCache<T> {
  readonly #entries = new Map<string, Entry<T>>()

  /**
   * Takes a share of a resource, loading it if nobody has yet.
   *
   * The promise is cached, not just the result, so several characters asking
   * at once during a world's first paint share one download rather than
   * racing to start their own.
   */
  acquire(
    key: string,
    load: (signal?: AbortSignal) => Promise<T>,
    release: (value: T) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.acquireLease(key, load, release, signal).promise
  }

  /**
   * Acquires one independently cancellable consumer reference.
   *
   * Each consumer gets a wrapper promise and a release function, while the
   * underlying request remains shared. Aborting one consumer therefore cannot
   * cancel another; only the last release aborts an in-flight load.
   */
  acquireLease(
    key: string,
    load: (signal?: AbortSignal) => Promise<T>,
    release: (value: T) => void,
    signal?: AbortSignal,
  ): ResourceLease<T> {
    let entry = this.#entries.get(key)
    if (entry === undefined) {
      const controller = new AbortController()
      let value: Promise<T>
      try {
        value = Promise.resolve(load(controller.signal))
      } catch (cause) {
        value = Promise.reject(cause)
      }
      const created: Entry<T> = {
        value,
        users: 0,
        controller,
        settled: false,
        released: false,
        cancelConsumers: new Set(),
        release,
      }
      entry = created
      this.#entries.set(key, entry)
      // A failed load must not be remembered as a shared resource, or every
      // later character inherits the same rejection forever. The identity
      // guard avoids deleting a newer retry that reused this key.
      void entry.value.then(
        () => { entry!.settled = true; this.#releaseResolvedIfUnused(key, entry!) },
        () => { entry!.settled = true; if (this.#entries.get(key) === entry) this.#entries.delete(key) },
      )
    }

    entry.users += 1
    let released = false
    let consumerSettled = false
    let detachAbort: (() => void) | undefined
    let cancelConsumer: (() => void) | undefined
    const releaseLease = () => {
      if (released) return
      released = true
      detachAbort?.()
      if (cancelConsumer !== undefined) entry!.cancelConsumers.delete(cancelConsumer)
      this.#releaseConsumer(key, entry!)
    }
    const promise = new Promise<T>((resolve, reject) => {
      const cancel = () => {
        releaseLease()
        if (!consumerSettled) {
          consumerSettled = true
          reject(abortError())
        }
      }
      cancelConsumer = cancel
      entry!.cancelConsumers.add(cancel)
      if (signal?.aborted === true) {
        cancel()
        return
      }
      if (signal !== undefined) {
        signal.addEventListener('abort', cancel, { once: true })
        detachAbort = () => signal.removeEventListener('abort', cancel)
      }
      void entry!.value.then(
        (value) => {
          if (released) return
          detachAbort?.()
          detachAbort = undefined
          consumerSettled = true
          if (cancelConsumer !== undefined) entry!.cancelConsumers.delete(cancelConsumer)
          resolve(value)
        },
        (cause: unknown) => {
          if (released) return
          detachAbort?.()
          detachAbort = undefined
          releaseLease()
          consumerSettled = true
          reject(cause)
        },
      )
    })
    return { promise, release: releaseLease }
  }

  /** Gives a share back, freeing the resource once nobody holds one. */
  release(key: string): void {
    const entry = this.#entries.get(key)
    if (entry === undefined) return
    this.#releaseConsumer(key, entry)
  }

  /** How many holders a key has, for tests and diagnostics. */
  users(key: string): number {
    return this.#entries.get(key)?.users ?? 0
  }

  get size(): number {
    return this.#entries.size
  }

  clear(): void {
    for (const key of [...this.#entries.keys()]) {
      const entry = this.#entries.get(key)!
      this.#entries.delete(key)
      for (const cancel of [...entry.cancelConsumers]) cancel()
      entry.cancelConsumers.clear()
      entry.controller.abort()
      entry.users = 0
      this.#releaseResolvedIfUnused(key, entry)
    }
  }

  #releaseConsumer(key: string, entry: Entry<T>): void {
    if (entry.users <= 0) return
    entry.users -= 1
    if (entry.users > 0) return
    if (this.#entries.get(key) === entry) this.#entries.delete(key)
    if (!entry.settled) entry.controller.abort()
    this.#releaseResolvedIfUnused(key, entry)
  }

  #releaseResolvedIfUnused(key: string, entry: Entry<T>): void {
    if (entry.users !== 0 || entry.released || !entry.settled) return
    entry.released = true
    void entry.value.then((value) => entry.release(value)).catch(() => undefined)
    if (this.#entries.get(key) === entry) this.#entries.delete(key)
  }
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('资源加载已取消', 'AbortError')
  const error = new Error('资源加载已取消')
  error.name = 'AbortError'
  return error
}

export function disposeVrmScene(scene: Object3D): void {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  scene.traverse((object) => {
    const mesh = object as import('three').Mesh
    if (mesh.geometry !== undefined) geometries.add(mesh.geometry)
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : mesh.material === undefined ? [] : [mesh.material]
    for (const material of meshMaterials) {
      materials.add(material)
      for (const value of Object.values(material)) if (isTexture(value)) textures.add(value)
    }
  })
  for (const texture of textures) texture.dispose()
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}

function isTexture(value: unknown): value is Texture {
  return value !== null && typeof value === 'object' && 'isTexture' in value && (value as Texture).isTexture
}
