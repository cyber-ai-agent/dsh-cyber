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
  /** Frees the underlying GPU resources. Only ever called at zero users. */
  release: (value: T) => void
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
  acquire(key: string, load: () => Promise<T>, release: (value: T) => void): Promise<T> {
    const existing = this.#entries.get(key)
    if (existing !== undefined) {
      existing.users += 1
      return existing.value
    }
    const entry: Entry<T> = { value: load(), users: 1, release }
    this.#entries.set(key, entry)
    // A failed load must not be remembered as a shared resource, or every
    // later character inherits the same rejection forever.
    void entry.value.catch(() => { this.#entries.delete(key) })
    return entry.value
  }

  /** Gives a share back, freeing the resource once nobody holds one. */
  release(key: string): void {
    const entry = this.#entries.get(key)
    if (entry === undefined) return
    entry.users -= 1
    if (entry.users > 0) return
    this.#entries.delete(key)
    void entry.value.then((value) => entry.release(value)).catch(() => undefined)
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
      void entry.value.then((value) => entry.release(value)).catch(() => undefined)
    }
  }
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
