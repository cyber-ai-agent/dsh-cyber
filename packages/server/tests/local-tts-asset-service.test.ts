import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LocalTtsAssetService, normalizeTtsText } from '../src/services/local-tts-asset-service.js'

const MODEL_DIR = 'kokoro-int8-multi-lang-v1_1'
const SHA = '0'.repeat(64)

describe('LocalTtsAssetService', () => {
  it('removes emoji and control characters before native synthesis', () => {
    expect(normalizeTtsText('你好🙂\u0000\n世界')).toBe('你好 世界')
  })

  it('reports only a pinned, complete sherpa-onnx voice runtime', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-local-tts-'))
    const root = join(stateRoot, 'tts', 'sherpa')
    const modelRoot = join(root, MODEL_DIR)
    await mkdir(modelRoot, { recursive: true })
    await writeFile(join(modelRoot, 'model.int8.onnx'), Buffer.from([1, 2, 3]))
    await writeFile(join(modelRoot, 'voices.bin'), Buffer.from([4, 5]))
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 2,
      engine: 'sherpa-onnx',
      runtimeVersion: '1.13.6',
      modelDir: MODEL_DIR,
      voiceCount: 103,
      files: [
        { path: 'model.int8.onnx', size: 3, sha256: SHA },
        { path: 'voices.bin', size: 2, sha256: SHA },
      ],
    }))

    const service = new LocalTtsAssetService(stateRoot)
    await expect(service.status()).resolves.toMatchObject({ installed: true, engine: 'sherpa-onnx', voiceCount: 100, byteLength: 5 })
    await expect(service.models()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'moss-tts-nano-100m-onnx', provider: 'moss', tier: 'default', recommended: true, state: 'not-installed' }),
      expect.objectContaining({ id: 'kokoro-int8-multi-lang-v1_1', provider: 'kokoro', tier: 'fast', state: 'ready' }),
      expect.objectContaining({ id: 'qwen3-tts-12hz-0.6b', provider: 'qwen-tts', tier: 'advanced', state: 'unavailable' }),
      expect.objectContaining({ id: 'dots-tts-soar-2b', provider: 'dots-tts', tier: 'advanced', state: 'unavailable' }),
    ]))
  })

  it('normalizes MOSS manifest voices and supplies a safe default when empty', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-moss-voices-'))
    const mossRoot = join(stateRoot, 'tts', 'sherpa', 'models', 'moss-tts-nano-100m-onnx')
    await mkdir(mossRoot, { recursive: true })
    await writeFile(join(mossRoot, 'manifest.json'), JSON.stringify({ voices: [
      'Junhao',
      'moss:Junhao',
      { id: 'moss:Lin', label: '林 · 自然女声', gender: 'female' },
      { id: 'Lin', name: '重复项' },
    ] }))
    const service = new LocalTtsAssetService(stateRoot)
    const model = (await service.models()).find((item) => item.provider === 'moss')
    expect(model?.state).toBe('ready')
    expect(model?.voices).toEqual([
      { id: 'moss:Junhao', label: 'Junhao' },
      { id: 'moss:Lin', label: '林 · 自然女声', gender: 'female' },
    ])

    // The service's public model id remains stable; an installed pack with no
    // declared voices still receives one selectable default.
    await writeFile(join(mossRoot, 'manifest.json'), JSON.stringify({ voices: [] }))
    const emptyModel = (await service.models()).find((item) => item.provider === 'moss')
    expect(emptyModel?.voices).toEqual([{ id: 'moss:Junhao', label: '君豪 · 自然男声', gender: 'male' }])
  })

  it('fails closed for an unpinned or incomplete voice runtime', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-local-tts-invalid-'))
    const root = join(stateRoot, 'tts', 'sherpa')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 2,
      engine: 'sherpa-onnx',
      runtimeVersion: '1.13.6',
      modelDir: '../../outside',
      voiceCount: 103,
      files: [{ path: 'model.int8.onnx', size: 1, sha256: SHA }],
    }))

    const service = new LocalTtsAssetService(stateRoot)
    await expect(service.status()).resolves.toEqual({ installed: false, engine: 'sherpa-onnx', voiceCount: 0 })
    await expect(service.synthesize({ text: '你好', speakerId: 58, speed: 1 })).rejects.toMatchObject({ code: 'local_tts_not_installed' })
  })

  it('rejects invalid synthesis input before loading the native runtime', async () => {
    const service = new LocalTtsAssetService(await mkdtemp(join(tmpdir(), 'dsh-cyber-local-tts-input-')))
    await expect(service.synthesize({ text: '', speakerId: 58, speed: 1 })).rejects.toMatchObject({ code: 'local_tts_text_invalid' })
    await expect(service.synthesize({ text: '你好', speakerId: 2, speed: 1 })).rejects.toMatchObject({ code: 'local_tts_voice_invalid' })
  })

  it('removes both installed MOSS files and the verified download cache', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-moss-remove-'))
    const installed = join(stateRoot, 'tts', 'sherpa', 'models', 'moss-tts-nano-100m-onnx')
    const cached = join(stateRoot, 'tts', 'sherpa', 'models', '.downloads', 'moss-tts-nano-100m-onnx')
    await mkdir(installed, { recursive: true }); await mkdir(cached, { recursive: true })
    await writeFile(join(installed, 'manifest.json'), '{}'); await writeFile(join(cached, 'cached.bin'), 'cached')
    const service = new LocalTtsAssetService(stateRoot)
    await service.removeModel('moss-tts-nano-100m-onnx')
    await expect(stat(installed)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(cached)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
