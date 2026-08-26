import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldAccessSummary } from '@dsh-cyber/contracts'
import { HttpError } from '../http/errors.js'
import type { WorldRootService } from './world-root-service.js'

export class WorldAccessService {
  readonly #roots: WorldRootService
  constructor(roots: WorldRootService) { this.#roots = roots }

  async summary(worldId: string, request?: IncomingMessage): Promise<WorldAccessSummary> {
    void request
    return { worldId, passwordEnabled: false, unlocked: true }
  }
  async setPassword(worldId: string, password: string, response: ServerResponse): Promise<WorldAccessSummary> {
    void password
    void response
    throw new HttpError(410, 'world_access_disabled', '世界不单独设置密码，请使用 DSH Cyber 入口锁')
  }
  async clearPassword(worldId: string, response: ServerResponse): Promise<WorldAccessSummary> {
    const root = await this.#roots.ensure(worldId)
    await rm(join(root.rootPath, '.access.json'), { force: true })
    clearCookie(response, worldId)
    return { worldId, passwordEnabled: false, unlocked: true }
  }
  async unlock(worldId: string, password: string, request: IncomingMessage, response: ServerResponse): Promise<WorldAccessSummary> {
    void password
    void request
    void response
    return { worldId, passwordEnabled: false, unlocked: true }
  }
  lock(worldId: string, request: IncomingMessage, response: ServerResponse): void {
    void worldId
    void request
    clearCookie(response, worldId)
  }
  async assertUnlocked(worldId: string, request: IncomingMessage): Promise<void> {
    // Keep the world-root resolution in the request path so the compatibility
    // layer preserves the same scheduling boundary as older builds, while no
    // per-world credential can ever block the global entry lock.
    await this.#roots.ensure(worldId)
    void request
  }
}
function clearCookie(response: ServerResponse, _worldId: string): void { response.setHeader('Set-Cookie', 'dsh_world_access=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0') }
