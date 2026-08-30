export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = []
  #waiting: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = []
  #closed = false
  #error: unknown

  push(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiting.shift()
    if (waiter !== undefined) waiter.resolve({ value, done: false })
    else this.#items.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiting.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#items = []
    this.#error = error
    this.#closed = true
    for (const waiter of this.#waiting.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#items.shift()
        if (value !== undefined) return { value, done: false }
        if (this.#error !== undefined) throw this.#error
        if (this.#closed) return { value: undefined, done: true }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiting.push({ resolve, reject }))
      },
    }
  }
}
