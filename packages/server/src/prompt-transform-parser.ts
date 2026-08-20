export const PROMPT_TRANSFORM_SCHEMA_VERSION = 1 as const

export type PromptTransformMode = 'prepend' | 'append' | 'replace'

export interface PromptTransform {
  id: string
  trigger: string
  description: string
  instruction: string
  mode: PromptTransformMode
  priority: number
}

export interface PromptTransformDefinition {
  schemaVersion: typeof PROMPT_TRANSFORM_SCHEMA_VERSION
  transforms: PromptTransform[]
}

export const PROMPT_TRANSFORM_LIMITS = {
  maxTransforms: 64,
  maxIdLength: 64,
  maxTriggerLength: 64,
  maxDescriptionLength: 200,
  maxInstructionLength: 2_000,
  maxTextBytes: 256 * 1024,
} as const

const MODES = new Set<PromptTransformMode>(['prepend', 'append', 'replace'])

export class PromptTransformManifestError extends Error {
  constructor(message: string) {
    super(`Invalid prompt-transform manifest: ${message}`)
    this.name = 'PromptTransformManifestError'
  }
}

/**
 * Parse the canonical declarative transform entrypoint. The only compatibility
 * exception is the old `commands` shape, which is normalized to canonical
 * prepend transforms; no package code is ever evaluated.
 */
export function parsePromptTransformDefinition(value: unknown): PromptTransformDefinition {
  const root = objectRecord(value, 'entrypoint must be an object')
  if (root.schemaVersion !== PROMPT_TRANSFORM_SCHEMA_VERSION) {
    throw new PromptTransformManifestError('schemaVersion must be 1')
  }
  const hasTransforms = Object.prototype.hasOwnProperty.call(root, 'transforms')
  const hasCommands = Object.prototype.hasOwnProperty.call(root, 'commands')
  if (hasTransforms && hasCommands) {
    throw new PromptTransformManifestError('transforms and legacy commands cannot both be present')
  }
  if (hasTransforms) return parseCanonical(root)
  if (hasCommands) return parseLegacy(root)
  throw new PromptTransformManifestError('entrypoint must contain transforms')
}

function parseCanonical(root: Record<string, unknown>): PromptTransformDefinition {
  assertExactKeys(root, ['schemaVersion', 'transforms'])
  const values = root.transforms
  if (!Array.isArray(values)) throw new PromptTransformManifestError('transforms must be an array')
  if (values.length === 0) throw new PromptTransformManifestError('transforms must contain at least one item')
  if (values.length > PROMPT_TRANSFORM_LIMITS.maxTransforms) {
    throw new PromptTransformManifestError(`transforms must contain at most ${PROMPT_TRANSFORM_LIMITS.maxTransforms} items`)
  }
  const transforms = values.map((value, index) => parseTransform(value, index))
  assertUnique(transforms.map((transform) => transform.id), 'transform id')
  assertTextBudget(transforms)
  return { schemaVersion: PROMPT_TRANSFORM_SCHEMA_VERSION, transforms }
}

function parseLegacy(root: Record<string, unknown>): PromptTransformDefinition {
  assertExactKeys(root, ['schemaVersion', 'commands'])
  const values = root.commands
  if (!Array.isArray(values)) throw new PromptTransformManifestError('legacy commands must be an array')
  if (values.length === 0) throw new PromptTransformManifestError('legacy commands must contain at least one item')
  if (values.length > PROMPT_TRANSFORM_LIMITS.maxTransforms) {
    throw new PromptTransformManifestError(`legacy commands must contain at most ${PROMPT_TRANSFORM_LIMITS.maxTransforms} items`)
  }
  const transforms = values.map((value, index) => {
    const command = objectRecord(value, `legacy command ${index + 1} must be an object`)
    assertExactKeys(command, ['trigger', 'instruction'])
    const trigger = boundedString(command.trigger, 'trigger', PROMPT_TRANSFORM_LIMITS.maxTriggerLength)
    const instruction = boundedString(command.instruction, 'instruction', PROMPT_TRANSFORM_LIMITS.maxInstructionLength)
    assertTrigger(trigger)
    assertPlainText(instruction, 'instruction')
    return {
      id: `legacy-command-${index + 1}`,
      trigger,
      description: `Legacy prompt transform command ${index + 1}`,
      instruction,
      mode: 'prepend' as const,
      priority: 0,
    }
  })
  assertTextBudget(transforms)
  return { schemaVersion: PROMPT_TRANSFORM_SCHEMA_VERSION, transforms }
}

function parseTransform(value: unknown, index: number): PromptTransform {
  const input = objectRecord(value, `transform ${index + 1} must be an object`)
  assertKeys(input, ['id', 'trigger', 'description', 'instruction', 'mode'], ['priority'])
  const id = boundedString(input.id, 'id', PROMPT_TRANSFORM_LIMITS.maxIdLength)
  const trigger = boundedString(input.trigger, 'trigger', PROMPT_TRANSFORM_LIMITS.maxTriggerLength)
  const description = boundedString(input.description, 'description', PROMPT_TRANSFORM_LIMITS.maxDescriptionLength)
  const instruction = boundedString(input.instruction, 'instruction', PROMPT_TRANSFORM_LIMITS.maxInstructionLength)
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new PromptTransformManifestError(`transform ${index + 1} id must be lowercase ASCII hyphenated text`)
  }
  assertTrigger(trigger)
  assertPlainText(description, 'description')
  assertPlainText(instruction, 'instruction')
  if (typeof input.mode !== 'string' || !MODES.has(input.mode as PromptTransformMode)) {
    throw new PromptTransformManifestError(`transform ${index + 1} mode must be prepend, append, or replace`)
  }
  const priority = input.priority === undefined ? 0 : input.priority
  if (
    typeof priority !== 'number' ||
    !Number.isSafeInteger(priority)
  ) {
    throw new PromptTransformManifestError(`transform ${index + 1} priority must be a finite safe integer`)
  }
  return { id, trigger, description, instruction, mode: input.mode as PromptTransformMode, priority }
}

function assertTrigger(value: string): void {
  if (value !== 'always' && !/^\/[a-z0-9-]+$/.test(value)) {
    throw new PromptTransformManifestError('trigger must be always or a lowercase /command')
  }
}

function assertPlainText(value: string, field: string): void {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new PromptTransformManifestError(`${field} contains control characters`)
  }
}

function assertTextBudget(transforms: readonly PromptTransform[]): void {
  const bytes = transforms.reduce(
    (total, transform) => total + Buffer.byteLength(transform.id) + Buffer.byteLength(transform.trigger) +
      Buffer.byteLength(transform.description) + Buffer.byteLength(transform.instruction),
    0,
  )
  if (bytes > PROMPT_TRANSFORM_LIMITS.maxTextBytes) {
    throw new PromptTransformManifestError(`transform text exceeds ${PROMPT_TRANSFORM_LIMITS.maxTextBytes} bytes`)
  }
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PromptTransformManifestError(`${field} must be a non-empty string`)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new PromptTransformManifestError(`${field} exceeds ${maxLength} characters`)
  }
  return normalized
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PromptTransformManifestError(message)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected)
  const keys = Object.keys(value)
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new PromptTransformManifestError(`unexpected or missing fields; expected ${expected.join(', ')}`)
  }
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new PromptTransformManifestError(`unexpected or missing fields; expected ${[...required, ...optional].join(', ')}`)
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new PromptTransformManifestError(`duplicate ${label}`)
}
