import { describe, expect, it } from 'vitest'

import type {
  WorldCharacterAuthority,
  WorldPermissionRequest,
} from '@dsh-cyber/contracts/world-authority'
import type { WorldPermissionRequestStore, WorldAuthorityPort } from '../src/services/world-permission-request-service.js'
import { WorldPermissionRequestService, WorldPermissionGrantRejectedError } from '../src/services/world-permission-request-service.js'

const now = new Date('2026-08-25T00:00:00.000Z')

function fixture(initialGrant: WorldCharacterAuthority['permissionGrants'] = []) {
  let request: WorldPermissionRequest | undefined
  let authority: WorldCharacterAuthority = {
    worldId: 'world-1', employeeId: 'employee-1', role: 'member', permissionGrants: [...initialGrant],
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  const store: WorldPermissionRequestStore = {
    createWorldPermissionRequest(input) {
      request ??= {
        id: input.id ?? 'request-1', workspaceId: input.workspaceId, worldId: input.worldId,
        employeeId: input.employeeId, workTurnId: input.workTurnId, skillActionId: input.skillActionId,
        permission: input.permission, status: 'pending', createdAt: input.createdAt ?? now.toISOString(),
        expiresAt: input.expiresAt,
      }
      return request
    },
    getWorldPermissionRequest: () => request,
    listWorldPermissionRequests: () => request === undefined ? [] : [request],
    getWorldPermissionRequestForAction: () => request,
    decideWorldPermissionRequest(_id, input, decidedAt = now.toISOString()) {
      if (request === undefined) throw new Error('missing request')
      request = {
        ...request,
        status: input.decisionScope === 'reject' ? 'rejected' : 'approved',
        ...(input.decisionScope === 'reject' ? {} : { decisionScope: input.decisionScope }),
        decidedBy: input.decidedBy, decidedAt,
      }
      return request
    },
    consumeWorldPermissionRequest(_id, consumedAt = now.toISOString()) {
      if (request === undefined) throw new Error('missing request')
      request = { ...request, consumedAt }
      return request
    },
    expireWorldPermissionRequest: () => {
      if (request === undefined) throw new Error('missing request')
      request = { ...request, status: 'expired', decidedAt: now.toISOString(), decidedBy: 'system' }
      return request
    },
  }
  const authorityPort: WorldAuthorityPort = {
    get: () => authority,
    hasPermission: (_worldId, _employeeId, permission) => authority.permissionGrants.includes(permission),
    updateAuthority: (input) => {
      authority = { ...authority, role: input.role, permissionGrants: [...input.permissionGrants] }
      return authority
    },
  }
  return { store, authorityPort, getRequest: () => request, getAuthority: () => authority }
}

describe('WorldPermissionRequestService', () => {
  it('binds one request to one action and consumes once exactly once', async () => {
    const fixtureState = fixture()
    const service = new WorldPermissionRequestService({ store: fixtureState.store, authority: fixtureState.authorityPort })
    const input = {
      workspaceId: 'workspace-1', worldId: 'world-1', employeeId: 'employee-1', workTurnId: 'turn-1',
      skillActionId: 'action-1', permission: 'world.files.write' as const, now,
    }
    const first = await service.ensure(input)
    const second = await service.ensure(input)
    expect(second.id).toBe(first.id)
    await service.decide({ requestId: first.id, decision: 'once', decidedBy: 'owner', now })
    await service.consumeOnce(first.id, now)
    const after = await service.consumeOnce(first.id, now)
    expect(after.consumedAt).toBe(now.toISOString())
  })

  it('does not fake persistent approval when the authority strips a member grant', async () => {
    const fixtureState = fixture()
    fixtureState.authorityPort.updateAuthority = (input) => ({
      ...fixtureState.getAuthority(), permissionGrants: [], role: input.role,
    })
    const service = new WorldPermissionRequestService({ store: fixtureState.store, authority: fixtureState.authorityPort })
    const request = await service.ensure({
      workspaceId: 'workspace-1', worldId: 'world-1', employeeId: 'employee-1', workTurnId: 'turn-1',
      skillActionId: 'action-1', permission: 'world.settings.write', now,
    })
    await expect(service.decide({ requestId: request.id, decision: 'persistent', decidedBy: 'owner', now }))
      .rejects.toBeInstanceOf(WorldPermissionGrantRejectedError)
    expect(fixtureState.getRequest()?.status).toBe('pending')
  })

  it('recovers a persistent-grant-before-decision crash without executing anything', async () => {
    const fixtureState = fixture()
    const service = new WorldPermissionRequestService({ store: fixtureState.store, authority: fixtureState.authorityPort })
    const request = await service.ensure({
      workspaceId: 'workspace-1', worldId: 'world-1', employeeId: 'employee-1', workTurnId: 'turn-1',
      skillActionId: 'action-1', permission: 'world.files.write', now,
    })
    await fixtureState.authorityPort.updateAuthority!({
      worldId: 'world-1', targetEmployeeId: 'employee-1', actor: { kind: 'owner', id: 'owner' },
      role: 'member', permissionGrants: ['world.files.write'], reason: 'crash simulation',
    })
    const recovered = await service.recoverPending('world-1', now)
    expect(recovered[0]).toMatchObject({ id: request.id, status: 'approved', decisionScope: 'persistent' })
  })
})

