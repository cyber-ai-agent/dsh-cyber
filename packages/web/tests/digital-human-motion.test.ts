import { describe, expect, it } from 'vitest'

import { motionCueForState, speechTextFromMessage } from '../src/features/world/digital-human-motion.js'
import { sampleSpeechActivity } from '../src/features/world/avatar/motion/VisemeTimeline.js'

describe('digital-human motion contract', () => {
  it('maps speaking and failure to renderer-neutral expression and gesture cues', () => {
    expect(motionCueForState('speaking')).toEqual({ expression: 'speaking', gesture: 'explain' })
    expect(motionCueForState('failed')).toEqual({ expression: 'exhausted', gesture: 'freeze' })
  })

  it('keeps local speech concise and does not read code or URLs aloud', () => {
    const text = speechTextFromMessage('# 结论\n请查看 [产物](https://example.com/a)。```ts\nconst secret = true\n``` https://example.com/raw')
    expect(text).toBe('结论 请查看 产物。')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('http')
  })

  it('caps unusually long replies before handing them to the browser voice', () => {
    expect(speechTextFromMessage('测'.repeat(50), 12)).toBe(`${'测'.repeat(11)}…`)
  })

  it('uses real PCM amplitude before the synthetic mouth fallback', () => {
    expect(sampleSpeechActivity(1_000, true, 0.2)).toBeCloseTo(0.72)
    expect(sampleSpeechActivity(1_000, false, 0.2)).toBe(0)
    expect(sampleSpeechActivity(1_000, true)).toBeGreaterThan(0)
  })
})
