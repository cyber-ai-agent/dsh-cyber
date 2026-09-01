import type { EmployeeBlueprint } from '@dsh-cyber/contracts'

import { parseEmbodimentProfile } from './embodiment-profile.js'

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
  'embodiment',
  'fallbackAvatarIndex',
  'avatarPreviewPath',
  'createdAt',
])
const ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const TOKEN = /^[a-z][a-z0-9._-]*(?::[a-z][a-z0-9._-]*)?$/
/**
 * Package content is untrusted. Rather than sanitizing an arbitrary path, only
 * the compiler's own fixed preview file names are admitted, so a blueprint can
 * never point the avatar reader at another file inside or outside its package.
 */
const AVATAR_PREVIEW_PATH = /^preview\.(?:png|jpg|webp)$/

/**
 * The V1 host-owned allowlist of capabilities an EmployeeBlueprint may REQUEST.
 *
 * This is a fixed, hardcoded safe set owned by the host. It is never derived
 * from a package manifest, never proposed by a model, and deliberately not a
 * dynamic registry. A request is not a grant: the user approves the actual
 * employee grants in recruitment, and persistence keeps every grant a subset
 * of this request.
 */
export const EMPLOYEE_REQUESTABLE_CAPABILITIES: readonly string[] = [
  'workspace:read',
  'knowledge:read',
  'artifact:read',
] as const

const REQUESTABLE_CAPABILITY_SET = new Set<string>(EMPLOYEE_REQUESTABLE_CAPABILITIES)

export interface EmployeeBlueprintParseContext {
  packageId: string
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
  // A blueprint's requested capabilities are bounded by the host allowlist, not
  // by what the package declared for its own installation. CyberPackageManifest
  // .capabilities is what installing THIS PACKAGE needs; an employee's request
  // is a separate layer the user approves per employee during recruitment.
  for (const capability of requestedCapabilities) {
    if (!REQUESTABLE_CAPABILITY_SET.has(capability)) {
      throw new Error(`Employee blueprint capability is not host-allowed: ${capability}`)
    }
  }
  const createdAt = text(input.createdAt, 'createdAt', 64)
  const timestamp = Date.parse(createdAt)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== createdAt) {
    throw new Error('Employee blueprint createdAt must be a canonical ISO 8601 timestamp')
  }
  const blueprint: EmployeeBlueprint = {
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
  if (input.embodiment !== undefined) blueprint.embodiment = parseEmbodimentProfile(input.embodiment)
  if (input.fallbackAvatarIndex !== undefined) {
    const index = input.fallbackAvatarIndex
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 7) {
      throw new Error('Employee blueprint fallbackAvatarIndex must be an integer between 0 and 7')
    }
    blueprint.fallbackAvatarIndex = index
  }
  if (input.avatarPreviewPath !== undefined) {
    const path = input.avatarPreviewPath
    if (typeof path !== 'string' || !AVATAR_PREVIEW_PATH.test(path)) {
      throw new Error('Employee blueprint avatarPreviewPath must name a declared preview image')
    }
    blueprint.avatarPreviewPath = path
  }
  return blueprint
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
