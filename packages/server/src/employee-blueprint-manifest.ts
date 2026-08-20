import type { EmployeeBlueprint } from '@dsh-cyber/contracts'

const BLUEPRINT_KEYS = new Set([
  'schemaVersion',
  'id',
  'version',
  'worldTemplateId',
  'displayName',
  'role',
  'summary',
  'persona',
  'requestedSkills',
  'requestedCapabilities',
  'createdAt',
])
const ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const TOKEN = /^[a-z][a-z0-9._-]*(?::[a-z][a-z0-9._-]*)?$/

export interface EmployeeBlueprintParseContext {
  packageId: string
  packageCapabilities: string[]
}

export function parseEmployeeBlueprintManifest(
  value: unknown,
  context: EmployeeBlueprintParseContext,
): EmployeeBlueprint {
  const input = object(value, 'employee blueprint')
  for (const key of Object.keys(input)) {
    if (!BLUEPRINT_KEYS.has(key)) throw new Error(`Unknown employee blueprint field: ${key}`)
  }
  if (input.schemaVersion !== 1) throw new Error('Employee blueprint schemaVersion must be 1')
  const id = text(input.id, 'id', 160, ID)
  if (id !== context.packageId) throw new Error('Employee blueprint id must match its package id')
  if (!Number.isSafeInteger(input.version) || (input.version as number) < 1) {
    throw new Error('Employee blueprint version must be a positive safe integer')
  }
  const worldTemplateId = text(input.worldTemplateId, 'worldTemplateId', 128, TOKEN)
  const displayName = text(input.displayName, 'displayName', 50)
  const role = text(input.role, 'role', 100)
  const summary = text(input.summary, 'summary', 500)
  const persona = text(input.persona, 'persona', 2_000)
  const requestedSkills = stringSet(input.requestedSkills, 'requestedSkills', 64, TOKEN)
  const requestedCapabilities = stringSet(input.requestedCapabilities, 'requestedCapabilities', 64, /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/)
  const packageCapabilities = new Set(context.packageCapabilities)
  for (const capability of requestedCapabilities) {
    if (!packageCapabilities.has(capability)) {
      throw new Error(`Employee blueprint capability is not declared by its package: ${capability}`)
    }
  }
  const createdAt = text(input.createdAt, 'createdAt', 64)
  const timestamp = Date.parse(createdAt)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== createdAt) {
    throw new Error('Employee blueprint createdAt must be a canonical ISO 8601 timestamp')
  }
  return {
    schemaVersion: 1,
    id,
    version: input.version as number,
    worldTemplateId,
    displayName,
    role,
    summary,
    persona,
    requestedSkills,
    requestedCapabilities,
    createdAt,
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Employee blueprint ${field} must be non-empty text of at most ${maximum} characters`)
  }
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`Invalid employee blueprint ${field}`)
  return value
}

function stringSet(value: unknown, field: string, maximum: number, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Employee blueprint ${field} must contain at most ${maximum} items`)
  }
  const result = value.map((item, index) => text(item, `${field}[${index}]`, 128, pattern))
  if (new Set(result).size !== result.length) throw new Error(`Employee blueprint ${field} must be unique`)
  return result
}
