import type { ApprovalRequest, ApprovalRequestView } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillRuntime } from './character-skill-runtime.js'

export interface ToolApprovalViewResolver {
  view(request: ApprovalRequest): ApprovalRequestView['subject'] | undefined
}

/** One source of truth for approval cards on both approval API surfaces. */
export function listApprovalRequestViews(
  store: SqliteStore,
  skillRuntime: CharacterSkillRuntime,
  worldId: string,
  status: ApprovalRequest['status'] = 'pending',
  toolApprovals?: ToolApprovalViewResolver,
): ApprovalRequestView[] {
  const requests = skillRuntime.listApprovalRequests(worldId, status)
  const actions = new Map(store.listWorldSkillActions(worldId).map((action) => [action.id, action]))
  const characters = new Map(store.listEmployees(worldId, true).map((character) => [character.id, character]))
  return requests.map((request) => {
    const skillSubject = request.subjectType === 'skill-action' ? actions.get(request.subjectId) : undefined
    const toolSubject = toolApprovals?.view(request)
    const character = request.characterId === undefined ? undefined : characters.get(request.characterId)
    return {
      request,
      allowedScopes: skillSubject === undefined ? ['once'] : skillRuntime.allowedApprovalScopes(skillSubject.skillId),
      ...(character === undefined ? {} : { characterName: character.displayName }),
      ...(toolSubject === undefined ? {} : { subject: toolSubject }),
      ...(skillSubject === undefined ? {} : {
        subject: {
          id: skillSubject.id,
          skillId: skillSubject.skillId,
          adapterId: skillSubject.adapterId,
          action: skillSubject.action,
          target: skillSubject.target,
          label: skillSubject.label,
          risk: skillSubject.risk,
          parameters: skillSubject.parameters,
          ...(skillSubject.scheduledFor === undefined ? {} : { scheduledFor: skillSubject.scheduledFor }),
        },
      }),
    }
  })
}
