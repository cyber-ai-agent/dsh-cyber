import type { JsonObject } from '@dsh-cyber/contracts'
import type {
  CharacterSkillAction,
  CharacterSkillDescriptor,
  SkillActionAuthorization,
  SkillActionRisk,
  SkillActionStatus,
} from '@dsh-cyber/contracts/skill-runtime'

export interface CharacterSkillMatchContext {
  worldId: string
  characterId: string
  prompt: string
  grantedSkillIds: readonly string[]
  now: Date
}

export interface CharacterSkillActionProposal {
  skillId: string
  adapterId: string
  action: string
  target: string
  label: string
  risk: SkillActionRisk
  authorization: SkillActionAuthorization
  parameters?: JsonObject
  scheduledFor?: string
}

export interface CharacterSkillExecutionContext {
  now: Date
}

export interface CharacterSkillExecutionResult {
  status: Extract<SkillActionStatus, 'executed' | 'waiting-for-integration' | 'failed' | 'outcome-unknown'>
  detail: string
}

export interface CharacterSkillRecipe {
  descriptor: CharacterSkillDescriptor
  /** Host-reviewed instruction only. It cannot contain executable callbacks or credentials. */
  instruction: string
}

/**
 * Trusted host-side execution seam. Third-party packages may request a skill id,
 * but they never receive this interface and cannot execute arbitrary code through it.
 */
export interface CharacterSkillAdapter {
  readonly id: string
  readonly descriptors: readonly CharacterSkillDescriptor[]
  /** Dynamic adapters (for example MCP) may expose no skills until discovery completes. */
  readonly dynamicDescriptors?: boolean
  propose(context: CharacterSkillMatchContext): Promise<CharacterSkillActionProposal[]> | CharacterSkillActionProposal[]
  execute(action: CharacterSkillAction, context: CharacterSkillExecutionContext): Promise<CharacterSkillExecutionResult>
  /** Remove encrypted or ephemeral inputs when an action will never execute. */
  discard?(action: CharacterSkillAction): Promise<void>
}

/**
 * Registry inspired by Harness provider registries: adapters register beside the
 * runtime, while the orchestration layer depends only on this stable interface.
 */
export class CharacterSkillAdapterRegistry {
  readonly #adapters = new Map<string, CharacterSkillAdapter>()
  readonly #skills = new Map<string, CharacterSkillAdapter>()
  readonly #recipes = new Map<string, CharacterSkillRecipe>()

