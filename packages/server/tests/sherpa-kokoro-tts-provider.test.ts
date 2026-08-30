import { describe, expect, it, vi } from 'vitest'

import { SherpaKokoroTtsProvider } from '../src/voice/tts/sherpa-kokoro-tts-provider.js'

function hangingEngine() {
  return {
    module: {
      OfflineTts: { createAsync: vi.fn() },
      GenerationConfig: class { constructor(_input: { sid: number; speed: number; silenceScale: number }) {} },
    },
    tts: {
      generateAsync: vi.fn(async () => new Promise<never>(() => undefined)),
    },
  }
}

describe('SherpaKokoroTtsProvider cancellation', () => {
  it('wakes a waiting audio iterator immediately when the caller aborts', async () => {
    const controller = new AbortController()
    const provider = new SherpaKokoroTtsProvider('unused', async () => hangingEngine(), 1_000)
    const iterator = provider.synthesize({ requestId: 'abort-request', text: '取消生成', voiceId: '58', speed: 1, signal: controller.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: '本地语音生成已取消' })
    expect(provider.state).toBe('ready')
  })

  it('fails a stalled native generation instead of leaving the queue busy forever', async () => {
    const provider = new SherpaKokoroTtsProvider('unused', async () => hangingEngine(), 10)
    const iterator = provider.synthesize({ requestId: 'timeout-request', text: '超时保护', voiceId: '58', speed: 1 })[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError', message: '本地语音生成超时，请缩短播报内容或稍后重试' })
    expect(provider.state).toBe('ready')
  })
})
