import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'

export interface VoiceSessionEvent {
  type: 'prepared' | 'listening' | 'speech-start' | 'partial' | 'final' | 'speech-end' | 'stopped' | 'cancelled' | 'error'
  sessionId?: string
  utteranceId?: string
  text?: string
  receivedAt?: number
  audioDurationMs?: number
  message?: string
}

export class VoiceSessionManager {
  #worker: Worker | undefined
  readonly #modelRoot: string
  readonly #events = new EventEmitter()
  readonly #pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  readonly #fastSpeech = new Map<string, { energeticFrames: number; active: boolean }>()
  readonly #activeSessions = new Set<string>()
  #idleTimer: NodeJS.Timeout | undefined

  constructor(stateRoot: string) {
    this.#modelRoot = join(stateRoot, 'voice', 'stt', 'streaming-paraformer-bilingual-zh-en-int8')
  }

  async prepare(): Promise<void> {
    const requestId = randomUUID()
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new Error('本地语音识别模型加载超时')) }, 15_000)
      this.#pending.set(requestId, { resolve, reject, timer })
    })
    this.#ensureWorker().postMessage({ type: 'prepare', requestId })
    return promise
  }

  start(sessionId: string, endpointSilenceMs: number): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined; this.#activeSessions.add(sessionId)
    this.#fastSpeech.set(sessionId, { energeticFrames: 0, active: false })
    this.#ensureWorker().postMessage({ type: 'start', sessionId, endpointSilenceMs })
  }

  pushAudio(sessionId: string, pcm: Int16Array, timestamp: number): void {
    const fast = this.#fastSpeech.get(sessionId)
    if (fast !== undefined) {
      let energy = 0
      for (const sample of pcm) { const normalized = sample / 32_768; energy += normalized * normalized }
      fast.energeticFrames = Math.sqrt(energy / Math.max(1, pcm.length)) >= 0.008 ? fast.energeticFrames + 1 : 0
      if (fast.energeticFrames >= 3 && !fast.active) {
        fast.active = true
        this.#events.emit('event', { type: 'speech-start', sessionId, utteranceId: `${sessionId}:fast`, receivedAt: timestamp } satisfies VoiceSessionEvent)
      }
    }
    const copy = pcm.slice().buffer
    this.#ensureWorker().postMessage({ type: 'audio', sessionId, pcm: copy, timestamp }, [copy])
  }

  stop(sessionId: string): void { this.#fastSpeech.delete(sessionId); this.#activeSessions.delete(sessionId); this.#worker?.postMessage({ type: 'stop', sessionId }); this.#scheduleIdleUnload() }
  cancel(sessionId: string): void { this.#fastSpeech.delete(sessionId); this.#activeSessions.delete(sessionId); this.#worker?.postMessage({ type: 'cancel', sessionId }); this.#scheduleIdleUnload() }
  onEvent(listener: (event: VoiceSessionEvent) => void): () => void { this.#events.on('event', listener); return () => this.#events.off('event', listener) }

  async close(): Promise<void> {
    this.#failAll(new Error('Voice runtime closed'))
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    await this.#worker?.terminate()
    this.#worker = undefined
  }

  #ensureWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker
    const worker = new Worker(new URL('./voice-worker.js', import.meta.url), { workerData: { modelRoot: this.#modelRoot } })
    worker.on('message', (event: VoiceSessionEvent & { requestId?: string }) => this.#receive(event))
    worker.on('error', (error) => this.#failAll(error))
    worker.on('exit', (code) => { if (this.#worker === worker) this.#worker = undefined; if (code !== 0) this.#failAll(new Error(`Voice worker exited with code ${code}`)) })
    this.#worker = worker
    return worker
  }

  #scheduleIdleUnload(): void {
    if (this.#activeSessions.size > 0 || this.#worker === undefined) return
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      if (this.#activeSessions.size > 0 || this.#worker === undefined) return
      const worker = this.#worker; this.#worker = undefined; void worker.terminate()
    }, 5 * 60_000)
    this.#idleTimer.unref()
  }

  #receive(event: VoiceSessionEvent & { requestId?: string }): void {
    if (event.type === 'prepared' && event.requestId !== undefined) {
      const pending = this.#pending.get(event.requestId)
      if (pending !== undefined) { clearTimeout(pending.timer); this.#pending.delete(event.requestId); pending.resolve() }
      return
    }
    if (event.type === 'error' && event.requestId !== undefined) {
      const pending = this.#pending.get(event.requestId)
      if (pending !== undefined) { clearTimeout(pending.timer); this.#pending.delete(event.requestId); pending.reject(new Error(event.message ?? 'Voice worker failed')) }
    }
    if (event.sessionId !== undefined && event.type === 'speech-start') {
      const fast = this.#fastSpeech.get(event.sessionId)
      if (fast?.active) return
      if (fast !== undefined) fast.active = true
    }
    if (event.sessionId !== undefined && event.type === 'speech-end') {
      const fast = this.#fastSpeech.get(event.sessionId)
      if (fast !== undefined) { fast.active = false; fast.energeticFrames = 0 }
    }
    this.#events.emit('event', event)
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.#pending.clear()
    this.#events.emit('event', { type: 'error', message: error.message } satisfies VoiceSessionEvent)
  }
}
