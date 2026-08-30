export class StreamingSentenceChunker {
  #buffer = ''
  #emitted = 0

  push(delta: string): string[] {
    this.#buffer += delta
    return this.#drain(false)
  }

  flush(): string[] { return this.#drain(true) }
  reset(): void { this.#buffer = ''; this.#emitted = 0 }

  #drain(flush: boolean): string[] {
    const chunks: string[] = []
    for (;;) {
      const maximum = this.#emitted === 0 ? 35 : 80
      const minimum = this.#emitted === 0 ? 12 : 24
      const boundary = naturalBoundary(this.#buffer, minimum, maximum)
      if (boundary > 0) {
        const value = this.#buffer.slice(0, boundary).trim()
        this.#buffer = this.#buffer.slice(boundary).trimStart()
        if (value) { chunks.push(value); this.#emitted += 1 }
        continue
      }
      if (this.#buffer.length >= maximum) {
        const split = softBoundary(this.#buffer, minimum, maximum)
        const value = this.#buffer.slice(0, split).trim()
        this.#buffer = this.#buffer.slice(split).trimStart()
        if (value) { chunks.push(value); this.#emitted += 1 }
        continue
      }
      break
    }
    if (flush && this.#buffer.trim()) { chunks.push(this.#buffer.trim()); this.#buffer = ''; this.#emitted += 1 }
    return chunks
  }
}

function naturalBoundary(value: string, minimum: number, maximum: number): number {
  const limit = Math.min(value.length, maximum)
  for (let index = 0; index < limit; index += 1) {
    const character = value[index]
    if (character === '\n' || '。！？'.includes(character ?? '')) return index + 1
    if (character === '；' && index + 1 >= minimum) return index + 1
    if (character === '.' || character === '!' || character === '?') {
      const previous = value[index - 1] ?? ''
      const next = value[index + 1] ?? ''
      if (/\d/u.test(previous) && /\d/u.test(next)) continue
      if (character === '.' && /[A-Za-z]/u.test(previous) && /[A-Za-z]/u.test(next)) continue
      if (!next || /\s/u.test(next)) return index + 1
    }
  }
  return 0
}

function softBoundary(value: string, minimum: number, maximum: number): number {
  const candidate = value.slice(minimum, maximum)
  const relative = Math.max(candidate.lastIndexOf('，'), candidate.lastIndexOf('、'), candidate.lastIndexOf(','), candidate.lastIndexOf(' '))
  return relative >= 0 ? minimum + relative + 1 : maximum
}
