import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface EncryptedSecret { iv: string; tag: string; ciphertext: string }
interface VaultFile { version: 1; entries: Record<string, EncryptedSecret> }

export class IntegrationSecretVault {
  readonly #path: string
  readonly #key: Buffer
  readonly #entries: Record<string, EncryptedSecret>
  #closed = false

  private constructor(path: string, key: Buffer, entries: Record<string, EncryptedSecret>) {
    this.#path = path
    this.#key = key
    this.#entries = entries
  }

  static async open(stateRoot: string): Promise<IntegrationSecretVault> {
    const directory = join(stateRoot, 'credentials')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const key = await readOrCreateKey(join(directory, 'integration-credentials.key'))
    const path = join(directory, 'integration-credentials.json')
    return new IntegrationSecretVault(path, key, await readVault(path))
  }

  has(connectionId: string): boolean { return this.#entries[connectionId] !== undefined }

  resolve(connectionId: string): string | undefined {
    this.#assertOpen()
    const entry = this.#entries[connectionId]
    return entry === undefined ? undefined : decrypt(this.#key, connectionId, entry)
  }

  async set(connectionId: string, secret: string): Promise<void> {
    this.#assertOpen()
    const value = secret.trim()
    if (!value) throw new Error('Integration credential cannot be empty')
    if (value.length > 16_384) throw new Error('Integration credential is too large')
    this.#entries[connectionId] = encrypt(this.#key, connectionId, value)
    await this.#persist()
  }

  async delete(connectionId: string): Promise<void> {
    this.#assertOpen()
    if (this.#entries[connectionId] === undefined) return
    delete this.#entries[connectionId]
    await this.#persist()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#key.fill(0)
  }

  async #persist(): Promise<void> {
    const temporary = `${this.#path}.tmp-${randomUUID()}`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, entries: this.#entries }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.#path)
      await chmod(this.#path, 0o600).catch(() => undefined)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  #assertOpen(): void { if (this.#closed) throw new Error('Integration secret vault is closed') }
}

async function readOrCreateKey(path: string): Promise<Buffer> {
  try { return validateKey(await readFile(path)) } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error }
  const key = randomBytes(32)
  try {
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(key) } finally { await handle.close() }
    await chmod(path, 0o600).catch(() => undefined)
    return key
  } catch (error) {
    key.fill(0)
    if (!isNodeError(error, 'EEXIST')) throw error
    return validateKey(await readFile(path))
  }
}

async function readVault(path: string): Promise<Record<string, EncryptedSecret>> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (isNodeError(error, 'ENOENT')) return {}
    throw new Error('Integration credential vault cannot be read', { cause: error })
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) throw new Error('Integration credential vault format is invalid')
  const entries: Record<string, EncryptedSecret> = {}
  for (const [id, entry] of Object.entries(value.entries)) {
    if (!isRecord(entry) || typeof entry.iv !== 'string' || typeof entry.tag !== 'string' || typeof entry.ciphertext !== 'string') {
      throw new Error('Integration credential vault entry is invalid')
    }
    entries[id] = entry as unknown as EncryptedSecret
  }
  return entries
}

function validateKey(key: Buffer): Buffer { if (key.byteLength !== 32) throw new Error('Integration credential key is invalid'); return key }
function encrypt(key: Buffer, id: string, secret: string): EncryptedSecret {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(id))
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
}
function decrypt(key: Buffer, id: string, entry: EncryptedSecret): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64')); decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8')
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error && error.code === code }
