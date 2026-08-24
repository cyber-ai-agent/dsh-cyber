import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { HttpError } from '../http/errors.js'

const scrypt = promisify(scryptCallback)
const COOKIE_NAME = 'dsh_application_access'
interface AccessFile { schemaVersion: 1; salt: string; hash: string; updatedAt: string }

export interface ApplicationAccessSummary { passwordEnabled: boolean; unlocked: boolean }

export class ApplicationAccessService {
  readonly #path: string
  readonly #sessions = new Map<string, number>()
  readonly #failures = new Map<string, { count: number; blockedUntil: number }>()

  constructor(stateRoot: string) { this.#path = join(stateRoot, 'credentials', 'application-access.json') }

  async summary(request?: IncomingMessage): Promise<ApplicationAccessSummary> {
    const policy = await this.#read()
    return { passwordEnabled: policy !== undefined, unlocked: policy === undefined || (request !== undefined && this.#token(request) !== undefined) }
  }

  async setPassword(password: string, response: ServerResponse): Promise<ApplicationAccessSummary> {
    if (password.length < 6 || password.length > 128) throw new HttpError(422, 'invalid_application_password', '密码长度需为 6 到 128 个字符')
    const salt = randomBytes(16)
    const derived = await scrypt(password, salt, 32) as Buffer
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    await durableWrite(this.#path, JSON.stringify({ schemaVersion: 1, salt: salt.toString('base64url'), hash: derived.toString('base64url'), updatedAt: new Date().toISOString() }, null, 2) + '\n')
    this.#sessions.clear()
    this.#issue(response)
    return { passwordEnabled: true, unlocked: true }
  }

  async clearPassword(request: IncomingMessage, response: ServerResponse): Promise<ApplicationAccessSummary> {
    await this.assertUnlocked(request)
    await rm(this.#path, { force: true })
    this.#sessions.clear()
    clearCookie(response)
    return { passwordEnabled: false, unlocked: true }
  }

  async unlock(password: string, request: IncomingMessage, response: ServerResponse): Promise<ApplicationAccessSummary> {
    const policy = await this.#read()
    if (policy === undefined) return { passwordEnabled: false, unlocked: true }
    const key = request.socket.remoteAddress ?? 'loopback'
    const failure = this.#failures.get(key)
    if (failure !== undefined && failure.blockedUntil > Date.now()) throw new HttpError(429, 'application_unlock_rate_limited', '尝试过于频繁，请稍后再试')
    const derived = await scrypt(password, Buffer.from(policy.salt, 'base64url'), 32) as Buffer
    const expected = Buffer.from(policy.hash, 'base64url')
    if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
      const count = (failure?.count ?? 0) + 1
      this.#failures.set(key, { count, blockedUntil: count >= 5 ? Date.now() + 30_000 : 0 })
      throw new HttpError(401, 'application_password_invalid', '密码不正确')
    }
    this.#failures.delete(key)
    this.#issue(response)
    return { passwordEnabled: true, unlocked: true }
  }

  lock(request: IncomingMessage, response: ServerResponse): void {
    const token = this.#token(request)
    if (token !== undefined) this.#sessions.delete(token)
    clearCookie(response)
  }

  async assertUnlocked(request: IncomingMessage): Promise<void> {
    if (await this.#read() === undefined) return
    if (this.#token(request) === undefined) throw new HttpError(423, 'application_locked', 'DSH Cyber 已锁定')
  }

  #issue(response: ServerResponse): void {
    const token = randomBytes(32).toString('base64url')
    this.#sessions.set(token, Date.now() + 8 * 60 * 60 * 1000)
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`)
  }

  #token(request: IncomingMessage): string | undefined {
    const token = parseCookies(request.headers.cookie).get(COOKIE_NAME)
    if (token === undefined) return undefined
    const expiresAt = this.#sessions.get(token)
    if (expiresAt === undefined || expiresAt <= Date.now()) { this.#sessions.delete(token); return undefined }
    return token
  }

  async #read(): Promise<AccessFile | undefined> {
    try {
      const value = JSON.parse(await readFile(this.#path, 'utf8')) as AccessFile
      if (value.schemaVersion !== 1 || typeof value.salt !== 'string' || typeof value.hash !== 'string') {
        throw new HttpError(500, 'application_access_policy_invalid', '应用锁配置损坏，请从本机备份恢复访问配置')
      }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}

function parseCookies(value: string | undefined): Map<string, string> { const result = new Map<string,string>(); for (const part of value?.split(';') ?? []) { const index = part.indexOf('='); if (index > 0) result.set(part.slice(0,index).trim(), decodeURIComponent(part.slice(index+1).trim())) } return result }
function clearCookie(response: ServerResponse): void { response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`) }
async function durableWrite(path: string, content: string): Promise<void> {
  try {
    const handle = await open(path, 'r+', 0o600)
    try {
      await handle.truncate(0)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temp = `${path}.tmp-${randomUUID()}`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}
