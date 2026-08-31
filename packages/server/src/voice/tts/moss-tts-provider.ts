import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'

import type { AudioChunk, TextToSpeechCapabilities, TextToSpeechProvider, TtsRequest, VoiceRuntimeState } from '@dsh-cyber/contracts'
import { AsyncQueue } from '../async-queue.js'

type PendingRequest = {
  queue: AsyncQueue<AudioChunk>
  timeout: ReturnType<typeof setTimeout>
  detachAbort(): void
  sampleRate: number
  nextSequence: number
}
type MossTtsProviderOptions = { executable?: string; sidecar?: string; requestTimeoutMs?: number; startupTimeoutMs?: number }

export class MossTtsProvider implements TextToSpeechProvider {
  readonly id = 'moss-tts-nano-local'
  readonly kind = 'moss' as const
  readonly capabilities: TextToSpeechCapabilities = { streaming: true, pcm: true, viseme: false, voiceClone: false }
  #state: VoiceRuntimeState = 'cold'
  #process: ChildProcessWithoutNullStreams | undefined
  #readline: Interface | undefined
  #ready: Promise<void> | undefined
  #pending = new Map<string, PendingRequest>()
  #voices: string[] = []

  constructor(private readonly modelRoot: string, private readonly options: MossTtsProviderOptions = {}) {}

  get state(): VoiceRuntimeState { return this.#state }
  get voices(): readonly string[] { return this.#voices }
  get processId(): number | undefined { return this.#process?.pid }

  async prepare(): Promise<void> {
    await this.#ensureProcess()
  }

  async *synthesize(request: TtsRequest): AsyncIterable<AudioChunk> {
    await this.#ensureProcess()
    if (request.signal?.aborted === true) throw abortError('MOSS 语音生成已取消')
    this.#state = 'busy'
    const queue = new AsyncQueue<AudioChunk>()
    const abort = () => this.cancel(request.requestId)
    request.signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => this.#terminate(abortError('MOSS 语音生成超时')), this.options.requestTimeoutMs ?? 60_000)
    this.#pending.set(request.requestId, {
      queue,
      timeout,
      detachAbort: () => request.signal?.removeEventListener('abort', abort),
      sampleRate: 48_000,
      nextSequence: 0,
    })
    const voice = request.voiceId.startsWith('moss:') ? request.voiceId.slice('moss:'.length) : this.#voices[0] ?? 'Junhao'
    // Speed is deliberately absent: the sidecar synthesises at its own rate
    // and has no parameter for it, so playback rate is where MOSS speed is
    // applied (see KokoroSpeechAdapter). Sending it here would look like it
    // did something.
    this.#process!.stdin.write(`${JSON.stringify({ id: request.requestId, text: request.text, voice })}\n`, (error) => {
      if (error !== null && error !== undefined) this.#terminate(error)
    })
    try {
      for await (const chunk of queue) yield chunk
    } finally {
      if (this.#pending.has(request.requestId)) this.cancel(request.requestId)
      else this.#finishRequest(request.requestId)
    }
  }

  /**
   * Stops caring about one request, or shuts everything down.
   *
   * Cancelling one used to kill the Python runtime and start it again, so
   * every barge-in cost a full model reload before the character could answer
   * — which is most of what made a spoken conversation impossible. The sidecar
   * has no cancellation protocol and cannot be interrupted mid-utterance, so
   * the request is abandoned instead: it finishes into nothing, which costs a
   * second of CPU rather than a restart, and the next reply starts straight
   * away.
   */
  cancel(requestId?: string): void {
    const error = abortError('MOSS 语音生成已取消')
    if (requestId === undefined) {
      this.#terminate(error)
      return
    }
    const pending = this.#pending.get(requestId)
    if (pending === undefined) return
    // The consumer is told; the sidecar is left to finish into nothing, since
    // it has no way to be interrupted mid-utterance.
    pending.queue.fail(error)
    this.#finishRequest(requestId)
  }

