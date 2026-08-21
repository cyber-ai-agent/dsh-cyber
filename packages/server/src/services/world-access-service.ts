import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldAccessSummary } from '@dsh-cyber/contracts'
import { HttpError } from '../http/errors.js'
import type { WorldRootService } from './world-root-service.js'

const scrypt = promisify(scryptCallback)
interface AccessFile { schemaVersion: 1; salt: string; hash: string; updatedAt: string }
interface Session { worldId: string; expiresAt: number }

export class WorldAccessService {
  readonly #roots: WorldRootService
  readonly #sessions = new Map<string, Session>()
  readonly #failures = new Map<string, { count: number; blockedUntil: number }>()
  constructor(roots: WorldRootService) { this.#roots = roots }

  async summary(worldId: string, request?: IncomingMessage): Promise<WorldAccessSummary> {
    const policy = await this.#read(worldId)
    return { worldId, passwordEnabled: policy !== undefined, unlocked: policy === undefined || (request !== undefined && this.#token(request, worldId) !== undefined) }
  }
  async setPassword(worldId: string, password: string, response: ServerResponse): Promise<WorldAccessSummary> {
    if (password.length < 4 || password.length > 128) throw new HttpError(422, 'invalid_world_password', '密码长度需为 4 到 128 个字符')
    const salt = randomBytes(16)
    const derived = await scrypt(password, salt, 32) as Buffer
    const root = await this.#roots.ensure(worldId)
    await atomic(join(root.rootPath, '.access.json'), JSON.stringify({ schemaVersion: 1, salt: salt.toString('base64url'), hash: derived.toString('base64url'), updatedAt: new Date().toISOString() }, null, 2) + '\n')
    this.#sessionsForWorld(worldId, true)
    const token = this.#issue(worldId)
    setCookie(response, worldId, token)
    return { worldId, passwordEnabled: true, unlocked: true }
  }
  async clearPassword(worldId: string, response: ServerResponse): Promise<WorldAccessSummary> {
    const root = await this.#roots.ensure(worldId)
    await rm(join(root.rootPath, '.access.json'), { force: true })
    this.#sessionsForWorld(worldId, true)
    clearCookie(response, worldId)
    return { worldId, passwordEnabled: false, unlocked: true }
  }
  async unlock(worldId: string, password: string, request: IncomingMessage, response: ServerResponse): Promise<WorldAccessSummary> {
    const policy = await this.#read(worldId)
    if (policy === undefined) return { worldId, passwordEnabled: false, unlocked: true }
    const key = request.socket.remoteAddress ?? 'loopback'
    const failure = this.#failures.get(key)
    if (failure !== undefined && failure.blockedUntil > Date.now()) throw new HttpError(429, 'world_unlock_rate_limited', '尝试过于频繁，请稍后再试')
    const derived = await scrypt(password, Buffer.from(policy.salt, 'base64url'), 32) as Buffer
    const expected = Buffer.from(policy.hash, 'base64url')
    if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
      const count = (failure?.count ?? 0) + 1
      this.#failures.set(key, { count, blockedUntil: count >= 5 ? Date.now() + 30_000 : 0 })
      throw new HttpError(401, 'world_password_invalid', '世界密码不正确')
    }
    this.#failures.delete(key)
    const token = this.#issue(worldId)
    setCookie(response, worldId, token)
    return { worldId, passwordEnabled: true, unlocked: true }
  }
  lock(worldId: string, request: IncomingMessage, response: ServerResponse): void {
    const token = this.#token(request, worldId)
    if (token !== undefined) this.#sessions.delete(token)
    clearCookie(response, worldId)
  }
  async assertUnlocked(worldId: string, request: IncomingMessage): Promise<void> {
    if (await this.#read(worldId) === undefined) return
    if (this.#token(request, worldId) === undefined) throw new HttpError(423, 'world_locked', '当前世界已锁定')
  }
  #issue(worldId: string): string { const token = randomBytes(32).toString('base64url'); this.#sessions.set(token, { worldId, expiresAt: Date.now() + 8 * 60 * 60 * 1000 }); return token }
  #token(request: IncomingMessage, worldId: string): string | undefined {
    const cookies = parseCookies(request.headers.cookie)
    const token = cookies.get(cookieName(worldId))
    if (token === undefined) return undefined
    const session = this.#sessions.get(token)
    if (session === undefined || session.worldId !== worldId || session.expiresAt <= Date.now()) { this.#sessions.delete(token); return undefined }
    return token
  }
  #sessionsForWorld(worldId: string, remove: boolean): void { if (!remove) return; for (const [token, session] of this.#sessions) if (session.worldId === worldId) this.#sessions.delete(token) }
  async #read(worldId: string): Promise<AccessFile | undefined> {
    const root = await this.#roots.ensure(worldId)
    try { const value = JSON.parse(await readFile(join(root.rootPath, '.access.json'), 'utf8')) as AccessFile; return value.schemaVersion === 1 && typeof value.salt === 'string' && typeof value.hash === 'string' ? value : undefined }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
}
function cookieName(worldId: string): string { return 'dsh_world_' + createHash('sha256').update(worldId).digest('hex').slice(0, 16) }
function parseCookies(value: string | undefined): Map<string, string> { const result = new Map<string,string>(); for (const part of value?.split(';') ?? []) { const index = part.indexOf('='); if (index > 0) result.set(part.slice(0,index).trim(), decodeURIComponent(part.slice(index+1).trim())) } return result }
function setCookie(response: ServerResponse, worldId: string, token: string): void { response.setHeader('Set-Cookie', `${cookieName(worldId)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`) }
function clearCookie(response: ServerResponse, worldId: string): void { response.setHeader('Set-Cookie', `${cookieName(worldId)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`) }
async function atomic(path: string, content: string): Promise<void> { const temp = `${path}.tmp-${randomUUID()}`; const handle = await open(temp, 'wx', 0o600); try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }; await rename(temp, path) }
