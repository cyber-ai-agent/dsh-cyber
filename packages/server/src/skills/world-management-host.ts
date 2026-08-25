import type { SqliteStore } from '@dsh-cyber/persistence'

import type { WorldCharacterAuthorityService } from '../services/world-character-authority-service.js'
import type { WorldPackageInstanceService } from '../services/world-package-instance-service.js'
import type { WorldSettingsService } from '../services/world-settings-service.js'
import type { WorldManagementHost } from './world-management-adapter.js'

export interface WorldManagementHostOptions {
  store: SqliteStore
  worldSettings: WorldSettingsService
  worldPackages: WorldPackageInstanceService
  authority: WorldCharacterAuthorityService
}

/**
 * The production wiring behind every published world-management skill.
 *
 * It lives here rather than inline in the server so a test can build the same
 * host the product uses. A capability that only exists in a hand-written test
 * fixture is not shipped — that is how `world.rename` and
 * `world.characters.update` were advertised while always failing.
 */
export function createWorldManagementHost(options: WorldManagementHostOptions): WorldManagementHost {
  const { store, worldSettings, worldPackages, authority } = options
  return {

    listCharacters: (worldId) => store.listEmployees(worldId).map((employee) => ({
      id: employee.id,
      displayName: employee.displayName,
      status: employee.status,
    })),
    settings: {
      get: async (worldId) => {
        const settings = await worldSettings.get(worldId)
        return { ...settings }
      },
      getSnapshot: async (worldId) => {
        const snapshot = await worldSettings.getSnapshot(worldId)
        return { settings: { ...snapshot.settings }, revision: snapshot.revision }
      },
      savePatch: async (worldId, patch, expectedRevision) => {
        const snapshot = await worldSettings.savePatch(worldId, patch, expectedRevision)
        return { settings: { ...snapshot.settings }, revision: snapshot.revision }
      },
    },
    authority,
    managementActor: (action) => {
      const request = action.requiredWorldPermission === undefined
        ? undefined
        : store.getWorldPermissionRequestForAction(action.id, action.requiredWorldPermission)
      const onceApproved = request?.status === 'approved'
        && request.decisionScope === 'once'
        && request.consumedAt === undefined
      return onceApproved
        ? { kind: 'owner', id: 'local-user' }
        : { kind: 'employee', id: action.characterId }
    },
    renameWorld: (worldId, name) => {
      store.renameWorld({ worldId, name, actorId: 'local-user' })
    },
    updateCharacter: (worldId, employeeId, patch) => {
      // A world administrator may only reach characters of their own world.
      // reviseEmployeeProfile does not check membership, so without this guard
      // wiring it up would create a cross-world write primitive.
      const employee = store.getEmployee(employeeId)
      if (employee === undefined || employee.worldId !== worldId) {
        throw new Error('目标角色不属于当前世界')
      }
      const role = typeof patch.role === 'string' ? patch.role.trim() : ''
      if (!role) throw new Error('角色身份不能为空')
      // A freshly recruited character has no profile revision yet, and
      // reviseEmployeeProfile rejects an empty background. Carry the existing
      // background forward, or seed it from the character's own summary, so a
      // role change never has to invent a biography.
      const profile = store.getEmployeeProfile(employeeId)
      const background = profile?.background?.trim() || `${employee.displayName}（${employee.role}）`
      store.reviseEmployeeProfile({
        employeeId,
        role,
        background,
        reason: 'world-management:characters.update',
      })
    },
    getWorld: (worldId) => {
      const world = store.getWorld(worldId)
      return world === undefined ? undefined : { id: world.id, workspaceId: world.workspaceId }
    },
    listPackages: (worldId) => worldPackages.listRuntimePackages(worldId),
    instantiatePackage: async (worldId, packageId) => {
      const world = store.getWorld(worldId)
      if (world === undefined) throw new Error('世界不存在')
      const installed = store.getActivePackage(world.workspaceId, packageId)
      if (installed === undefined) throw new Error('当前工作区没有这个插件的活动版本')
      await worldPackages.instantiate({
        worldId,
        packageId,
        version: installed.version,
        actorId: 'local-user',
      })
    },
    disablePackage: (worldId, packageId) => {
      const instance = store.listWorldPackageInstances(worldId, 'active').find((item) => item.packageId === packageId)
      if (instance === undefined) throw new Error('当前世界没有这个插件实例')
      store.disableWorldPackageInstance(instance.id, 'local-user')
    },
    readModel: (worldId) => {
      const world = store.getWorld(worldId)
      if (world === undefined) throw new Error('世界不存在')
      return store.getModelAssignment(world.workspaceId, 'world', world.id)
    },
    assignModel: (worldId, modelProfileId) => {
      const world = store.getWorld(worldId)
      const profile = world === undefined ? undefined : store.getModelProfile(modelProfileId)
      if (world === undefined || profile === undefined || profile.workspaceId !== world.workspaceId) {
        throw new Error('模型档案不属于当前世界')
      }
      store.saveModelAssignment({
        workspaceId: world.workspaceId,
        scope: 'world',
        scopeId: world.id,
        modelProfileId,
        actorId: 'local-user',
      })
    },

  }
}
