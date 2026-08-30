import { describe, expect, it } from 'vitest'

import { normalizeSpeechVoices, resolveSpeechVoice } from '../src/features/world/avatar/speech/speech-voice-catalog.js'
import { KOKORO_CHINESE_VOICES } from '../src/features/world/avatar/speech/KokoroSpeechAdapter.js'

describe('speech voice catalog', () => {
  it('keeps every distinct system voice while ordering Chinese and local voices first', () => {
    const voices = [
      voice('en-remote', 'English Remote', 'en-US', false),
      voice('zh-remote', '中文云端', 'zh-CN', false),
      voice('zh-local', '中文本机', 'zh-CN', true),
      voice('zh-local', '重复项', 'zh-CN', true),
    ]
    expect(normalizeSpeechVoices(voices).map((item) => item.voiceURI)).toEqual(['zh-local', 'zh-remote', 'en-remote'])
  })

  it('treats system default as no explicit voice and never substitutes a different voice', () => {
    const voices = [voice('zh-local', '中文本机', 'zh-CN', true)]
    expect(resolveSpeechVoice(voices, '')).toBeUndefined()
    expect(resolveSpeechVoice(voices, 'missing')).toBeUndefined()
    expect(resolveSpeechVoice(voices, 'zh-local')?.name).toBe('中文本机')
  })

  it('offers a balanced local Chinese catalog without relying on Windows voices', () => {
    expect(KOKORO_CHINESE_VOICES).toHaveLength(100)
    expect(new Set(KOKORO_CHINESE_VOICES.map((voice) => voice.id)).size).toBe(100)
    expect(KOKORO_CHINESE_VOICES.filter((voice) => voice.gender === '女声')).toHaveLength(55)
    expect(KOKORO_CHINESE_VOICES.filter((voice) => voice.gender === '男声')).toHaveLength(45)
  })
})

function voice(voiceURI: string, name: string, lang: string, localService: boolean): SpeechSynthesisVoice {
  return { voiceURI, name, lang, localService, default: false } as SpeechSynthesisVoice
}
