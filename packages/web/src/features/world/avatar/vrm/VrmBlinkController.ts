import type { VRM } from '@pixiv/three-vrm'

export class VrmBlinkController {
  readonly #vrm: VRM
  #nextBlinkAt = 1_200 + Math.random() * 2_800
  #blinkStartedAt: number | undefined

  constructor(vrm: VRM) { this.#vrm = vrm }

  update(time: number, enabled: boolean): void {
    const manager = this.#vrm.expressionManager
    if (manager === null || manager === undefined) return
    if (!enabled) { manager.setValue('blink', 0); return }
    if (this.#blinkStartedAt === undefined && time >= this.#nextBlinkAt) this.#blinkStartedAt = time
    if (this.#blinkStartedAt === undefined) return
    const elapsed = time - this.#blinkStartedAt
    const weight = elapsed < 75 ? elapsed / 75 : elapsed < 155 ? 1 - (elapsed - 75) / 80 : 0
    manager.setValue('blink', Math.max(0, Math.min(1, weight)))
    if (elapsed >= 155) {
      this.#blinkStartedAt = undefined
      this.#nextBlinkAt = time + 1_800 + Math.random() * 4_200
    }
  }
}
