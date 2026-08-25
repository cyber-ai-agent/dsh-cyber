import type { EmployeeInstance } from '@dsh-cyber/contracts'

import type { WorldKnowledgeRetrievalService, WorldKnowledgeRuntimeContext } from './world-knowledge-retrieval-service.js'

export type RuntimeContextTrust = 'host-fact' | 'internal-knowledge' | 'external-untrusted'

export interface RuntimeContextInput {
  worldId: string
  prompt: string
  characterId?: string
  group: boolean
}

export interface RuntimeContextSection {
  id: string
  text: string
  trust: RuntimeContextTrust
  order?: number
}

export interface RuntimeContextContributor {
  readonly id: string
  contribute(input: RuntimeContextInput): Promise<RuntimeContextSection | undefined> | RuntimeContextSection | undefined
}

export interface WorldRuntimePromptComposer {
  composeRuntimePrompt(worldId: string, character: EmployeeInstance, prompt: string): Promise<string>
  composeGroupRuntimePrompt(worldId: string, prompt: string): Promise<string>
}

export interface ComposedRuntimeContext {
  prompt: string
  sections: RuntimeContextSection[]
}

/** Provider-neutral seam for world settings, identity, knowledge and facts. */
export class WorldRuntimeContextComposer {
  readonly #contributors: readonly RuntimeContextContributor[]
  readonly #settings: WorldRuntimePromptComposer | undefined

  constructor(options: readonly RuntimeContextContributor[] | {
    contributors?: readonly RuntimeContextContributor[]
    settings?: WorldRuntimePromptComposer
  } = []) {
    const configured = Array.isArray(options)
      ? undefined
      : options as {
          contributors?: readonly RuntimeContextContributor[]
          settings?: WorldRuntimePromptComposer
        }
    const contributors = configured?.contributors ?? options as readonly RuntimeContextContributor[]
    const ids = new Set<string>()
    for (const contributor of contributors) {
      if (!contributor.id.trim() || ids.has(contributor.id)) throw new Error(`Duplicate runtime context contributor: ${contributor.id}`)
      ids.add(contributor.id)
    }
    this.#contributors = [...contributors]
    this.#settings = configured?.settings
  }

  async compose(input: RuntimeContextInput): Promise<ComposedRuntimeContext> {
    const sections: RuntimeContextSection[] = []
    for (const contributor of this.#contributors) {
      const section = await contributor.contribute(input)
      if (section === undefined || !section.text.trim()) continue
      sections.push({ ...section, id: contributor.id, text: capSection(section.text, 12_000) })
    }
    sections.sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
    const context = sections.map((section) => section.text).join('\n\n')
    return {
      prompt: [context, '[用户请求]', input.prompt.trim()].filter(Boolean).join('\n\n'),
      sections,
    }
  }

  async composePrompt(input: RuntimeContextInput): Promise<string> {
    return (await this.compose(input)).prompt
  }

  async composeRuntimePrompt(worldId: string, character: EmployeeInstance, prompt: string): Promise<string> {
    const contributed = await this.#contributedText({ worldId, characterId: character.id, prompt, group: false })
    const request = [contributed, prompt.trim()].filter(Boolean).join('\n\n')
    return this.#settings === undefined
      ? ['[用户请求]', request].join('\n')
      : this.#settings.composeRuntimePrompt(worldId, character, request)
  }

  async composeGroupRuntimePrompt(worldId: string, prompt: string): Promise<string> {
    const contributed = await this.#contributedText({ worldId, prompt, group: true })
    const request = [contributed, prompt.trim()].filter(Boolean).join('\n\n')
    return this.#settings === undefined
      ? ['[用户请求]', request].join('\n')
      : this.#settings.composeGroupRuntimePrompt(worldId, request)
  }

  async #contributedText(input: RuntimeContextInput): Promise<string> {
    const sections: RuntimeContextSection[] = []
    for (const contributor of this.#contributors) {
      const section = await contributor.contribute(input)
      if (section === undefined || !section.text.trim()) continue
      sections.push({ ...section, id: contributor.id, text: capSection(section.text, 12_000) })
    }
    sections.sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
    return sections.map((section) => section.text).join('\n\n')
  }
}

/** Optional contributor used by the chat hot path: one local search, no LLM rewrite. */
export class WorldKnowledgeRuntimeContextContributor implements RuntimeContextContributor {
  readonly id = 'knowledge-retrieval'
  readonly #retrieval: WorldKnowledgeRetrievalService
  readonly #onRetrieved: ((input: RuntimeContextInput, context: WorldKnowledgeRuntimeContext) => void) | undefined

  constructor(
    retrieval: WorldKnowledgeRetrievalService,
    onRetrieved?: (input: RuntimeContextInput, context: WorldKnowledgeRuntimeContext) => void,
  ) {
    this.#retrieval = retrieval
    this.#onRetrieved = onRetrieved
  }

  async contribute(input: RuntimeContextInput): Promise<RuntimeContextSection | undefined> {
    const context = await this.#retrieval.retrieve({ worldId: input.worldId, query: input.prompt, limit: 6, budgetChars: 6_000 })
    if (context !== undefined) this.#onRetrieved?.(input, context)
    return context === undefined ? undefined : { id: this.id, text: context.text, trust: 'external-untrusted', order: 80 }
  }
}

export function runtimeContextFromKnowledge(context: WorldKnowledgeRuntimeContext | undefined): RuntimeContextSection | undefined {
  return context === undefined ? undefined : { id: 'knowledge-retrieval', text: context.text, trust: 'external-untrusted', order: 80 }
}

function capSection(value: string, maximum: number): string {
  const text = value.trim()
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`
}
