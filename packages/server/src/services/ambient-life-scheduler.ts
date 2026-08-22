import type { WorldAmbientLifeSettings } from './ambient-life-settings-service.js'
import type { AmbientLifeTickResult, RoleAwareAmbientLifeService } from './role-aware-ambient-life-service.js'

export interface AmbientLifeSettingsReader {
  listEnabled(): WorldAmbientLifeSettings[]
}

export interface AmbientLifeSchedulerOptions {
  settings: AmbientLifeSettingsReader
  service: RoleAwareAmbientLifeService
  intervalMs?: number
  onResult?: (result: AmbientLifeTickResult) => void
  onError?: (worldId: string, error: unknown) => void
}

const DEFAULT_INTERVAL_MS = 30_000

export class AmbientLifeScheduler implements AsyncDisposable {
  readonly #settings: AmbientLifeSettingsReader
  readonly #service: RoleAwareAmbientLifeService
  readonly #intervalMs: number
  readonly #onResult: ((result: AmbientLifeTickResult) => void) | undefined
  readonly #onError: ((worldId: string, error: unknown) => void) | undefined
  readonly #inFlight = new Set<string>()
  #timer: ReturnType<typeof setInterval> | undefined
  #closed = false

  constructor(options: AmbientLifeSchedulerOptions) {
    this.#settings = options.settings
    this.#service = options.service
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.#onResult = options.onResult
    this.#onError = options.onError
    if (!Number.isInteger(this.#intervalMs) || this.#intervalMs < 5_000 || this.#intervalMs > 300_000) {
      throw new Error('Ambient scheduler interval must be between 5 seconds and 5 minutes')
    }
  }

  start(): void {
    if (this.#closed) throw new Error('Ambient scheduler is closed')
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => {
      void this.runOnce()
    }, this.#intervalMs)
    this.#timer.unref?.()
  }

  async runOnce(): Promise<AmbientLifeTickResult[]> {
    if (this.#closed) return []
    const results: AmbientLifeTickResult[] = []
    for (const setting of this.#settings.listEnabled()) {
      if (this.#inFlight.has(setting.worldId)) continue
      this.#inFlight.add(setting.worldId)
      try {
        const result = await this.#service.tick(setting.worldId, setting)
        results.push(result)
        this.#onResult?.(result)
      } catch (error) {
        this.#onError?.(setting.worldId, error)
      } finally {
        this.#inFlight.delete(setting.worldId)
      }
    }
    return results
  }

  close(): Promise<void> {
    this.#closed = true
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    return Promise.resolve()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}
