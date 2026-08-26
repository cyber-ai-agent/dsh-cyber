import type { ApprovalRequest, ApprovalRequestView } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillRuntime } from './character-skill-runtime.js'

/** One source of truth for approval cards on both approval API surfaces. */
export function listApprovalRequestViews(
  store: SqliteStore,
  skillRuntime: CharacterSkillRuntime,
  worldId: string,
  status: ApprovalRequest['status'] = 'pending',
): ApprovalRequestView[] {
  const requests = skillRuntime.listApprovalRequests(worldId, status)
  const actions = new Map(store.listWorldSkillActions(worldId).map((action) => [action.id, action]))
  const characters = new Map(store.listEmployees(worldId, true).map((character) => [character.id, character]))
  return requests.map((request) => {
    const subject = request.subjectType === 'skill-action' ? actions.get(request.subjectId) : undefined
    const character = request.characterId === undefined ? undefined : characters.get(request.characterId)
    return {
      request,
      allowedScopes: subject === undefined ? ['once'] : skillRuntime.allowedApprovalScopes(subject.skillId),
      ...(character === undefined ? {} : { characterName: character.displayName }),
      ...(subject === undefined ? {} : {
        subject: {
          id: subject.id,
          skillId: subject.skillId,
          adapterId: subject.adapterId,
          action: subject.action,
          target: subject.target,
          label: subject.label,
          risk: subject.risk,
          parameters: subject.parameters,
          ...(subject.scheduledFor === undefined ? {} : { scheduledFor: subject.scheduledFor }),
        },
      }),
    }
  })
}