  async dispose(): Promise<void> {
    this.cancel()
    this.#terminate(abortError('MOSS 语音运行时已关闭'))
  }

  async #ensureProcess(): Promise<void> {
    if (this.#ready !== undefined) return this.#ready
    this.#state = 'warming'
    const runtimePython = this.options.executable ?? (process.platform === 'win32'
      ? join(this.modelRoot, 'runtime', '.venv', 'Scripts', 'python.exe')
      : join(this.modelRoot, 'runtime', '.venv', 'bin', 'python'))
    const sidecar = this.options.sidecar ?? fileURLToPath(new URL('../../../runtime/moss-tts-sidecar.py', import.meta.url))
    const runtimeRoot = join(this.modelRoot, 'runtime')
    const loading = (async () => {
      await stat(runtimePython)
      const child = spawn(runtimePython, [sidecar, '--model-root', this.modelRoot, '--runtime-root', runtimeRoot], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      this.#process = child
      this.#readline = createInterface({ input: child.stdout })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('MOSS 语音运行时启动超时')), this.options.startupTimeoutMs ?? 60_000)
        const onLine = (line: string) => {
          let message: Record<string, unknown>
          try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
          if (message.type !== 'ready') return
          clearTimeout(timeout)
          this.#voices = Array.isArray(message.voices) ? message.voices.filter((voice): voice is string => typeof voice === 'string') : []
          this.#readline!.off('line', onLine)
          this.#readline!.on('line', (value) => this.#handleLine(value))
          resolve()
        }
        this.#readline!.on('line', onLine)
        child.once('error', reject)
        child.once('exit', (code) => reject(new Error(`MOSS 语音运行时提前退出（${code ?? 'unknown'}）`)))
      })
      this.#state = 'ready'
    })()
    this.#ready = loading
    void loading.catch((error) => { this.#state = 'failed'; this.#terminate(error) })
    return loading
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    const id = typeof message.id === 'string' ? message.id : undefined
    if (id === undefined) return
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    if (message.type === 'error') {
      pending.queue.fail(new Error(typeof message.message === 'string' ? message.message : 'MOSS 语音生成失败'))
      this.#finishRequest(id)
      return
    }
    if (message.type === 'done') {
      const sequence = Number.isInteger(message.sequence) ? message.sequence as number : pending.nextSequence
      pending.queue.push({ sequence, pcm: new Float32Array(0), sampleRate: pending.sampleRate, durationMs: 0, final: true })
      pending.queue.close()
      this.#finishRequest(id)
      return
    }
    if (message.type !== 'audio' || typeof message.pcmBase64 !== 'string' || typeof message.sampleRate !== 'number') {
      pending.queue.fail(new Error('MOSS 语音运行时返回无效数据'))
      this.#finishRequest(id)
      return
    }
    const buffer = Buffer.from(message.pcmBase64, 'base64')
    const view = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
    const sequence = Number.isInteger(message.sequence) ? message.sequence as number : pending.nextSequence
    const pcm = new Float32Array(view)
    pending.sampleRate = message.sampleRate
    pending.nextSequence = sequence + 1
    pending.queue.push({ sequence, pcm, sampleRate: message.sampleRate, durationMs: pcm.length / message.sampleRate * 1000, final: false })
  }

  #finishRequest(id: string): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timeout)
    pending.detachAbort()
    this.#pending.delete(id)
    if (this.#process !== undefined && this.#pending.size === 0) this.#state = 'ready'
  }

  #terminate(error: unknown): void {
    this.#readline?.close(); this.#readline = undefined
    this.#process?.kill(); this.#process = undefined
    this.#ready = undefined
    this.#state = 'cold'
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.detachAbort()
      pending.queue.fail(error)
    }
    this.#pending.clear()
  }
}

function abortError(message: string): Error { const error = new Error(message); error.name = 'AbortError'; return error }
