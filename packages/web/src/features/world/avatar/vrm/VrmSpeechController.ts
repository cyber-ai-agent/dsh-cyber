import type { VRM } from '@pixiv/three-vrm'

import { sampleSpeechActivity, type VisemeTimeline } from '../motion/VisemeTimeline.js'
import { currentSpeechAmplitude } from '../speech/speech-playback-state.js'

export class VrmSpeechController {
  readonly #vrm: VRM
  #timeline: VisemeTimeline | undefined
  #startedAt = 0

  constructor(vrm: VRM) { this.#vrm = vrm }

  setTimeline(timeline: VisemeTimeline | undefined, startedAt = performance.now()): void { this.#timeline = timeline; this.#startedAt = startedAt }

  /**
   * Drives the mouth.
   *
   * `amplitude` is optional because loudness belongs to whoever is talking,
   * and a shared scene can have two characters talking at once. The module
   * global stays the fallback: for a single-character view there is nobody
   * else it could be confused with.
   */
  update(time: number, speaking: boolean, amplitude?: number): void {
    const manager = this.#vrm.expressionManager
    if (manager === null || manager === undefined) return
    for (const name of ['aa', 'ih', 'ou', 'ee', 'oh']) manager.setValue(name, 0)
    const timeline = this.#timeline
    if (timeline !== undefined && speaking) {
      const elapsed = time - this.#startedAt
      const frame = [...timeline.frames].reverse().find((item) => item.time <= elapsed)
      if (frame !== undefined && frame.viseme !== 'neutral') manager.setValue(frame.viseme, frame.weight)
      return
    }
    manager.setValue('aa', sampleSpeechActivity(time, speaking, amplitude ?? currentSpeechAmplitude()))
  }
}
