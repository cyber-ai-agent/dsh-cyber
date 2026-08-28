import type {
  GroupTurnPlan,
  GroupTurnPlanInput,
  GroupTurnPlannerPort,
} from '@dsh-cyber/orchestration'
import { normalizeGroupTurnPlan } from '@dsh-cyber/orchestration'

/**
 * A small host-side cache that lets the HTTP ingress decide the real speakers
 * before a durable queue entry reserves character lanes, while still letting
 * ConversationOrchestrator remain the only component that executes the plan.
 *
 * The chosen plan is also persisted on the user WorkMessage by the route. A
 * queued/recovered turn seeds it again immediately before execution, so this
 * cache is only an optimisation and never the source of truth.
 */
export class PreparedGroupTurnPlanner implements GroupTurnPlannerPort {
  readonly #inner: GroupTurnPlannerPort
  readonly #prepared = new Map<string, { plan: GroupTurnPlan; expiresAt: number }>()
  readonly #ttlMs: number
  readonly #maxEntries: number

  constructor(inner: GroupTurnPlannerPort, options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.#inner = inner
    this.#ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? 10 * 60_000))
    this.#maxEntries = Math.max(8, Math.floor(options.maxEntries ?? 128))
  }

  async prepare(input: GroupTurnPlanInput): Promise<GroupTurnPlan> {
    const plan = normalizeGroupTurnPlan(await this.#inner.plan(input), input.candidates)
    this.seed(input, plan)
    return plan
  }

  seed(
    input: Pick<GroupTurnPlanInput, 'workspaceId' | 'worldId' | 'sessionId' | 'prompt'>,
    plan: GroupTurnPlan,
  ): void {
    this.#prune()
    const key = planKey(input)
    this.#prepared.set(key, { plan, expiresAt: Date.now() + this.#ttlMs })
    while (this.#prepared.size > this.#maxEntries) {
      const oldest = this.#prepared.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#prepared.delete(oldest)
    }
  }

  async plan(input: GroupTurnPlanInput): Promise<GroupTurnPlan> {
    this.#prune()
    const key = planKey(input)
    const prepared = this.#prepared.get(key)
    if (prepared !== undefined) {
      this.#prepared.delete(key)
      return normalizeGroupTurnPlan(prepared.plan, input.candidates)
    }
    return normalizeGroupTurnPlan(await this.#inner.plan(input), input.candidates)
  }

  #prune(): void {
    const now = Date.now()
    for (const [key, value] of this.#prepared) {
      if (value.expiresAt <= now) this.#prepared.delete(key)
    }
  }
}

function planKey(input: Pick<GroupTurnPlanInput, 'workspaceId' | 'worldId' | 'sessionId' | 'prompt'>): string {
  return `${input.workspaceId}\u0000${input.worldId}\u0000${input.sessionId}\u0000${input.prompt}`
}