  registerRecipe(recipe: CharacterSkillRecipe): () => void {
    const { descriptor } = recipe
    if (!descriptor.id.trim()) throw new Error('Skill recipe id cannot be empty')
    if (!recipe.instruction.trim()) throw new Error(`Skill recipe ${descriptor.id} instruction cannot be empty`)
    if (this.#skills.has(descriptor.id) || this.#recipes.has(descriptor.id)) {
      throw new Error(`Duplicate skill provider: ${descriptor.id}`)
    }
    if (descriptor.kind !== 'recipe') throw new Error(`Skill recipe ${descriptor.id} must use kind=recipe`)
    if (descriptor.risks.length > 0 || descriptor.supportsScheduling) {
      throw new Error(`Skill recipe ${descriptor.id} cannot declare execution risks or scheduling`)
    }
    this.#recipes.set(descriptor.id, recipe)
    return () => { if (this.#recipes.get(descriptor.id) === recipe) this.#recipes.delete(descriptor.id) }
  }

  register(adapter: CharacterSkillAdapter): () => void {
    if (!adapter.id.trim()) throw new Error('Skill adapter id cannot be empty')
    if (this.#adapters.has(adapter.id)) throw new Error(`Duplicate skill adapter: ${adapter.id}`)
    if (adapter.descriptors.length === 0 && adapter.dynamicDescriptors !== true) throw new Error(`Skill adapter ${adapter.id} must expose at least one skill`)

    for (const descriptor of adapter.descriptors) {
      if (!descriptor.id.trim()) throw new Error(`Skill adapter ${adapter.id} contains an empty skill id`)
      if (descriptor.adapterId !== adapter.id) {
        throw new Error(`Skill ${descriptor.id} points at ${descriptor.adapterId}, expected ${adapter.id}`)
      }
      if (this.#skills.has(descriptor.id) || this.#recipes.has(descriptor.id)) throw new Error(`Duplicate skill provider: ${descriptor.id}`)
    }

    this.#adapters.set(adapter.id, adapter)
    for (const descriptor of adapter.descriptors) this.#skills.set(descriptor.id, adapter)

    return () => {
      if (this.#adapters.get(adapter.id) !== adapter) return
      this.#adapters.delete(adapter.id)
      for (const descriptor of adapter.descriptors) {
        if (this.#skills.get(descriptor.id) === adapter) this.#skills.delete(descriptor.id)
      }
    }
  }

  /** Re-index a registered dynamic adapter after trusted capability discovery. */
  refresh(adapter: CharacterSkillAdapter): void {
    if (adapter.dynamicDescriptors !== true || this.#adapters.get(adapter.id) !== adapter) {
      throw new Error(`Skill adapter ${adapter.id} is not a registered dynamic adapter`)
    }
    const previous = [...this.#skills.entries()].filter(([, owner]) => owner === adapter).map(([skillId]) => skillId)
    for (const skillId of previous) this.#skills.delete(skillId)
    try {
      for (const descriptor of adapter.descriptors) {
        if (!descriptor.id.trim() || descriptor.adapterId !== adapter.id) throw new Error(`Invalid dynamic skill descriptor: ${descriptor.id}`)
        const owner = this.#skills.get(descriptor.id)
        if (owner !== undefined && owner !== adapter || this.#recipes.has(descriptor.id)) throw new Error(`Duplicate skill provider: ${descriptor.id}`)
        this.#skills.set(descriptor.id, adapter)
      }
    } catch (error) {
      for (const [skillId, owner] of [...this.#skills]) if (owner === adapter) this.#skills.delete(skillId)
      for (const skillId of previous) this.#skills.set(skillId, adapter)
      throw error
    }
  }

  list(): CharacterSkillDescriptor[] {
    return [
      ...[...this.#adapters.values()]
      .flatMap((adapter) => adapter.descriptors)
      .map((descriptor) => ({ ...descriptor, kind: descriptor.kind ?? 'integration' as const, risks: [...descriptor.risks] })),
      ...[...this.#recipes.values()].map(({ descriptor }) => ({ ...descriptor, risks: [...descriptor.risks] })),
    ]
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN') || left.id.localeCompare(right.id))
  }

  instructionsFor(skillIds: readonly string[]): string[] {
    return skillIds.flatMap((skillId) => {
      const recipe = this.#recipes.get(skillId)
      return recipe === undefined ? [] : [`${recipe.descriptor.displayName}：${recipe.instruction.trim()}`]
    })
  }

  adapterById(adapterId: string): CharacterSkillAdapter | undefined {
    return this.#adapters.get(adapterId)
  }

  adapterForSkill(skillId: string): CharacterSkillAdapter | undefined {
    return this.#skills.get(skillId)
  }

  async propose(context: CharacterSkillMatchContext): Promise<CharacterSkillActionProposal[]> {
    const grants = new Set(context.grantedSkillIds)
    const adapters = new Set<CharacterSkillAdapter>()
    for (const skillId of grants) {
      const adapter = this.#skills.get(skillId)
      if (adapter !== undefined) adapters.add(adapter)
    }

    const proposals: CharacterSkillActionProposal[] = []
    for (const adapter of adapters) {
      for (const proposal of await adapter.propose(context)) {
        if (!grants.has(proposal.skillId)) continue
        if (proposal.adapterId !== adapter.id) {
          throw new Error(`Skill proposal ${proposal.skillId} escaped adapter ${adapter.id}`)
        }
        if (this.#skills.get(proposal.skillId) !== adapter) {
          throw new Error(`Skill proposal ${proposal.skillId} is not registered by adapter ${adapter.id}`)
        }
        proposals.push({ ...proposal, parameters: proposal.parameters ?? {} })
      }
    }
    return proposals
  }
}
