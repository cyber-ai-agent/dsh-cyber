import type { WorkspaceFileList, WorkspaceFilePreview } from './workspace-file-service.js'
import { WorkspaceFileService } from './workspace-file-service.js'
import type { WorldRootService } from './world-root-service.js'

export class WorldFileService {
  readonly #roots: WorldRootService
  readonly #services = new Map<string, Promise<WorkspaceFileService>>()

  constructor(roots: WorldRootService) { this.#roots = roots }

  async list(worldId: string, path: string): Promise<WorkspaceFileList> { return (await this.#service(worldId)).list(path) }
  async preview(worldId: string, path: string): Promise<WorkspaceFilePreview> { return (await this.#service(worldId)).preview(path) }

  #service(worldId: string): Promise<WorkspaceFileService> {
    let service = this.#services.get(worldId)
    if (service === undefined) {
      service = this.#roots.ensure(worldId).then((root) => new WorkspaceFileService(root.filesPath))
      this.#services.set(worldId, service)
    }
    return service
  }
}
