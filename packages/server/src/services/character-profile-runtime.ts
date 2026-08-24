import type {
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeProfile,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'

type CharacterRuntimeStore = Pick<
  SqliteStore,
  'getEmployee' | 'getEmployeeRevision' | 'getEmployeeProfile' | 'getWorld'
>

export class CharacterProfileRuntime implements AgentRuntimePort {
  readonly #inner: AgentRuntimePort
  readonly #store: CharacterRuntimeStore
  readonly #skills: Pick<CharacterSkillAdapterRegistry, 'instructionsFor'> | undefined

  constructor(inner: AgentRuntimePort, store: CharacterRuntimeStore, skills?: Pick<CharacterSkillAdapterRegistry, 'instructionsFor'>) {
    this.#inner = inner
    this.#store = store
    this.#skills = skills
  }

  runTurn(request: AgentTurnRequest) {
    // A multi-round collaboration can bind a persistent Agent session during an
    // earlier turn. Always reload the current character and revision so the next
    // turn resumes that session instead of using the stale object captured when
    // the conversation was planned.
    const agent = this.#store.getEmployee(request.agent.id) ?? request.agent
    const revision = this.#store.getEmployeeRevision(agent.id, agent.currentRevision)
      ?? request.revision
    const profile = this.#store.getEmployeeProfile(agent.id)

    const recipeInstructions = this.#skills?.instructionsFor(revision.skillGrants) ?? []
    const profiledPersona = profile === undefined ? revision.persona : composeCharacterPersona(revision.persona, profile)
    const persona = composeWorldAdministratorPersona(
      profiledPersona,
      this.#store.getWorld(agent.worldId)?.administratorEmployeeId === agent.id,
    )
    return this.#inner.runTurn({
      ...request,
      agent,
      revision: {
        ...revision,
        persona: composeSkillRecipes(persona, recipeInstructions),
      },
    })
  }

  close(): Promise<void> {
    return this.#inner.close()
  }
}

export function composeSkillRecipes(persona: string, instructions: readonly string[]): string {
  if (instructions.length === 0) return persona
  return `${persona.trim()}\n\n[已授权的工作方法]\n${instructions.map((item) => `- ${item}`).join('\n')}`
}

export function composeWorldAdministratorPersona(persona: string, isAdministrator: boolean): string {
  if (!isAdministrator) return persona
  return `${persona.trim()}\n\n[世界管理员职责]\n你是当前世界的管理员。你可以在明确授权的角色管理动作中调整本世界其他角色的设定与权限；不得读取或修改其他世界的角色。`
}

export function composeCharacterPersona(basePersona: string, profile: EmployeeProfile): string {
  const appearance = profile.appearance
  const relationshipToUser = textValue(appearance.relationshipToUser)
  const addressUserAs = textValue(appearance.addressUserAs)
  const selfReference = textValue(appearance.selfReference)
  const lines: string[] = []

  if (profile.background.trim()) lines.push(`背景：${profile.background.trim()}`)
  if (profile.personalityTraits.length > 0) lines.push(`性格：${profile.personalityTraits.join('、')}`)
  if (relationshipToUser) lines.push(`与用户的关系：${relationshipToUser}`)
  if (addressUserAs) lines.push(`称呼用户为：${addressUserAs}`)
  if (selfReference) lines.push(`自称：${selfReference}`)

  const base = basePersona.trim()
  if (lines.length === 0) return base
  return `${base}${base ? '\n\n' : ''}[当前角色资料]\n${lines.join('\n')}`
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
