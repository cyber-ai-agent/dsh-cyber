import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { AtomicFileSecretStorage, SerializedWriteQueue, type SecretStoragePort } from '../security/secret-storage.js'

const VAULT_VERSION = 1 as const
const MANAGED_ENV_PREFIX = 'DSH_CYBER_MODEL_KEY_'
const MAX_API_KEY_LENGTH = 16_384

interface EncryptedCredential {
  iv: string
  tag: string
  ciphertext: string
}

interface CredentialVaultFile {
  version: typeof VAULT_VERSION
  entries: Record<string, EncryptedCredential>
}

/**
 * Keeps model credentials out of SQLite and HTTP responses. The vault is local
 * to the server state directory, encrypted with a random key stored in a
 * user-private file, and only exposes generated environment references to the
 * Harness runtime.
 */
export class ModelCredentialService {
  readonly #key: Buffer
  readonly #storage: SecretStoragePort
  readonly #writes = new SerializedWriteQueue()
  #entries: Record<string, EncryptedCredential>
  #closed = false

  private constructor(
    key: Buffer,
    entries: Record<string, EncryptedCredential>,
    storage: SecretStoragePort,
  ) {
    this.#key = key
    this.#entries = entries
    this.#storage = storage
  }

  static async open(stateRoot: string, storage?: SecretStoragePort): Promise<ModelCredentialService> {
    const directory = join(stateRoot, 'credentials')
    const keyPath = join(directory, 'model-credentials.key')
    const vaultPath = join(directory, 'model-credentials.json')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const key = await readOrCreateKey(keyPath)
    const vaultStorage = storage ?? new AtomicFileSecretStorage(vaultPath)
    const entries = await readVault(vaultStorage)
    const service = new ModelCredentialService(key, entries, vaultStorage)
    service.#activateAll()
    return service
  }

  has(profileId: string): boolean {
    return this.#entries[profileId] !== undefined
  }

  credentialEnvName(profileId: string): string {
    return managedCredentialEnvName(profileId)
  }

  resolve(profileId: string): string | undefined {
    this.#assertOpen()
    if (!this.has(profileId)) return undefined
    return process.env[managedCredentialEnvName(profileId)]
  }

  async set(profileId: string, apiKey: string): Promise<string> {
    this.#assertOpen()
    const secret = apiKey.trim()
    if (!secret) throw new Error('API key cannot be empty')
    if (secret.length > MAX_API_KEY_LENGTH) throw new Error('API key is too large')
    return this.#writes.run(async () => {
      this.#assertOpen()
      const nextEntries = { ...this.#entries, [profileId]: encryptCredential(this.#key, profileId, secret) }
      await this.#persist(nextEntries)
      this.#entries = nextEntries
      const envName = managedCredentialEnvName(profileId)
      process.env[envName] = secret
      return envName
    })
  }

  async delete(profileId: string): Promise<void> {
    this.#assertOpen()
    await this.#writes.run(async () => {
      this.#assertOpen()
      if (this.#entries[profileId] === undefined) return
      const nextEntries = { ...this.#entries }
      delete nextEntries[profileId]
      await this.#persist(nextEntries)
      this.#entries = nextEntries
      delete process.env[managedCredentialEnvName(profileId)]
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const profileId of Object.keys(this.#entries)) {
      delete process.env[managedCredentialEnvName(profileId)]
    }
    this.#key.fill(0)
  }

  #activateAll(): void {
    for (const [profileId, entry] of Object.entries(this.#entries)) {
      process.env[managedCredentialEnvName(profileId)] = decryptCredential(this.#key, profileId, entry)
    }
  }

  async #persist(entries: Record<string, EncryptedCredential>): Promise<void> {
    const vault: CredentialVaultFile = { version: VAULT_VERSION, entries }
    await this.#storage.write(Buffer.from(JSON.stringify(vault), 'utf8'))
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Model credential service is closed')
  }
}

export function isManagedModelCredentialName(value: string | undefined): boolean {
  return value?.startsWith(MANAGED_ENV_PREFIX) ?? false
}

function managedCredentialEnvName(profileId: string): string {
  const digest = createHash('sha256').update(profileId).digest('hex').slice(0, 24).toUpperCase()
  return `${MANAGED_ENV_PREFIX}${digest}`
}

async function readOrCreateKey(path: string): Promise<Buffer> {
  try {
    return validateKey(await readFile(path))
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const key = randomBytes(32)
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(key)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(path, 0o600).catch(() => undefined)
    return key
  } catch (error) {
    key.fill(0)
    if (!isAlreadyExists(error)) throw error
    return validateKey(await readFile(path))
  }
}

function validateKey(key: Buffer): Buffer {
  if (key.byteLength !== 32) throw new Error('Model credential vault key is invalid')
  return key
}

async function readVault(storage: SecretStoragePort): Promise<Record<string, EncryptedCredential>> {
  let value: unknown
  try {
    const content = await storage.read()
    if (content === undefined) return {}
    value = JSON.parse(content.toString('utf8'))
  } catch (error) {
    throw new Error('Model credential vault cannot be read', { cause: error })
  }
  if (!isRecord(value) || value.version !== VAULT_VERSION || !isRecord(value.entries)) {
    throw new Error('Model credential vault format is invalid')
  }
  const entries: Record<string, EncryptedCredential> = {}
  for (const [profileId, entry] of Object.entries(value.entries)) {
    if (!isEncryptedCredential(entry)) throw new Error('Model credential vault entry is invalid')
    entries[profileId] = entry
  }
  return entries
}

function encryptCredential(key: Buffer, profileId: string, secret: string): EncryptedCredential {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(profileId, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

function decryptCredential(key: Buffer, profileId: string, entry: EncryptedCredential): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'))
    decipher.setAAD(Buffer.from(profileId, 'utf8'))
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    throw new Error('Model credential vault entry cannot be decrypted', { cause: error })
  }
}

function isEncryptedCredential(value: unknown): value is EncryptedCredential {
  return isRecord(value)
    && typeof value.iv === 'string'
    && typeof value.tag === 'string'
    && typeof value.ciphertext === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
