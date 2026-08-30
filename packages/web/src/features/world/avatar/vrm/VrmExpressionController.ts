import type { VRM } from '@pixiv/three-vrm'

import type { DigitalHumanExpression } from '../../digital-human-motion.js'

const EXPRESSION_PRESETS: Partial<Record<DigitalHumanExpression, string>> = {
  neutral: 'neutral', focused: 'neutral', confident: 'relaxed', speaking: 'neutral', concerned: 'surprised', exhausted: 'sad',
}

export class VrmExpressionController {
  readonly #vrm: VRM
  #current = new Map<string, number>()

  constructor(vrm: VRM) { this.#vrm = vrm }

  update(expression: DigitalHumanExpression, delta: number): void {
    const manager = this.#vrm.expressionManager
    if (manager === null || manager === undefined) return
    const active = EXPRESSION_PRESETS[expression]
    for (const name of ['neutral', 'relaxed', 'surprised', 'sad']) {
      const target = name === active ? (expression === 'focused' ? 0.32 : 0.5) : 0
      const current = this.#current.get(name) ?? 0
      const next = current + (target - current) * Math.min(1, delta * 7)
      this.#current.set(name, next)
      manager.setValue(name, next)
    }
  }

  dispose(): void { this.#current.clear() }
}
