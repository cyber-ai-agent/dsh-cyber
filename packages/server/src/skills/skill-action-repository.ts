import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

export interface CharacterSkillActionReservation {
  action: CharacterSkillAction
  created: boolean
}

/**
 * Durable action repository used by CharacterSkillRuntime.
 *
 * The runtime does not know whether actions live in an atomic local file,
 * SQLite, or a future synchronized store. `reserve` must atomically apply the
 * duplicate window before returning `created: true`; this prevents concurrent
 * requests from independently triggering the same external side effect.
 */
export interface CharacterSkillActionRepository {
  reserve(action: CharacterSkillAction, duplicateWindowMs: number): Promise<CharacterSkillActionReservation>
  save(action: CharacterSkillAction): Promise<void>
  listByWorld(worldId: string): Promise<CharacterSkillAction[]>
  listDue(now: Date): Promise<CharacterSkillAction[]>
}
