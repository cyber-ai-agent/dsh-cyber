import type { SkillCatalogSource } from '@dsh-cyber/contracts/skill-runtime'

const SKILL_KEYS = new Set([
  'schemaVersion',
  'id',
  'displayName',
  'summary',
  'integrationId',
  'dataEgress',
  'instructions',
])
const ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const MAX_EGRESS_ITEMS = 128
const MAX_EGRESS_LENGTH = 512
const MAX_INSTRUCTIONS_LENGTH = 4_000

/** The declaration stored in a package `skill` entrypoint. */
export interface SkillManifest {
  schemaVersion: 1
  id: string
  displayName: string
  summary: string
  integrationId: string
  dataEgress: string[]
  instructions: string
}

export interface SkillManifestParseContext {
  packageId: string
  entrypointId: string
}

/**
 * A safe package declaration is metadata only. It never becomes an adapter
 * or an executable callback; a trusted host adapter must still own execution.
 */
export function parseSkillManifest(value: unknown, context: SkillManifestParseContext): SkillManifest {
  const input = object(value, 'skill manifest')
  for (const key of Object.keys(input)) {
    if (!SKILL_KEYS.has(key)) throw new Error(`Unknown skill manifest field: ${key}`)
  }
  if (input.schemaVersion !== 1) throw new Error('Skill manifest schemaVersion must be 1')
  const id = text(input.id, 'id', 160, ID)
  if (id !== context.entrypointId) throw new Error('Skill manifest id must match its entrypoint id')
  if (!ID.test(context.packageId)) throw new Error('Skill package id is invalid')
  const displayName = text(input.displayName, 'displayName', 100)
  const summary = text(input.summary, 'summary', 500)
  const integrationId = text(input.integrationId, 'integrationId', 160, ID)
  const dataEgress = stringSet(input.dataEgress, 'dataEgress', MAX_EGRESS_ITEMS, MAX_EGRESS_LENGTH)
  const instructions = text(input.instructions, 'instructions', MAX_INSTRUCTIONS_LENGTH)
  return { schemaVersion: 1, id, displayName, summary, integrationId, dataEgress, instructions }
}

/** Infer only the catalog label; this does not select or instantiate an adapter. */
export function skillSourceFromAdapter(adapterId: string, kind: 'recipe' | 'integration' | undefined): SkillCatalogSource {
  if (kind === 'recipe' || adapterId === 'builtin.recipe') return 'builtin'
  if (adapterId === 'builtin.mcp' || adapterId.startsWith('mcp.')) return 'mcp'
  return 'other'
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Skill manifest ${field} must be non-empty text of at most ${maximum} characters`)
  }
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`Invalid skill manifest ${field}`)
  return value
}

function stringSet(value: unknown, field: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`Skill manifest ${field} must contain at most ${maximumItems} items`)
  }
  const result = value.map((item, index) => text(item, `${field}[${index}]`, maximumLength))
  if (new Set(result).size !== result.length) throw new Error(`Skill manifest ${field} must be unique`)
  return result
}
