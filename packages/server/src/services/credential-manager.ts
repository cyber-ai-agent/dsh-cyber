import {
  CredentialRedactor,
  credentialVariable,
  credentialVariableForEnvironment,
  type AgentRuntimeEvent,
  type CredentialVariableDescriptor,
  type JsonObject,
  type JsonValue,
  type ModelProfile,
  type ModelProviderConnection,
} from '@dsh-cyber/contracts'

import type { IntegrationService } from '../integrations/integration-service.js'
import type { ModelCredentialService } from './model-credential-service.js'

export interface ModelCredentialReference {
  id: string
  workspaceId?: string
  envName?: string
}

export interface CredentialManagerOptions {
  modelCredentials: ModelCredentialService
  integrations: IntegrationService
  /** Model profiles and provider connections currently known to SQLite. */
  listModelReferences: () => readonly ModelCredentialReference[]
  environment?: NodeJS.ProcessEnv
}

/**
 * One host-owned credential facade for variables, execution resolution and
 * redaction. The two encrypted stores keep their existing migration boundaries;
 * this service gives every consumer one provider-neutral seam.
 */
export class CredentialManager {
  readonly #modelCredentials: ModelCredentialService
  readonly #integrations: IntegrationService
  readonly #listModelReferences: () => readonly ModelCredentialReference[]
  readonly #environment: NodeJS.ProcessEnv
  #cachedRedactor: CredentialRedactor | undefined
  #cachedAt = 0
  #cachedWorkspaceId: string | undefined

  constructor(options: CredentialManagerOptions) {
    this.#modelCredentials = options.modelCredentials
    this.#integrations = options.integrations
    this.#listModelReferences = options.listModelReferences
    this.#environment = options.environment ?? process.env
  }

  /** Build a short-lived value snapshot so token streaming stays inexpensive. */
  redactor(workspaceId?: string): CredentialRedactor {
    const now = Date.now()
    if (this.#cachedRedactor !== undefined && now - this.#cachedAt < 100 && this.#cachedWorkspaceId === workspaceId) return this.#cachedRedactor
    const redactor = new CredentialRedactor()
    const modelReferences = this.#listModelReferences()
    const allowedModelIds = workspaceId === undefined
      ? undefined
      : new Set(modelReferences.filter((reference) => reference.workspaceId === workspaceId).map((reference) => reference.id))
    for (const managed of this.#modelCredentials.managedValues()) {
      redactor.add(allowedModelIds === undefined || allowedModelIds.has(managed.profileId)
        ? { ...credentialVariableForEnvironment(managed.envName), value: managed.value }
        : externalCredential(managed.value))
    }
    const environmentNames = new Set([
      'DEEPSEEK_API_KEY',
      'DSH_CYBER_HOME_ASSISTANT_TOKEN',
      ...modelReferences
        .filter((reference) => workspaceId === undefined || reference.workspaceId === workspaceId)
        .flatMap((reference) => reference.envName === undefined ? [] : [reference.envName]),
    ])
    for (const envName of environmentNames) {
      const normalized = envName.trim()
      if (normalized === '') continue
      const value = this.#environment[normalized]
      if (value === undefined || value.trim() === '') continue
      redactor.add({ ...credentialVariableForEnvironment(normalized), value })
    }
    for (const reference of modelReferences) {
      const envName = reference.envName?.trim()
      if (envName === undefined || envName === '') continue
      const value = this.#environment[envName]
      if (value === undefined || value.trim() === '') continue
      if (workspaceId !== undefined && reference.workspaceId !== workspaceId) redactor.add(externalCredential(value))
    }
    for (const item of this.#integrations.credentialValues()) {
      const variable = this.variableForConnection(item.connectionId, item.field)
      redactor.add(workspaceId === undefined || item.workspaceId === workspaceId
        ? {
            ref: variable.ref,
            variable: variable.variable,
            value: item.value,
          }
        : externalCredential(item.value))
    }
    this.#cachedRedactor = redactor
    this.#cachedAt = now
    this.#cachedWorkspaceId = workspaceId
    return redactor
  }

  /** Force the next boundary to read the latest vault and environment values. */
  invalidate(): void {
    this.#cachedRedactor = undefined
    this.#cachedAt = 0
    this.#cachedWorkspaceId = undefined
  }

  /** Safe variable descriptors for settings and future skill declarations. */
  variables(workspaceId?: string): CredentialVariableDescriptor[] {
    return this.redactor(workspaceId).variables()
  }

  variableForEnvironment(envName: string): CredentialVariableDescriptor {
    return credentialVariableForEnvironment(envName)
  }

  variableForConnection(connectionId: string, field: string): CredentialVariableDescriptor {
    const ref = `integration:${connectionId}:${field}`
    return { ref, variable: credentialVariable(ref) }
  }

  redactText(value: string, workspaceId?: string): string {
    return this.redactor(workspaceId).text(value)
  }

  redactJson(value: JsonObject, workspaceId?: string): JsonObject {
    return this.redactor(workspaceId).json(value) as JsonObject
  }

  /** Sanitize the complete runtime envelope before persistence or SSE. */
  redactRuntimeEvent(event: AgentRuntimeEvent, workspaceId?: string): AgentRuntimeEvent {
    const redactor = this.redactor(workspaceId)
    return {
      ...event,
      ...(event.content === undefined ? {} : { content: redactor.text(event.content) }),
      ...(event.toolName === undefined ? {} : { toolName: redactor.text(event.toolName) }),
      ...(event.callId === undefined ? {} : { callId: redactor.text(event.callId) }),
      metadata: redactor.json(event.metadata) as JsonObject,
    }
  }

  /**
   * Resolve only variables belonging to one already-authorized integration
   * connection. The returned value is execution-local and must not be logged.
   */
  resolveConnectionJson(workspaceId: string, connectionId: string, value: JsonObject): JsonObject {
    const connection = this.#integrations.getById(workspaceId, connectionId)
    if (connection === undefined) return value
    const values = this.#integrations.credentialValues()
      .filter((item) => item.connectionId === connection.id)
      .map((item) => ({
        variable: this.variableForConnection(item.connectionId, item.field).variable,
        value: item.value,
      }))
    if (values.length === 0) return value
    return resolveJsonVariables(value, values)
  }

  /** Safe model references used by the composition root. */
  static referencesFromProfiles(
    profiles: readonly ModelProfile[],
    providers: readonly ModelProviderConnection[],
  ): ModelCredentialReference[] {
    const result: ModelCredentialReference[] = []
    for (const item of [...profiles, ...providers]) {
      const envName = item.credentialEnvName?.trim()
      if (envName !== undefined && envName !== '') result.push({ id: item.id, workspaceId: item.workspaceId, envName })
    }
    return result
  }
}

function externalCredential(value: string): { ref: string; variable: string; value: string } {
  return { ref: 'zz-external', variable: credentialVariable('external'), value }
}

function resolveJsonVariables(value: JsonObject, values: ReadonlyArray<{ variable: string; value: string }>): JsonObject {
  return resolveJsonValue(value, values) as JsonObject
}

function resolveJsonValue(value: JsonValue, values: ReadonlyArray<{ variable: string; value: string }>): JsonValue {
  if (typeof value === 'string') {
    return values.reduce((current, item) => current.split(item.variable).join(item.value), value)
  }
  if (Array.isArray(value)) return value.map((item) => resolveJsonValue(item, values))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveJsonValue(item, values)]))
  }
  return value
}
