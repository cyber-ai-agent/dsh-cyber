import { BUILTIN_BLUEPRINTS, worldTemplate } from '@dsh-cyber/catalog'
import type { EmployeeInstance, World } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { loadInstalledWorldThemes } from '../installed-package-runtime.js'
import type { WorldRuntimeService } from '../world-runtime-service.js'
import { ServiceError } from './service-error.js'
import type { WorldPackageInstanceService } from './world-package-instance-service.js'

export class WorldMarketplaceService {
  constructor(
    private readonly store: SqliteStore,
    private readonly worldRuntime: WorldRuntimeService,
    private readonly worldPackages: WorldPackageInstanceService,
  ) {}

  async createFromInstalledTheme(input: {
    workspaceId: string
    packageId: string
    name: string
  }): Promise<{ world: World; employees: EmployeeInstance[] }> {
    const worldName = input.name.replaceAll('\0', '').trim()
    if (worldName.length === 0 || worldName.length > 80) {
      throw new ServiceError('invalid', 'world_name_invalid', '世界名称需要 1 到 80 个字符')
    }
    if (this.store.getWorkspace(input.workspaceId) === undefined) {
      throw new ServiceError('not-found', 'workspace_not_found', '工作区不存在')
    }
    const installed = this.store.listInstalledPackages(input.workspaceId).find((item) =>
      item.status === 'active' && item.kind === 'world-theme' && item.packageId === input.packageId)
    if (installed === undefined) {
      throw new ServiceError('conflict', 'theme_not_installed', '请先安装这个世界主题')
    }
    const theme = (await loadInstalledWorldThemes([installed]))[0]
    if (theme === undefined || worldTemplate(theme.manifest.templateId) === undefined) {
      throw new ServiceError('unsupported', 'world_template_unavailable', '这个主题暂时不能创建独立世界')
    }
    const world = this.store.createWorld({
      workspaceId: input.workspaceId,
      name: worldName,
      templateId: theme.manifest.templateId,
    })
    try {
      await this.worldPackages.instantiate({
        worldId: world.id, packageId: installed.packageId, version: installed.version,
      })
      await this.worldRuntime.bindInstalledTheme(world.id, installed.packageId)
      const starters = BUILTIN_BLUEPRINTS.filter((blueprint) => blueprint.worldTemplateId === world.templateId).slice(0, 3)
      const employees = starters.map((blueprint) => this.store.recruitEmployee({
        workspaceId: input.workspaceId,
        worldId: world.id,
        blueprintId: blueprint.id,
        blueprintVersion: blueprint.version,
        displayName: blueprint.displayName,
      }))
      return { world, employees }
    } catch (error) {
      this.store.rollbackWorldCreation(world.id, 'marketplace-world-creation-failed')
      await this.worldPackages.compensateRolledBackWorld(world.id)
      throw error
    }
  }
}
