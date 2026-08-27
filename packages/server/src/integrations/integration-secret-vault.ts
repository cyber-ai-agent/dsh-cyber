import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { AtomicFileSecretStorage, SerializedWriteQueue, type SecretStoragePort } from '../security/secret-storage.js'

interface EncryptedSecret { iv: string; tag: string; ciphertext: string }
interface VaultFile { version: 1; entries: Record<string, EncryptedSecret> }

export class IntegrationSecretVault {
  readonly #key: Buffer
  readonly #storage: SecretStoragePort
  readonly #writes = new SerializedWriteQueue()
  #entries: Record<string, EncryptedSecret>
  #closed = false

  private constructor(key: Buffer, entries: Record<string, EncryptedSecret>, storage: SecretStoragePort) {
    this.#key = key
    this.#entries = entries
    this.#storage = storage
  }

  static async open(stateRoot: string, storage?: SecretStoragePort): Promise<IntegrationSecretVault> {
    const directory = join(stateRoot, 'credentials')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const key = await readOrCreateKey(join(directory, 'integration-credentials.key'))
    const path = join(directory, 'integration-credentials.json')
    const vaultStorage = storage ?? new AtomicFileSecretStorage(path)
    return new IntegrationSecretVault(key, await readVault(vaultStorage), vaultStorage)
  }

  has(connectionId: string): boolean { return this.#entries[connectionId] !== undefined }
  keys(): string[] { this.#assertOpen(); return Object.keys(this.#entries) }

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
    await this.#writes.run(async () => {
      this.#assertOpen()
      const nextEntries = { ...this.#entries, [connectionId]: encrypt(this.#key, connectionId, value) }
      await this.#persist(nextEntries)
      this.#entries = nextEntries
    })
  }

  async delete(connectionId: string): Promise<void> {
    this.#assertOpen()
    await this.#writes.run(async () => {
      this.#assertOpen()
      if (this.#entries[connectionId] === undefined) return
      const nextEntries = { ...this.#entries }
      delete nextEntries[connectionId]
      await this.#persist(nextEntries)
      this.#entries = nextEntries
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#key.fill(0)
  }

  async #persist(entries: Record<string, EncryptedSecret>): Promise<void> {
    await this.#storage.write(Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8'))
  }

  #assertOpen(): void { if (this.#closed) throw new Error('Integration secret vault is closed') }
}

async function readOrCreateKey(path: string): Promise<Buffer> {
  try { return validateKey(await readFile(path)) } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error }
  const key = randomBytes(32)
  try {
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(key); await handle.sync() } finally { await handle.close() }
    await chmod(path, 0o600).catch(() => undefined)
    return key
  } catch (error) {
    key.fill(0)
    if (!isNodeError(error, 'EEXIST')) throw error
    return validateKey(await readFile(path))
  }
}

async function readVault(storage: SecretStoragePort): Promise<Record<string, EncryptedSecret>> {
  let value: unknown
  try {
    const content = await storage.read()
    if (content === undefined) return {}
    value = JSON.parse(content.toString('utf8'))
  } catch (error) {
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
