/**
 * In-process mutual exclusion keyed by an arbitrary string.
 *
 * The local-first server is a single process, so ordering overlapping
 * read-modify-write flows over the same file only needs a per-key promise
 * chain. This is deliberately not a lockfile protocol and not a distributed
 * lock: it adds ordering, it does not replace the crash atomicity that an
 * atomic rename already gives each individual write.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    // A failing task must not wedge the key, and the settled chain must never
    // surface as an unhandled rejection.
    const tail = result.then(() => undefined, () => undefined)
    this.#tails.set(key, tail)
    try {
      return await result
    } finally {
      // Only the last waiter clears the key, so the map does not grow forever.
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}
