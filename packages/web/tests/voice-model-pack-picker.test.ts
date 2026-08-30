import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VoiceModelPackPicker } from '../src/features/voice/VoiceModelPackPicker.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('VoiceModelPackPicker', () => {
  it('recommends MOSS while keeping heavy advanced models honest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [
      { id: 'moss-tts-nano-100m-onnx', provider: 'moss', displayName: 'MOSS-TTS-Nano', version: '100M-ONNX', license: 'Apache-2.0', byteLength: 762_000_000, state: 'not-installed', tier: 'default', recommended: true, runtime: 'onnx-cpu', summary: '默认自然语音包。' },
      { id: 'kokoro-int8-multi-lang-v1_1', provider: 'kokoro', displayName: 'Kokoro 快速语音', version: '1.1', license: 'Apache-2.0', byteLength: 147_000_000, state: 'ready', tier: 'fast', runtime: 'onnx-cpu', summary: '快速备用。' },
      { id: 'dots-tts-soar-2b', provider: 'dots-tts', displayName: 'dots.tts SOAR 2B', version: '2B', license: 'Apache-2.0', byteLength: 0, state: 'unavailable', tier: 'advanced', runtime: 'python-cuda', summary: '高级克隆语音。', requirements: ['高显存 GPU'] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(VoiceModelPackPicker, { value: 'auto', onActivate: vi.fn() })); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(host.querySelector('select')?.value).toBe('moss-tts-nano-100m-onnx')
    expect(host.textContent).toContain('下载并安装')
    const select = host.querySelector('select')!
    await act(async () => { select.value = 'dots-tts-soar-2b'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('高级模型')
    expect(host.textContent).toContain('高显存 GPU')
    expect(host.textContent).not.toContain('下载并安装')
    await act(async () => root.unmount())
  })

  it('shows byte progress and a cancellation action while downloading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [{
      id: 'moss-tts-nano-100m-onnx', provider: 'moss', displayName: 'MOSS-TTS-Nano', version: '100M-ONNX', license: 'Apache-2.0',
      byteLength: 763_000_000, state: 'downloading', tier: 'default', recommended: true, runtime: 'onnx-cpu', summary: '默认自然语音包。',
      progress: { phase: 'downloading', completedBytes: 381_500_000, totalBytes: 763_000_000 },
    }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(VoiceModelPackPicker, { value: 'auto', onActivate: vi.fn() })); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(host.querySelector('progress')?.value).toBe(381_500_000)
    expect(host.textContent).toContain('正在下载')
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="取消语音模型下载"]')).not.toBeNull()
    await act(async () => root.unmount())
  })
})
