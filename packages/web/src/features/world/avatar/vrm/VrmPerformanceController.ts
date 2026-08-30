import type { RenderingQuality } from '../renderer/RenderingQuality.js'

export class VrmPerformanceController {
  readonly quality: RenderingQuality
  #windowStartedAt = performance.now()
  #frames = 0
  #reported = false

  constructor(quality: RenderingQuality) { this.quality = quality }

  targetInterval(): number { return this.quality === 'low' ? 1_000 / 20 : 1_000 / 30 }

  recordFrame(time: number, onSustainedLowFps: (fps: number) => void): void {
    this.#frames += 1
    const elapsed = time - this.#windowStartedAt
    if (elapsed < 4_000) return
    const fps = this.#frames / (elapsed / 1_000)
    if (!this.#reported && fps < (this.quality === 'low' ? 11 : 18)) { this.#reported = true; onSustainedLowFps(fps) }
    this.#windowStartedAt = time
    this.#frames = 0
  }
}
