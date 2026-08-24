import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillActionRepository, CharacterSkillActionReservation } from './skill-action-repository.js'

export class SqliteSkillActionRepository implements CharacterSkillActionRepository {
  readonly #store: SqliteStore

  constructor(store: SqliteStore) {
    this.#store = store
  }

  async reserve(action: CharacterSkillAction, duplicateWindowMs: number): Promise<CharacterSkillActionReservation> {
    return this.#store.reserveSkillAction(action, duplicateWindowMs)
  }

  async save(action: CharacterSkillAction): Promise<void> {
    this.#store.saveSkillAction(action)
  }

  async get(actionId: string): Promise<CharacterSkillAction | undefined> {
    return this.#store.getSkillAction(actionId)
  }

  async listByWorld(worldId: string): Promise<CharacterSkillAction[]> {
    return this.#store.listWorldSkillActions(worldId)
  }

  async listDue(now: Date): Promise<CharacterSkillAction[]> {
    return this.#store.listDueSkillActions(now)
  }

  async listWaitingForApproval(): Promise<CharacterSkillAction[]> {
    return this.#store.listSkillActionsWaitingForApproval()
  }
}
