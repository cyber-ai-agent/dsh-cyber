import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ServiceError } from './service-error.js'
import { SherpaKokoroTtsProvider } from '../voice/tts/sherpa-kokoro-tts-provider.js'
import type { AudioChunk } from '@dsh-cyber/contracts'

interface SherpaManifest {
  schemaVersion: 2
  engine: 'sherpa-onnx'
  runtimeVersion: string
  modelDir: 'kokoro-int8-multi-lang-v1_1'
  voiceCount: 103
  files: Array<{ path: string; size: number; sha256: string }>
}

export interface LocalTtsAudio {
  wav: Buffer
  duration: number
  sampleRate: number
  peak: number
}

const MODEL_DIR = 'kokoro-int8-multi-lang-v1_1'

export class LocalTtsAssetService {
  readonly #root: string
  readonly #modelRoot: string
  readonly #manifestPath: string
  readonly #provider: SherpaKokoroTtsProvider
  #generationTail: Promise<void> = Promise.resolve()

  constructor(stateRoot: string) {
    this.#root = join(stateRoot, 'tts', 'sherpa')
    this.#modelRoot = join(this.#root, MODEL_DIR)
    this.#manifestPath = join(this.#root, 'manifest.json')
    this.#provider = new SherpaKokoroTtsProvider(this.#modelRoot)
  }

  async status(): Promise<{ installed: boolean; engine: 'sherpa-onnx'; voiceCount: number; runtimeVersion?: string; modelId?: string; byteLength?: number }> {
    try {
      const manifest = await this.#readManifest()
      let byteLength = 0
      for (const file of manifest.files) {
        const metadata = await stat(join(this.#modelRoot, file.path))
        if (!metadata.isFile() || metadata.size !== file.size) return { installed: false, engine: 'sherpa-onnx', voiceCount: 0 }
        byteLength += metadata.size
      }
      return { installed: true, engine: 'sherpa-onnx', voiceCount: 100, runtimeVersion: manifest.runtimeVersion, modelId: MODEL_DIR, byteLength }
    } catch {
      return { installed: false, engine: 'sherpa-onnx', voiceCount: 0 }
    }
  }

  async synthesize(input: { text: string; speakerId: number; speed: number; signal?: AbortSignal }): Promise<LocalTtsAudio> {
    const chunks: Float32Array[] = []
    let sampleRate = 24_000
    for await (const chunk of this.stream(input)) {
      if (chunk.pcm !== undefined) chunks.push(chunk.pcm)
      sampleRate = chunk.sampleRate
    }
    const samples = concatenate(chunks)
    let peak = 0
    let energy = 0
    for (const sample of samples) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample }
    const rms = Math.sqrt(energy / Math.max(1, samples.length))
    if (!Number.isFinite(peak) || peak < 0.0001 || rms < 0.00001) throw new ServiceError('conflict', 'local_tts_silent_output', '本地语音生成了静音，请重新安装语音包')
    return { wav: pcm16Wav(samples, sampleRate, peak), duration: samples.length / sampleRate, sampleRate, peak }
  }

  async *stream(input: { text: string; speakerId: number; speed: number; signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    const text = input.text.trim()
    if (text.length === 0 || text.length > 1_000) throw new ServiceError('invalid', 'local_tts_text_invalid', '播报内容长度必须在 1 到 1000 个字符之间')
    if (!Number.isInteger(input.speakerId) || input.speakerId < 3 || input.speakerId > 102) throw new ServiceError('invalid', 'local_tts_voice_invalid', '请选择有效的中文声音')
    if (!Number.isFinite(input.speed) || input.speed < 0.7 || input.speed > 1.3) throw new ServiceError('invalid', 'local_tts_speed_invalid', '语速必须在 0.7 到 1.3 之间')

    let release!: () => void
    const previous = this.#generationTail
    this.#generationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if ((await this.status()).installed !== true) throw new ServiceError('not-found', 'local_tts_not_installed', '本地中文语音包未安装，请运行 pnpm tts:install')
      for await (const chunk of this.#provider.synthesize({
        requestId: crypto.randomUUID(), text, voiceId: String(input.speakerId), speed: input.speed,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })) {
        yield chunk
      }
    } finally {
      release()
    }
  }

  async #readManifest(): Promise<SherpaManifest> {
    let value: unknown
    try { value = JSON.parse(await readFile(this.#manifestPath, 'utf8')) } catch { throw new ServiceError('not-found', 'local_tts_not_installed', '本地中文语音包未安装') }
    if (!isManifest(value)) throw new ServiceError('conflict', 'local_tts_manifest_invalid', '本地中文语音包清单无效')
    return value
  }
}

function concatenate(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}

function isManifest(value: unknown): value is SherpaManifest {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<SherpaManifest>
  return item.schemaVersion === 2 && item.engine === 'sherpa-onnx' && item.runtimeVersion === '1.13.6'
    && item.modelDir === MODEL_DIR && item.voiceCount === 103 && Array.isArray(item.files)
    && item.files.every((file) => file !== null && typeof file === 'object' && typeof file.path === 'string' && !file.path.split('/').includes('..')
      && Number.isSafeInteger(file.size) && file.size >= 0 && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256))
}

function pcm16Wav(samples: Float32Array, sampleRate: number, peak: number): Buffer {
  const output = Buffer.allocUnsafe(44 + samples.length * 2)
  output.write('RIFF', 0); output.writeUInt32LE(36 + samples.length * 2, 4); output.write('WAVE', 8)
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34)
  output.write('data', 36); output.writeUInt32LE(samples.length * 2, 40)
  const gain = Math.min(3, 0.9 / peak)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]! * gain))
    output.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + index * 2)
  }
  return output
}
