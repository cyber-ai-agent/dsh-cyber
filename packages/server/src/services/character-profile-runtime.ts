import type { AgentRuntimePort, AgentTurnRequest, EmployeeProfile } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

export class CharacterProfileRuntime implements AgentRuntimePort {
  readonly #inner: AgentRuntimePort
  readonly #store: Pick<SqliteStore, 'getEmployeeProfile'>

  constructor(inner: AgentRuntimePort, store: Pick<SqliteStore, 'getEmployeeProfile'>) {
    this.#inner = inner
    this.#store = store
  }

  runTurn(request: AgentTurnRequest) {
    const profile = this.#store.getEmployeeProfile(request.agent.id)
    if (profile === undefined) return this.#inner.runTurn(request)
    return this.#inner.runTurn({
      ...request,
      revision: {
        ...request.revision,
        persona: composeCharacterPersona(request.revision.persona, profile),
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
