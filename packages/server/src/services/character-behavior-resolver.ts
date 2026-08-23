import type { EmployeeInstance } from '@dsh-cyber/contracts'
import type { CharacterBehaviorProfile } from '@dsh-cyber/contracts/world-simulation'
import type { SqliteStore } from '@dsh-cyber/persistence'
import { readCharacterBehaviorProfile } from '@dsh-cyber/world-simulation'

import { embodimentToCharacterBehaviorProfile } from '../embodiment-profile.js'

type CharacterBehaviorStore = Pick<
  SqliteStore,
  'getEmployeeProfile' | 'getBlueprint'
>

/**
 * Resolves only explicit/configured character behavior.
 *
 * Precedence is a product invariant:
 *   1. Character Profile explicit override (user-owned current state)
 *   2. immutable Blueprint Embodiment (portable template default)
 *   3. undefined, so the world-simulation layer may use legacy role inference
 *      and its safe general/public fallback.
 *
 * Keeping the legacy inference outside this resolver prevents new character
 * creation paths from accidentally treating a display job title as identity.
 */
export function resolveConfiguredCharacterBehavior(
  store: CharacterBehaviorStore,
  character: EmployeeInstance,
): CharacterBehaviorProfile | undefined {
  const explicit = readCharacterBehaviorProfile(
    store.getEmployeeProfile(character.id)?.appearance,
  )
  if (explicit !== undefined) return explicit

  const blueprint = store.getBlueprint(character.blueprintId, character.blueprintVersion)
  if (blueprint?.embodiment === undefined) return undefined

  return embodimentToCharacterBehaviorProfile(
    `${blueprint.id}@${blueprint.version}`,
    blueprint.embodiment,
  )
}
