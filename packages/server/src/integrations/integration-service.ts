import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { IntegrationConnection, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'
import { assertSecretFree } from '@dsh-cyber/persistence'

import type { IntegrationProvider } from './integration-registry.js'
import type { IntegrationRegistry } from './integration-registry.js'
import { IntegrationSecretVault } from './integration-secret-vault.js'

interface ConnectionFile { version: 1; items: IntegrationConnection[] }

/** Structured secret payload persisted for providers that declare multiple secret fields. */
interface StructuredSecrets { version: 1; values: Record<string, string> }

const SECRET_PAYLOAD_PREFIX = 'dsh-secrets:'

export class IntegrationService {
  readonly #path: string
  readonly #registry: IntegrationRegistry
  readonly #vault: IntegrationSecretVault
  readonly #connections = new Map<string, IntegrationConnection>()
  readonly #fetch: typeof globalThis.fetch

  private constructor(path: string, registry: IntegrationRegistry, vault: IntegrationSecretVault, fetch: typeof globalThis.fetch) {
    this.#path = path; this.#registry = registry; this.#vault = vault; this.#fetch = fetch
  }

  static async open(stateRoot: string, registry: IntegrationRegistry, fetch = globalThis.fetch): Promise<IntegrationService> {
    const directory = join(stateRoot, 'integrations')
    await mkdir(directory, { recursive: true })
    const service = new IntegrationService(join(directory, 'connections.json'), registry, await IntegrationSecretVault.open(stateRoot), fetch)
    await service.#pruneExpiredMcpPayloads()
    for (const connection of await readConnections(service.#path)) {
      connection.config = registry.require(connection.integrationId).validateConfig(connection.config)
      assertSecretFree(connection.config)
      const provider = registry.require(connection.integrationId)
      Object.assign(connection, secretState(provider, service.#vault.resolve(connection.id)))
      service.#connections.set(connection.id, connection)
    }
    return service
  }

  descriptors() { return this.#registry.list() }

  list(workspaceId: string): IntegrationConnection[] {
    return [...this.#connections.values()].filter((item) => item.workspaceId === workspaceId)
      .map((item) => {
        const provider = this.#registry.require(item.integrationId)
        return { ...item, config: { ...item.config }, ...secretState(provider, this.#vault.resolve(item.id)) }
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
  }

  /**
   * Connections of one provider type. Multi-connection types (SSH devices,
   * API endpoints) keep several; legacy single-connection types return 0..1.
   */
  listByType(workspaceId: string, integrationId: string): IntegrationConnection[] {
    return this.list(workspaceId).filter((item) => item.integrationId === integrationId)
  }

  get(workspaceId: string, integrationId: string): IntegrationConnection | undefined {
    return this.list(workspaceId).find((item) => item.integrationId === integrationId)
  }

  getById(workspaceId: string, connectionId: string): IntegrationConnection | undefined {
    return this.list(workspaceId).find((item) => item.id === connectionId)
  }

  /**
   * Legacy single-credential accessor for providers with exactly one secret
   * field (Firecrawl API key, MCP bearer token…). Returns undefined for
   * multi-secret connections so callers switch to `secretsForConnection`.
   */
  credential(workspaceId: string, integrationId: string): string | undefined {
    const connection = this.get(workspaceId, integrationId)
    if (connection === undefined || !connection.enabled) return undefined
    return singleSecret(this.#registry.require(integrationId), this.#vault.resolve(connection.id))
  }

  credentialForConnection(workspaceId: string, connectionId: string): string | undefined {
    const connection = this.getById(workspaceId, connectionId)
    if (connection === undefined || !connection.enabled) return undefined
    return singleSecret(this.#registry.require(connection.integrationId), this.#vault.resolve(connection.id))
  }

  /**
   * Per-field secrets for providers with several secret fields (SSH
   * 私钥/密码). Single-field providers yield { [fieldId]: value } so callers
   * can read either shape uniformly. Returns undefined when nothing is stored.
   */
  secretsForConnection(workspaceId: string, connectionId: string): Record<string, string> | undefined {
    const connection = this.getById(workspaceId, connectionId)
    if (connection === undefined || !connection.enabled) return undefined
    const raw = this.#vault.resolve(connection.id)
    if (raw === undefined) return undefined
    return decodeSecrets(this.#registry.require(connection.integrationId), raw)
  }

  async storeMcpPayload(value: JsonObject, now = new Date()): Promise<string> {
    const serialized = JSON.stringify(value)
    if (serialized.length > 12_000) throw new Error('MCP 工具参数过大')
    const reference = `mcp-action:${now.getTime()}:${randomUUID()}`
    await this.#vault.set(reference, serialized)
    return reference
  }

  resolveMcpPayload(reference: string): JsonObject | undefined {
    if (!reference.startsWith('mcp-action:')) return undefined
    const serialized = this.#vault.resolve(reference)
    if (serialized === undefined) return undefined
    const value: unknown = JSON.parse(serialized)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
  }

  deleteMcpPayload(reference: string): Promise<void> {
    return reference.startsWith('mcp-action:') ? this.#vault.delete(reference) : Promise.resolve()
  }

  async save(input: {
    workspaceId: string
    integrationId: string
    connectionId?: string
    displayName?: string
    config: JsonObject
    enabled: boolean
    /** Legacy single-field value; ignored when `secrets` is present. */
    credential?: string
    /** Per-field secrets to write (providers with several secret fields). */
    secrets?: Record<string, string>
    /** Field ids whose stored secret should be erased. */
    clearSecretFields?: string[]
    clearCredential?: boolean
  }): Promise<IntegrationConnection> {
    const provider = this.#registry.require(input.integrationId)
    const now = new Date().toISOString()
    const validatedConfig = provider.validateConfig(input.config)
    assertSecretFree(validatedConfig)
    // An explicit connectionId edits that exact connection; without one, the
    // legacy single-connection types reuse the type's existing connection and
    // multi-connection types create a fresh one (used by "add device").
    const multiple = provider.descriptor.allowsMultipleConnections === true
    const explicit = input.connectionId === undefined
      ? undefined
      : this.#connections.get(input.connectionId)
    const existing = explicit !== undefined && explicit.workspaceId === input.workspaceId && explicit.integrationId === input.integrationId
      ? explicit
      : (input.connectionId === undefined && !multiple
        ? this.listByType(input.workspaceId, input.integrationId)[0]
        : undefined)
    const connection: IntegrationConnection = {
      id: existing?.id ?? input.connectionId ?? randomUUID(), workspaceId: input.workspaceId, integrationId: input.integrationId,
      displayName: input.displayName?.trim()
        || (typeof validatedConfig.displayName === 'string' && validatedConfig.displayName.trim() ? validatedConfig.displayName.trim() : '')
        || existing?.displayName
        || provider.descriptor.displayName,
      config: validatedConfig, enabled: input.enabled,
      credentialConfigured: false, createdAt: existing?.createdAt ?? now, updatedAt: now,
    }
    const previousRaw = existing === undefined ? undefined : this.#vault.resolve(existing.id)
    try {
      await this.#writeSecrets(provider, connection.id, previousRaw, {
        ...(input.credential === undefined ? {} : { credential: input.credential }),
        ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
        ...((input.clearSecretFields ?? []).length === 0 ? {} : { clearSecretFields: input.clearSecretFields }),
        clearCredential: input.clearCredential === true,
      })
      Object.assign(connection, secretState(provider, this.#vault.resolve(connection.id)))
      this.#connections.set(connection.id, connection)
      await this.#persist()
    } catch (error) {
      if (existing === undefined) this.#connections.delete(connection.id)
      else this.#connections.set(existing.id, existing)
      if (previousRaw === undefined) await this.#vault.delete(connection.id).catch(() => undefined)
      else await this.#vault.set(connection.id, previousRaw).catch(() => undefined)
      throw error
    }
    return { ...connection, config: { ...connection.config } }
  }

  async #writeSecrets(provider: IntegrationProvider, connectionId: string, previousRaw: string | undefined, write: {
    credential?: string
    secrets?: Record<string, string>
    clearSecretFields?: string[]
    clearCredential: boolean
  }): Promise<void> {
    const fields = secretFields(provider)
    if (write.clearCredential) {
      await this.#vault.delete(connectionId)
      return
    }
    if (write.secrets !== undefined || (write.clearSecretFields ?? []).length > 0) {
      // Multi-field write: keep fields not touched this round so adding a
      // password does not wipe an existing private key.
      const previous = previousRaw === undefined ? {} : decodeSecrets(provider, previousRaw)
      const next: Record<string, string> = { ...previous }
      if (write.secrets !== undefined) {
        for (const [field, value] of Object.entries(write.secrets)) {
          const trimmed = value.trim()
          if (!fields.includes(field)) continue
          if (trimmed === '') delete next[field]
          else next[field] = trimmed
        }
      }
      for (const field of write.clearSecretFields ?? []) delete next[field]
      if (Object.keys(next).length === 0) await this.#vault.delete(connectionId)
      else await this.#vault.set(connectionId, encodeSecrets(fields, next))
      return
    }
    if (write.credential !== undefined) {
      const value = write.credential.trim()
      if (value === '') throw new Error('Integration credential cannot be empty')
      if (fields.length <= 1) await this.#vault.set(connectionId, value)
      else {
        const previous = previousRaw === undefined ? {} : decodeSecrets(provider, previousRaw)
        await this.#vault.set(connectionId, encodeSecrets(fields, { ...previous, [fields[0]!]: value }))
      }
    }
  }

  async test(workspaceId: string, integrationId: string, connectionId?: string): Promise<IntegrationHealth> {
    const connection = connectionId === undefined
      ? this.get(workspaceId, integrationId)
      : this.getById(workspaceId, connectionId)
    if (connection === undefined || !connection.enabled) return { status: 'misconfigured', detail: '连接尚未启用', checkedAt: new Date().toISOString(), latencyMs: 0 }
    const provider = this.#registry.require(integrationId)
    const raw = this.#vault.resolve(connection.id)
    if (raw === undefined) {
      return provider.testConnection({ config: connection.config, fetch: this.#fetch, now: new Date() })
    }
    const single = singleSecret(provider, raw)
    return provider.testConnection({
      config: connection.config,
      ...(single === undefined ? {} : { credential: single }),
      secrets: decodeSecrets(provider, raw),
      fetch: this.#fetch,
      now: new Date(),
    })
  }

  async delete(workspaceId: string, integrationId: string, connectionId?: string): Promise<boolean> {
    const connection = connectionId === undefined
      ? this.get(workspaceId, integrationId)
      : this.getById(workspaceId, connectionId)
    if (connection === undefined) return false
    if (connection.integrationId !== integrationId) return false
    const previousRaw = this.#vault.resolve(connection.id)
    try {
      await this.#vault.delete(connection.id)
      this.#connections.delete(connection.id)
      await this.#persist()
    } catch (error) {
      this.#connections.set(connection.id, connection)
      if (previousRaw !== undefined) await this.#vault.set(connection.id, previousRaw).catch(() => undefined)
      throw error
    }
    return true
  }

  close(): void { this.#vault.close() }

  async #persist(): Promise<void> {
    const temporary = `${this.#path}.tmp-${randomUUID()}`
    const items = [...this.#connections.values()].map((item) => ({ ...item, credentialConfigured: false, secretsConfigured: undefined }))
    try { await writeFile(temporary, JSON.stringify({ version: 1, items }), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await rename(temporary, this.#path) }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
  }

  async #pruneExpiredMcpPayloads(now = Date.now()): Promise<void> {
    const expiry = now - 24 * 60 * 60_000
    for (const key of this.#vault.keys()) {
      const match = /^mcp-action:(\d+):/.exec(key)
      if (match !== null && Number(match[1]) < expiry) await this.#vault.delete(key)
    }
  }
}

async function readConnections(path: string): Promise<IntegrationConnection[]> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw new Error('Integration connection store cannot be read', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (value as ConnectionFile).version !== 1 || !Array.isArray((value as ConnectionFile).items)) {
    throw new Error('Integration connection store format is invalid')
  }
  return (value as ConnectionFile).items
}

/**
 * The vault stores one encrypted string per connection. Providers with a
 * single secret field keep the flat plaintext (Firecrawl/MCP legacy data).
 * Providers with several fields (SSH privateKey+password) store a small
 * prefixed JSON payload so the field mapping survives reloads.
 */
function secretFields(provider: IntegrationProvider): string[] {
  return provider.descriptor.secretFields.map((field) => field.id)
}

function encodeSecrets(fields: string[], secrets: Record<string, string>): string {
  if (fields.length <= 1) return secrets[fields[0]!] ?? ''
  const payload: StructuredSecrets = { version: 1, values: Object.fromEntries(fields.filter((field) => secrets[field] !== undefined && secrets[field]!.length > 0).map((field) => [field, secrets[field]!])) }
  return `${SECRET_PAYLOAD_PREFIX}${JSON.stringify(payload)}`
}

function decodeSecrets(provider: IntegrationProvider, raw: string): Record<string, string> {
  const fields = secretFields(provider)
  if (fields.length <= 1) return { [fields[0]!]: raw }
  if (!raw.startsWith(SECRET_PAYLOAD_PREFIX)) {
    // Legacy SSH connection saved before multi-secret support: the flat value
    // was the private key (its only field at the time).
    return { [fields[0]!]: raw }
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(SECRET_PAYLOAD_PREFIX.length))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed as StructuredSecrets).version === 1 && isRecord((parsed as StructuredSecrets).values)) {
      const values = (parsed as StructuredSecrets).values
      return Object.fromEntries(fields.filter((field) => typeof values[field] === 'string').map((field) => [field, values[field]!]))
    }
  } catch { /* fall through to legacy interpretation */ }
  return { [fields[0]!]: raw }
}

/** The provider's primary credential: the flat value for single-secret types, the first field (privateKey for SSH) for multi-secret types. */
function singleSecret(provider: IntegrationProvider, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const fields = secretFields(provider)
  if (fields.length <= 1) return raw
  return decodeSecrets(provider, raw)[fields[0]!]
}

/** Public, credential-free connection state: whether any/all secrets are configured. */
function secretState(provider: IntegrationProvider, raw: string | undefined): { credentialConfigured: boolean; secretsConfigured?: Record<string, boolean> } {
  const fields = secretFields(provider)
  if (raw === undefined) {
    return fields.length <= 1
      ? { credentialConfigured: false }
      : { credentialConfigured: false, secretsConfigured: Object.fromEntries(fields.map((field) => [field, false])) }
  }
  if (fields.length <= 1) return { credentialConfigured: true }
  const secrets = decodeSecrets(provider, raw)
  const configured = Object.fromEntries(fields.map((field) => [field, secrets[field] !== undefined]))
  return { credentialConfigured: Object.values(configured).some(Boolean), secretsConfigured: configured }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
