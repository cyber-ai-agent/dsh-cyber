import type {
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeProfile,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

type CharacterRuntimeStore = Pick<
  SqliteStore,
  'getEmployee' | 'getEmployeeRevision' | 'getEmployeeProfile'
>

export class CharacterProfileRuntime implements AgentRuntimePort {
  readonly #inner: AgentRuntimePort
  readonly #store: CharacterRuntimeStore

  constructor(inner: AgentRuntimePort, store: CharacterRuntimeStore) {
    this.#inner = inner
    this.#store = store
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

    return this.#inner.runTurn({
      ...request,
      agent,
      revision: profile === undefined
        ? revision
        : {
            ...revision,
            persona: composeCharacterPersona(revision.persona, profile),
          },
    })
  }

  close(): Promise<void> {
    return this.#inner.close()
  }
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
