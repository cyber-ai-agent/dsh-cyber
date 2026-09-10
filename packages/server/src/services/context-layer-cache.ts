import { contextContentHash, type ContextLayer } from '@dsh-cyber/contracts'

/**
 * A small process-local cache for deterministic context layers.
 *
 * The cache is deliberately content addressed and bounded. It only keeps
 * projections that can be rebuilt from durable facts; requests, live tool
 * output and memory ranking remain outside it. Restarting the host therefore
 * cannot lose a fact, and a changed revision/content hash naturally creates a
 * new entry instead of serving stale context.
 */
export interface ContextLayerCacheStats {
  hits: number
  misses: number
  size: number
  maxEntries: number
}

export class ContextLayerCache {
  readonly #entries = new Map<string, ContextLayer>()
  readonly #maxEntries: number
  #hits = 0
  #misses = 0

  constructor(maxEntries = 256) {
    this.#maxEntries = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 256
  }

  /** Return a previously composed layer, or store the deterministic result. */
  getOrCreate(key: string, create: () => ContextLayer): ContextLayer {
    const normalizedKey = key.trim()
    if (normalizedKey.length > 0) {
      const cached = this.#entries.get(normalizedKey)
      if (cached !== undefined) {
        this.#hits += 1
        // Map insertion order is the LRU order. Touching the entry keeps an
        // active world/character prefix from being evicted first.
        this.#entries.delete(normalizedKey)
        this.#entries.set(normalizedKey, cached)
        return cached
      }
    }

    this.#misses += 1
    const layer = create()
    if (normalizedKey.length === 0) return layer
    this.#entries.set(normalizedKey, layer)
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
    return layer
  }

  /** Canonicalize a layer by its stable identity without re-rendering it. */
  canonical(layer: ContextLayer): ContextLayer {
    return this.getOrCreate(
      `layer:${layer.kind}:${layer.id}:${layer.revision}:${layer.contentHash}:${contextContentHash(layer.sourceRefs)}`,
      () => layer,
    )
  }

  stats(): ContextLayerCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      size: this.#entries.size,
      maxEntries: this.#maxEntries,
    }
  }

  clear(): void {
    this.#entries.clear()
    this.#hits = 0
    this.#misses = 0
  }
}
