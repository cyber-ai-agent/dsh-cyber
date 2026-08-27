import { randomUUID } from 'node:crypto'

import type { CompletionJob } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { AgentRunCompletionContribution } from '@dsh-cyber/orchestration'

export type CompletionJobHandler = (job: CompletionJob) => Promise<AgentRunCompletionContribution>

export interface CompletionWorkerOptions {
  store: SqliteStore
  handlers: ReadonlyMap<string, CompletionJobHandler>
  owner?: string
  leaseDurationMs?: number
  pollIntervalMs?: number
  retryBaseMs?: number
  maxAttempts?: number
  clock?: () => Date
}

/** Durable, bounded worker for post-answer artifact and indexing work. */
export class CompletionWorker {
  readonly #store: SqliteStore
  readonly #handlers: ReadonlyMap<string, CompletionJobHandler>
  readonly #owner: string
  readonly #leaseDurationMs: number
  readonly #pollIntervalMs: number
  readonly #retryBaseMs: number
  readonly #maxAttempts: number
  readonly #clock: () => Date
  readonly #active = new Set<Promise<void>>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #started = false
  #closing = false
  #dispatching = false

  constructor(options: CompletionWorkerOptions) {
    this.#store = options.store
    this.#handlers = options.handlers
    this.#owner = options.owner ?? `completion-worker-${randomUUID()}`
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000
    this.#retryBaseMs = options.retryBaseMs ?? 1_000
    this.#maxAttempts = options.maxAttempts ?? 3
    this.#clock = options.clock ?? (() => new Date())
  }

  start(): void {
    if (this.#started || this.#closing) return
    this.#started = true
    this.#store.recoverCompletionJobsAfterRestart()
    this.wake()
  }

  wake(): void {
    if (!this.#started || this.#closing) return
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.dispatchOnce()
    }, 0)
  }

  async dispatchOnce(): Promise<boolean> {
    if (this.#closing || this.#dispatching) return false
    this.#dispatching = true
    try {
      const job = this.#store.claimCompletionJob(this.#owner, this.#leaseDurationMs)
      if (job === undefined) {
        this.#schedulePoll()
        return false
      }
      const running = this.#run(job)
      this.#active.add(running)
      void running.finally(() => {
        this.#active.delete(running)
        if (!this.#closing) this.wake()
      })
      return true
    } finally {
      this.#dispatching = false
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    await Promise.allSettled([...this.#active])
  }

  async #run(job: CompletionJob): Promise<void> {
    const handler = this.#handlers.get(job.type)
    if (handler === undefined) {
      this.#store.failCompletionJob(job.id, this.#owner, 'completion_handler_unavailable')
      return
    }
    const renewal = setInterval(() => {
      try { this.#store.renewCompletionJob(job.id, this.#owner, this.#leaseDurationMs) } catch { /* settlement or shutdown won */ }
    }, Math.max(100, Math.floor(this.#leaseDurationMs / 3)))
    try {
      const contribution = await handler(job)
      this.#store.completeCompletionJob(job.id, this.#owner, contribution)
    } catch (error) {
      const errorCode = completionErrorCode(error)
      if (job.attemptCount < this.#maxAttempts) {
        const delay = this.#retryBaseMs * 2 ** Math.max(0, job.attemptCount - 1)
        const availableAt = new Date(this.#clock().getTime() + delay).toISOString()
        this.#store.retryCompletionJob(job.id, this.#owner, errorCode, availableAt)
      } else {
        this.#store.failCompletionJob(job.id, this.#owner, errorCode)
      }
    } finally {
      clearInterval(renewal)
    }
  }

  #schedulePoll(): void {
    if (this.#closing || !this.#started || this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.dispatchOnce()
    }, this.#pollIntervalMs)
  }
}

function completionErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return sanitize(error.code)
  if (error instanceof Error) return sanitize(error.name || 'completion_failed')
  return 'completion_failed'
}

function sanitize(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9_-]+/g, '_').slice(0, 120) || 'completion_failed'
}
