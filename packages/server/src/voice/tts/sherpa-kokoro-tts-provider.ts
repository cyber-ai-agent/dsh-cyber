import { createRequire } from 'node:module'
import { join } from 'node:path'

import type { AudioChunk, TextToSpeechCapabilities, TextToSpeechProvider, TtsRequest, VoiceRuntimeState } from '@dsh-cyber/contracts'

interface SherpaModule {
  OfflineTts: { createAsync(config: unknown): Promise<SherpaTts> }
  GenerationConfig: new (input: { sid: number; speed: number; silenceScale: number }) => unknown
}

interface SherpaTts {
  generateAsync(input: {
    text: string
    enableExternalBuffer: boolean
    generationConfig: unknown
    onProgress(info: { samples: Float32Array; progress: number }): number
  }): Promise<{ samples: Float32Array; sampleRate: number }>
}

const require = createRequire(import.meta.url)

export class SherpaKokoroTtsProvider implements TextToSpeechProvider {
  readonly id = 'sherpa-kokoro-local'
  readonly kind = 'kokoro' as const
  readonly capabilities: TextToSpeechCapabilities = { streaming: true, pcm: true, viseme: false, voiceClone: false }
  #state: VoiceRuntimeState = 'cold'
  #enginePromise: Promise<{ module: SherpaModule; tts: SherpaTts }> | undefined
  #active = new Map<string, AbortController>()

  constructor(private readonly modelRoot: string) {}

  get state(): VoiceRuntimeState { return this.#state }

  async prepare(): Promise<void> {
    await this.#engine()
  }

  async *synthesize(request: TtsRequest): AsyncIterable<AudioChunk> {
    const { module, tts } = await this.#engine()
    const speakerId = Number(request.voiceId)
    if (!Number.isInteger(speakerId) || speakerId < 3 || speakerId > 102) throw new Error('请选择有效的中文声音')
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.signal?.addEventListener('abort', abort, { once: true })
    this.#active.set(request.requestId, controller)
    this.#state = 'busy'
    const queue = new AsyncQueue<Float32Array>()
    let sampleRate = 24_000
    let progressSamples = 0
    const generation = tts.generateAsync({
      text: request.text,
      enableExternalBuffer: true,
      generationConfig: new module.GenerationConfig({ sid: speakerId, speed: request.speed, silenceScale: 0.2 }),
      onProgress: ({ samples }) => {
        if (controller.signal.aborted) return 0
        if (samples.length > 0) {
          progressSamples += samples.length
          queue.push(new Float32Array(samples))
        }
        return 1
      },
    }).then((audio) => {
      sampleRate = audio.sampleRate
      if (progressSamples === 0 && audio.samples.length > 0) queue.push(new Float32Array(audio.samples))
      queue.close()
    }).catch((error: unknown) => queue.fail(error))

    let sequence = 0
    let pending: Float32Array | undefined
    try {
      for await (const samples of queue) {
        if (pending !== undefined) yield chunk(sequence++, pending, sampleRate, false)
        pending = samples
      }
      await generation
      if (pending !== undefined) yield chunk(sequence, pending, sampleRate, true)
    } finally {
      request.signal?.removeEventListener('abort', abort)
      this.#active.delete(request.requestId)
      this.#state = this.#enginePromise === undefined ? 'cold' : 'ready'
    }
  }

  cancel(requestId?: string): void {
    if (requestId !== undefined) this.#active.get(requestId)?.abort()
    else for (const controller of this.#active.values()) controller.abort()
  }

  async dispose(): Promise<void> {
    this.cancel()
    this.#enginePromise = undefined
    this.#state = 'cold'
  }

  async #engine(): Promise<{ module: SherpaModule; tts: SherpaTts }> {
    if (this.#enginePromise !== undefined) return this.#enginePromise
    this.#state = 'warming'
    const loading = (async () => {
      const module = require('sherpa-onnx-node') as SherpaModule
      const tts = await module.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: join(this.modelRoot, 'model.int8.onnx'),
            voices: join(this.modelRoot, 'voices.bin'),
            tokens: join(this.modelRoot, 'tokens.txt'),
            dataDir: join(this.modelRoot, 'espeak-ng-data'),
            lexicon: `${join(this.modelRoot, 'lexicon-us-en.txt')},${join(this.modelRoot, 'lexicon-zh.txt')}`,
          },
          debug: false,
          numThreads: 2,
          provider: 'cpu',
        },
        maxNumSentences: 1,
      })
      this.#state = 'ready'
      return { module, tts }
    })()
    this.#enginePromise = loading
    void loading.catch(() => { if (this.#enginePromise === loading) this.#enginePromise = undefined; this.#state = 'failed' })
    return loading
  }
}

function chunk(sequence: number, pcm: Float32Array, sampleRate: number, final: boolean): AudioChunk {
  return { sequence, pcm, sampleRate, durationMs: pcm.length / sampleRate * 1000, final }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = []
  #waiting: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = []
  #closed = false
  #error: unknown

  push(value: T): void {
    const waiter = this.#waiting.shift()
    if (waiter !== undefined) waiter.resolve({ value, done: false })
    else this.#items.push(value)
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiting.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  fail(error: unknown): void {
    this.#error = error
    this.#closed = true
    for (const waiter of this.#waiting.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#items.shift()
        if (value !== undefined) return { value, done: false }
        if (this.#error !== undefined) throw this.#error
        if (this.#closed) return { value: undefined, done: true }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiting.push({ resolve, reject }))
      },
    }
  }
}
