import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { IntegrationConnection, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'
import { assertSecretFree } from '@dsh-cyber/persistence'

import type { IntegrationRegistry } from './integration-registry.js'
import { IntegrationSecretVault } from './integration-secret-vault.js'

interface ConnectionFile { version: 1; items: IntegrationConnection[] }

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
    for (const connection of await readConnections(service.#path)) {
      connection.config = registry.require(connection.integrationId).validateConfig(connection.config)
      assertSecretFree(connection.config)
      connection.credentialConfigured = service.#vault.has(connection.id)
      service.#connections.set(connection.id, connection)
    }
    return service
  }

  descriptors() { return this.#registry.list() }

  list(workspaceId: string): IntegrationConnection[] {
    return [...this.#connections.values()].filter((item) => item.workspaceId === workspaceId)
      .map((item) => ({ ...item, config: { ...item.config }, credentialConfigured: this.#vault.has(item.id) }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
  }

  get(workspaceId: string, integrationId: string): IntegrationConnection | undefined {
    return this.list(workspaceId).find((item) => item.integrationId === integrationId)
  }

  credential(workspaceId: string, integrationId: string): string | undefined {
    const connection = this.get(workspaceId, integrationId)
    return connection?.enabled === true ? this.#vault.resolve(connection.id) : undefined
  }

  async save(input: { workspaceId: string; integrationId: string; displayName?: string; config: JsonObject; enabled: boolean; credential?: string; clearCredential?: boolean }): Promise<IntegrationConnection> {
    const provider = this.#registry.require(input.integrationId)
    const existing = this.get(input.workspaceId, input.integrationId)
    const now = new Date().toISOString()
    const validatedConfig = provider.validateConfig(input.config)
    assertSecretFree(validatedConfig)
    const connection: IntegrationConnection = {
      id: existing?.id ?? randomUUID(), workspaceId: input.workspaceId, integrationId: input.integrationId,
      displayName: input.displayName?.trim() || provider.descriptor.displayName,
      config: validatedConfig, enabled: input.enabled,
      credentialConfigured: false, createdAt: existing?.createdAt ?? now, updatedAt: now,
    }
    const previousCredential = existing === undefined ? undefined : this.#vault.resolve(existing.id)
    try {
      if (input.credential !== undefined) await this.#vault.set(connection.id, input.credential)
      else if (input.clearCredential === true) await this.#vault.delete(connection.id)
      connection.credentialConfigured = this.#vault.has(connection.id)
      this.#connections.set(connection.id, connection)
      await this.#persist()
    } catch (error) {
      if (existing === undefined) this.#connections.delete(connection.id)
      else this.#connections.set(existing.id, existing)
      if (previousCredential === undefined) await this.#vault.delete(connection.id).catch(() => undefined)
      else await this.#vault.set(connection.id, previousCredential).catch(() => undefined)
      throw error
    }
    return { ...connection, config: { ...connection.config } }
  }

  async test(workspaceId: string, integrationId: string): Promise<IntegrationHealth> {
    const connection = this.get(workspaceId, integrationId)
    if (connection === undefined || !connection.enabled) return { status: 'misconfigured', detail: '连接尚未启用', checkedAt: new Date().toISOString(), latencyMs: 0 }
    const credential = this.#vault.resolve(connection.id)
    return this.#registry.require(integrationId).testConnection({
      config: connection.config,
      ...(credential === undefined ? {} : { credential }),
      fetch: this.#fetch,
      now: new Date(),
    })
  }

  async delete(workspaceId: string, integrationId: string): Promise<boolean> {
    const connection = this.get(workspaceId, integrationId)
    if (connection === undefined) return false
    const previousCredential = this.#vault.resolve(connection.id)
    try {
      await this.#vault.delete(connection.id)
      this.#connections.delete(connection.id)
      await this.#persist()
    } catch (error) {
      this.#connections.set(connection.id, connection)
      if (previousCredential !== undefined) await this.#vault.set(connection.id, previousCredential).catch(() => undefined)
      throw error
    }
    return true
  }

  close(): void { this.#vault.close() }

  async #persist(): Promise<void> {
    const temporary = `${this.#path}.tmp-${randomUUID()}`
    const items = [...this.#connections.values()].map((item) => ({ ...item, credentialConfigured: false }))
    try { await writeFile(temporary, JSON.stringify({ version: 1, items }), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await rename(temporary, this.#path) }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
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
