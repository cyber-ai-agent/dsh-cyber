import { describe, expect, it } from 'vitest'

import { splitKokoroSpeechText } from '../src/features/world/avatar/speech/KokoroSpeechAdapter.js'

describe('Kokoro speech text preparation', () => {
  it('removes unsupported emoji and splits long replies into bounded natural chunks', () => {
    const chunks = splitKokoroSpeechText(`你好🙂。${'这是一段需要分批生成的中文回复，'.repeat(18)}最后一句。`, 80)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true)
    expect(chunks.join('')).not.toContain('🙂')
    expect(chunks[0]).toBe('你好。')
  })
})
