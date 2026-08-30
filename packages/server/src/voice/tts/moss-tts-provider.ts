import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'

import type { AudioChunk, TextToSpeechCapabilities, TextToSpeechProvider, TtsRequest, VoiceRuntimeState } from '@dsh-cyber/contracts'

type PendingRequest = { resolve(value: MossAudio): void; reject(error: unknown): void; timeout: ReturnType<typeof setTimeout> }
type MossAudio = { sampleRate: number; pcm: Float32Array; voice: string }
type MossTtsProviderOptions = { executable?: string; sidecar?: string; requestTimeoutMs?: number; startupTimeoutMs?: number }

export class MossTtsProvider implements TextToSpeechProvider {
  readonly id = 'moss-tts-nano-local'
  readonly kind = 'moss' as const
  readonly capabilities: TextToSpeechCapabilities = { streaming: false, pcm: true, viseme: false, voiceClone: false }
  #state: VoiceRuntimeState = 'cold'
  #process: ChildProcessWithoutNullStreams | undefined
  #readline: Interface | undefined
  #ready: Promise<void> | undefined
  #pending = new Map<string, PendingRequest>()
  #voices: string[] = []

  constructor(private readonly modelRoot: string, private readonly options: MossTtsProviderOptions = {}) {}

  get state(): VoiceRuntimeState { return this.#state }
  get voices(): readonly string[] { return this.#voices }

  async prepare(): Promise<void> {
    await this.#ensureProcess()
  }

  async *synthesize(request: TtsRequest): AsyncIterable<AudioChunk> {
    await this.#ensureProcess()
    if (request.signal?.aborted === true) throw abortError('MOSS 语音生成已取消')
    this.#state = 'busy'
    const audio = await new Promise<MossAudio>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(request.requestId)
        this.#terminate(abortError('MOSS 语音生成超时'))
        reject(abortError('MOSS 语音生成超时'))
      }, this.options.requestTimeoutMs ?? 60_000)
      this.#pending.set(request.requestId, { resolve, reject, timeout })
      const abort = () => this.cancel(request.requestId)
      request.signal?.addEventListener('abort', abort, { once: true })
      const voice = request.voiceId.startsWith('moss:') ? request.voiceId.slice('moss:'.length) : this.#voices[0] ?? 'Junhao'
      this.#process!.stdin.write(`${JSON.stringify({ id: request.requestId, text: request.text, voice })}\n`, (error) => {
        if (error !== null && error !== undefined) reject(error)
      })
    })
    this.#state = 'ready'
    yield { sequence: 0, pcm: audio.pcm, sampleRate: audio.sampleRate, durationMs: audio.pcm.length / audio.sampleRate * 1000, final: true }
  }

  cancel(requestId?: string): void {
    const error = abortError('MOSS 语音生成已取消')
    if (requestId !== undefined) {
      const pending = this.#pending.get(requestId)
      if (pending === undefined) return
      clearTimeout(pending.timeout); this.#pending.delete(requestId); pending.reject(error)
    } else {
      for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(error) }
      this.#pending.clear()
    }
    this.#terminate(error)
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
      const child = spawn(runtimePython, [sidecar, '--model-root', this.modelRoot, '--runtime-root', runtimeRoot], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
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
    clearTimeout(pending.timeout)
    this.#pending.delete(id)
    if (message.type === 'error') { pending.reject(new Error(typeof message.message === 'string' ? message.message : 'MOSS 语音生成失败')); return }
    if (message.type !== 'audio' || typeof message.pcmBase64 !== 'string' || typeof message.sampleRate !== 'number') { pending.reject(new Error('MOSS 语音运行时返回无效数据')); return }
    const buffer = Buffer.from(message.pcmBase64, 'base64')
    const view = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
    pending.resolve({ sampleRate: message.sampleRate, pcm: new Float32Array(view), voice: typeof message.voice === 'string' ? message.voice : '' })
  }

  #terminate(error: unknown): void {
    this.#readline?.close(); this.#readline = undefined
    this.#process?.kill(); this.#process = undefined
    this.#ready = undefined
    this.#state = 'cold'
    for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(error) }
    this.#pending.clear()
  }
}

function abortError(message: string): Error { const error = new Error(message); error.name = 'AbortError'; return error }
