import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { HttpError } from '../http/errors.js'
import { AtomicFileSecretStorage, type SecretStoragePort } from '../security/secret-storage.js'

const scrypt = promisify(scryptCallback)
const COOKIE_NAME = 'dsh_application_access'
interface AccessFile { schemaVersion: 1; salt: string; hash: string; recoveryHash?: string; updatedAt: string }

export interface ApplicationAccessSummary { passwordEnabled: boolean; unlocked: boolean; recoveryConfigured: boolean }
export interface ApplicationAccessResponse extends ApplicationAccessSummary { recoveryCode?: string }
export interface ApplicationAccessMutation extends ApplicationAccessSummary { recoveryCode: string }

export class ApplicationAccessService {
  readonly #path: string
  readonly #storage: SecretStoragePort
  readonly #sessions = new Map<string, number>()
  readonly #failures = new Map<string, { count: number; blockedUntil: number }>()

  constructor(stateRoot: string, storage?: SecretStoragePort) {
    this.#path = join(stateRoot, 'credentials', 'application-access.json')
    this.#storage = storage ?? new AtomicFileSecretStorage(this.#path)
  }

  async summary(request?: IncomingMessage): Promise<ApplicationAccessSummary> {
    const policy = await this.#read()
    return { passwordEnabled: policy !== undefined, unlocked: policy === undefined || (request !== undefined && this.#token(request) !== undefined), recoveryConfigured: policy?.recoveryHash !== undefined }
  }

  async setPassword(password: string, response: ServerResponse): Promise<ApplicationAccessMutation> {
    validatePassword(password)
    const recoveryCode = newRecoveryCode()
    const salt = randomBytes(16)
    const derived = await scrypt(password, salt, 32) as Buffer
    await this.#write({ schemaVersion: 1, salt: salt.toString('base64url'), hash: derived.toString('base64url'), recoveryHash: hashRecoveryCode(recoveryCode), updatedAt: new Date().toISOString() })
    this.#sessions.clear()
    this.#issue(response)
    return { passwordEnabled: true, unlocked: true, recoveryConfigured: true, recoveryCode }
  }

  async clearPassword(request: IncomingMessage, response: ServerResponse): Promise<ApplicationAccessSummary> {
    await this.assertUnlocked(request)
    await this.#storage.delete()
    this.#sessions.clear()
    clearCookie(response)
    return { passwordEnabled: false, unlocked: true, recoveryConfigured: false }
  }

  async unlock(password: string, request: IncomingMessage, response: ServerResponse): Promise<ApplicationAccessResponse> {
    const policy = await this.#read()
    if (policy === undefined) return { passwordEnabled: false, unlocked: true, recoveryConfigured: false }
    this.#checkRateLimit(request)
    const derived = await scrypt(password, Buffer.from(policy.salt, 'base64url'), 32) as Buffer
    const expected = Buffer.from(policy.hash, 'base64url')
    if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
      this.#recordFailure(request)
      throw new HttpError(401, 'application_password_invalid', '密码不正确')
    }
    this.#failures.delete(request.socket.remoteAddress ?? 'loopback')
    let recoveryCode: string | undefined
    if (policy.recoveryHash === undefined) {
      recoveryCode = newRecoveryCode()
      await this.#write({ ...policy, recoveryHash: hashRecoveryCode(recoveryCode), updatedAt: new Date().toISOString() })
    }
    this.#issue(response)
    return { passwordEnabled: true, unlocked: true, recoveryConfigured: true, ...(recoveryCode === undefined ? {} : { recoveryCode }) }
  }

  async recover(recoveryCode: string, password: string, request: IncomingMessage, response: ServerResponse): Promise<ApplicationAccessMutation> {
    validatePassword(password)
    const policy = await this.#read()
    if (policy === undefined) throw new HttpError(409, 'application_password_not_enabled', '应用锁没有启用')
    if (policy.recoveryHash === undefined) throw new HttpError(409, 'application_recovery_not_configured', '当前应用锁没有配置恢复码，请联系本机管理员处理')
    this.#checkRateLimit(request)
    if (!sameSecret(hashRecoveryCode(recoveryCode), policy.recoveryHash)) {
      this.#recordFailure(request)
      throw new HttpError(401, 'application_recovery_invalid', '恢复码不正确')
    }
    this.#failures.delete(request.socket.remoteAddress ?? 'loopback')
    const nextRecoveryCode = newRecoveryCode()
    const salt = randomBytes(16)
    const derived = await scrypt(password, salt, 32) as Buffer
    await this.#write({ schemaVersion: 1, salt: salt.toString('base64url'), hash: derived.toString('base64url'), recoveryHash: hashRecoveryCode(nextRecoveryCode), updatedAt: new Date().toISOString() })
    this.#sessions.clear()
    this.#issue(response)
    return { passwordEnabled: true, unlocked: true, recoveryConfigured: true, recoveryCode: nextRecoveryCode }
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
      const content = await this.#storage.read()
      if (content === undefined) return undefined
      const value = JSON.parse(content.toString('utf8')) as AccessFile
      if (value.schemaVersion !== 1 || typeof value.salt !== 'string' || typeof value.hash !== 'string' || (value.recoveryHash !== undefined && typeof value.recoveryHash !== 'string')) {
        throw new HttpError(500, 'application_access_policy_invalid', '应用锁配置损坏，请从本机备份恢复访问配置')
      }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  #write(value: AccessFile): Promise<void> {
    return this.#storage.write(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
  }

  #checkRateLimit(request: IncomingMessage): void {
    const failure = this.#failures.get(request.socket.remoteAddress ?? 'loopback')
    if (failure !== undefined && failure.blockedUntil > Date.now()) throw new HttpError(429, 'application_unlock_rate_limited', '尝试过于频繁，请稍后再试')
  }

  #recordFailure(request: IncomingMessage): void {
    const key = request.socket.remoteAddress ?? 'loopback'
    const failure = this.#failures.get(key)
    const count = (failure?.count ?? 0) + 1
    this.#failures.set(key, { count, blockedUntil: count >= 5 ? Date.now() + 30_000 : 0 })
  }
}

function parseCookies(value: string | undefined): Map<string, string> { const result = new Map<string,string>(); for (const part of value?.split(';') ?? []) { const index = part.indexOf('='); if (index > 0) result.set(part.slice(0,index).trim(), decodeURIComponent(part.slice(index+1).trim())) } return result }
function clearCookie(response: ServerResponse): void { response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`) }
function validatePassword(password: string): void {
  if (password.length < 6 || password.length > 128) throw new HttpError(422, 'invalid_application_password', '密码长度需为 6 到 128 个字符')
}

function newRecoveryCode(): string {
  return randomBytes(15).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-')
}

function hashRecoveryCode(value: string): string {
  return createHash('sha256').update(value.replaceAll(/[^a-z0-9]/gi, '').toUpperCase()).digest('base64url')
}

function sameSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
