import type { AmbientWorldPolicy } from '@dsh-cyber/world-simulation'

import type { AmbientLifeTickResult } from './role-aware-ambient-life-service.js'

export interface AmbientLifePlanningPort {
  tick(worldId: string, policy?: Partial<AmbientWorldPolicy>): Promise<AmbientLifeTickResult>
}

export interface AmbientLifeExecutionPort {
  completeDue(worldId: string, now?: string): string[]
  start(result: AmbientLifeTickResult): string[]
}

export interface AmbientLifeRuntimeOptions {
  service: AmbientLifePlanningPort
  executor: AmbientLifeExecutionPort
  publish?: (worldId: string) => void
  clock?: () => string
}

/**
 * Runs one full world cycle in a strict order:
 * complete expired ambient work, create new bounded plans, append semantic
 * events, and only then publish the refreshed world snapshot.
 */
export class AmbientLifeRuntime {
  readonly #service: AmbientLifePlanningPort
  readonly #executor: AmbientLifeExecutionPort
  readonly #publish: ((worldId: string) => void) | undefined
  readonly #clock: () => string

  constructor(options: AmbientLifeRuntimeOptions) {
    this.#service = options.service
    this.#executor = options.executor
    this.#publish = options.publish
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  async tick(worldId: string, policy: Partial<AmbientWorldPolicy> = {}): Promise<AmbientLifeTickResult> {
    const completedEvents = this.#executor.completeDue(worldId, this.#clock())
    const result = await this.#service.tick(worldId, policy)
    const startedEvents = this.#executor.start(result)
    if (completedEvents.length > 0 || startedEvents.length > 0) this.#publish?.(worldId)
    return result
  }
}
