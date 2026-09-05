import type {
  KnowledgeEvidenceInvalidationResult,
  KnowledgeSourceVersion,
} from '@dsh-cyber/contracts'

/** A world reference is resolved by the host, never supplied by a chat client. */
export interface KnowledgeInvalidationWorld {
  workspaceId: string
  worldId: string
}

export interface KnowledgeEvidenceInvalidationRepository {
  listWorlds(): readonly KnowledgeInvalidationWorld[] | Promise<readonly KnowledgeInvalidationWorld[]>
  /** Supersede the versions of sources the world no longer holds. */
  retireRemovedKnowledgeSources(worldId: string, limit: number): readonly KnowledgeSourceVersion[] | Promise<readonly KnowledgeSourceVersion[]>
  /** Release statements whose source version is current again. */
  reinstateCurrentKnowledgeSourceVersions(worldId: string): { claims: number; relations: number } | Promise<{ claims: number; relations: number }>
  listPendingKnowledgeSourceInvalidations(worldId: string, limit: number): readonly KnowledgeSourceVersion[] | Promise<readonly KnowledgeSourceVersion[]>
  invalidateKnowledgeSourceVersion(input: {
    workspaceId: string
    worldId: string
    sourceType: KnowledgeSourceVersion['sourceType']
    sourceId: string
    contentHash: string
  }): KnowledgeEvidenceInvalidationResult | Promise<KnowledgeEvidenceInvalidationResult>
}

export interface WorldKnowledgeEvidenceInvalidationOptions {
  repository: KnowledgeEvidenceInvalidationRepository
  /** Superseded versions reconsidered per world per run (1-200, default 20). */
  maxVersionsPerRun?: number
  intervalMs?: number
  onChanged?: (worldId: string, payload: Record<string, unknown>) => void
  onError?: (error: unknown) => void
}

export interface KnowledgeEvidenceInvalidationRun {
  worlds: number
  /** Sources whose version was superseded because the source itself is gone. */
  retired: number
  /** Superseded versions reconsidered in this run. */
  versions: number
  claims: number
  relations: number
  /** Statements released because their source version became current again. */
  reinstated: number
}

/**
 * Turns "this revision is gone" into "this claim is no longer current".
 *
 * The chunk-cursor work records that a source version was superseded and
 * deliberately leaves its claims alone; this pass is the explicit decision that
 * was left open. For each superseded version it downgrades exactly the
 * statements whose every supporting evidence went away with it, so the product
 * stops asserting what it can no longer support — and downgrades nothing else,
 * so it never destroys what the owner gathered.
 *
 * It is deliberately a separate loop from the consolidation scanner: this is
 * database work that must not compete with extraction cadence or fairness, and
 * a world with no superseded versions costs one indexed query. Each run is
 * bounded, each version is its own transaction, and a run that dies halfway
 * leaves every version it finished marked — so the next run resumes at the one
 * it never reached and, once there is nothing left, changes nothing at all.
 */
export class WorldKnowledgeEvidenceInvalidationService {
  readonly #repository: KnowledgeEvidenceInvalidationRepository
  readonly #maxVersionsPerRun: number
  readonly #intervalMs: number
  readonly #onChanged: WorldKnowledgeEvidenceInvalidationOptions['onChanged']
  readonly #onError: WorldKnowledgeEvidenceInvalidationOptions['onError']
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false

  constructor(options: WorldKnowledgeEvidenceInvalidationOptions) {
    this.#repository = options.repository
    this.#maxVersionsPerRun = clampCount(options.maxVersionsPerRun, 20, 1, 200)
    this.#intervalMs = Math.max(5_000, Math.floor(options.intervalMs ?? 60_000))
    this.#onChanged = options.onChanged
    this.#onError = options.onError
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => { void this.runOnce().catch((error) => this.#onError?.(error)) }, this.#intervalMs)
    const timer = this.#timer as { unref?: () => void }
    timer.unref?.()
    void this.runOnce().catch((error) => this.#onError?.(error))
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async runOnce(worldId?: string): Promise<KnowledgeEvidenceInvalidationRun> {
    const empty: KnowledgeEvidenceInvalidationRun = { worlds: 0, retired: 0, versions: 0, claims: 0, relations: 0, reinstated: 0 }
    if (this.#running) return empty
    this.#running = true
    try {
      const worlds = (await this.#repository.listWorlds()).filter((world) => worldId === undefined || world.worldId === worldId)
      const total = { ...empty, worlds: worlds.length }
      for (const world of worlds) {
        // Deletion and archival travel the same seam as a content edit: the
        // version is superseded first, then downgraded by the same pass.
        total.retired += (await this.#repository.retireRemovedKnowledgeSources(world.worldId, this.#maxVersionsPerRun)).length
        const reinstated = await this.#repository.reinstateCurrentKnowledgeSourceVersions(world.worldId)
        total.reinstated += reinstated.claims + reinstated.relations
        let changed = reinstated.claims + reinstated.relations
        for (const version of await this.#repository.listPendingKnowledgeSourceInvalidations(world.worldId, this.#maxVersionsPerRun)) {
          const result = await this.#repository.invalidateKnowledgeSourceVersion({
            workspaceId: world.workspaceId,
            worldId: world.worldId,
            sourceType: version.sourceType,
            sourceId: version.sourceId,
            contentHash: version.contentHash,
          })
          total.versions += 1
          total.claims += result.claims
          total.relations += result.relations
          changed += result.claims + result.relations
        }
        if (changed > 0) this.#onChanged?.(world.worldId, { type: 'knowledge.graph.changed', reason: 'evidence-invalidation' })
      }
      return total
    } finally {
      this.#running = false
    }
  }
}

function clampCount(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value)))
}
