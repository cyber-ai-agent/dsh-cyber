import type { JsonValue } from './index.js'
import { redactCredentialPatternText } from './tool-trace.js'

/** Worker-only environment variable carrying descriptor metadata, never values. */
export const CREDENTIAL_VARIABLES_ENV = 'DSH_CYBER_CREDENTIAL_VARIABLES'

/** A safe name that can travel through prompts, tool results and trace rows. */
export interface CredentialVariableDescriptor {
  /** Stable host-owned reference; it contains no credential value. */
  ref: string
  /** Prompt-safe placeholder, for example `${credential.environment.api-key}`. */
  variable: string
  /** Process environment name when the variable is materialized for a worker. */
  envName?: string
}

/** An in-memory value bound to a safe variable. Never serialize this shape. */
export interface CredentialSecretEntry extends CredentialVariableDescriptor {
  value: string
}

const SENSITIVE_CREDENTIAL_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passphrase|secret|api[-_]?key|access[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|token|credential|credentials)$/i

/** Stable placeholder formatting shared by host services and worker bundles. */
export function credentialVariable(ref: string): string {
  const normalized = ref
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '')
    .slice(0, 160)
  return `\${credential.${normalized || 'unknown'}}`
}

/** Build a safe descriptor for an environment-backed credential. */
export function credentialVariableForEnvironment(envName: string): CredentialVariableDescriptor {
  const name = envName.trim()
  return {
    ref: `environment:${name}`,
    variable: credentialVariable(`environment:${name.toLowerCase()}`),
    ...(name === '' ? {} : { envName: name }),
  }
}

/** True for JSON keys whose values receive credential treatment. */
export function isSensitiveCredentialKey(key: string): boolean {
  return SENSITIVE_CREDENTIAL_KEY.test(key)
}

/**
 * Redacts registered values first, then applies credential-shaped fallbacks.
 * Registered values become stable variables; unknown patterns receive the
 * generic marker from the tool-trace policy.
 */
export class CredentialRedactor {
  readonly #entries = new Map<string, CredentialSecretEntry>()

  constructor(entries: readonly CredentialSecretEntry[] = []) {
    for (const entry of entries) this.add(entry)
  }

  add(entry: CredentialSecretEntry): void {
    const value = entry.value
    if (value.length === 0) return
    const ref = entry.ref.trim() || `value:${value.length}`
    const variable = entry.variable.trim() || credentialVariable(ref)
    const current = this.#entries.get(value)
    if (current === undefined || ref.localeCompare(current.ref) < 0) {
      this.#entries.set(value, { ref, variable, ...(entry.envName === undefined ? {} : { envName: entry.envName }), value })
    }
  }

  text(value: string): string {
    let output = value
    const entries = [...this.#entries.values()].sort((left, right) => right.value.length - left.value.length || left.ref.localeCompare(right.ref))
    for (const entry of entries) output = output.split(entry.value).join(entry.variable)
    return redactCredentialPatternText(output)
  }

  json(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.text(value)
    if (Array.isArray(value)) return value.map((item) => this.json(item))
    if (value !== null && typeof value === 'object') {
      const output: Record<string, JsonValue> = {}
      for (const [key, item] of Object.entries(value)) {
        if (isSensitiveCredentialKey(key) && typeof item === 'string') {
          const safe = this.text(item)
          output[key] = safe === item ? '[已隐藏敏感信息]' : safe
        } else output[key] = this.json(item)
      }
      return output
    }
    return value
  }

  variables(): CredentialVariableDescriptor[] {
    return [...this.#entries.values()]
      .map(({ ref, variable, envName }) => ({ ref, variable, ...(envName === undefined ? {} : { envName }) }))
      .sort((left, right) => left.ref.localeCompare(right.ref))
  }
}

/** Parse the worker's descriptor-only variable map. */
export function parseCredentialVariableDescriptors(value: string | undefined): CredentialVariableDescriptor[] {
  if (value === undefined || value.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    const result: CredentialVariableDescriptor[] = []
    for (const item of parsed) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const record = item as Record<string, unknown>
      if (typeof record.ref !== 'string' || typeof record.variable !== 'string') continue
      if (!/^\$\{credential\.[a-zA-Z0-9._-]{1,160}\}$/.test(record.variable)) continue
      if (record.envName !== undefined && (typeof record.envName !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(record.envName))) continue
      result.push({ ref: record.ref.slice(0, 200), variable: record.variable, ...(typeof record.envName === 'string' ? { envName: record.envName } : {}) })
    }
    return result
  } catch {
    return []
  }
}
