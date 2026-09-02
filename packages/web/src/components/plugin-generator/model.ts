import type {
  CharacterSourceInput,
  PluginDraft,
  PluginGeneratorCatalog,
  PluginGeneratorLimits,
  PluginGeneratorPublishResult,
  PluginGeneratorReservedTrigger,
  PluginTransformDraft,
  PluginTransformMode,
} from '@dsh-cyber/contracts'
import { validateCharacterSource } from '../character-generator/model.js'

export type { PluginDraft, PluginGeneratorCatalog, PluginTransformDraft, PluginTransformMode } from '@dsh-cyber/contracts'

export type PluginGeneratorStep = 'source' | 'analysis' | 'preview' | 'publish'

export interface PluginGeneratorProps {
  workspaceId: string
  onClose(): void
  onPublished(result: PluginGeneratorPublishResult): Promise<void> | void
  closeRequest?: number
}

/** The three modes the runtime parser accepts, in the order the editor offers them. */
export const PLUGIN_TRANSFORM_MODES: readonly PluginTransformMode[] = ['prepend', 'append', 'replace']
/** Same literal the server's generated-plugin rule accepts: one lowercase slash command. */
export const PLUGIN_TRIGGER = /^\/[a-z0-9-]+$/u
/**
 * The runtime parser's limits as the server projects them through the
 * catalog endpoint. These only cover the moment before the catalog answers;
 * the server re-validates every field against the parser regardless.
 */
export const DEFAULT_PLUGIN_LIMITS: PluginGeneratorLimits = {
  maxTransforms: 64,
  maxIdLength: 64,
  maxTriggerLength: 64,
  maxDescriptionLength: 200,
  maxInstructionLength: 2_000,
}
export const EMPTY_PLUGIN_CATALOG: PluginGeneratorCatalog = { limits: { ...DEFAULT_PLUGIN_LIMITS }, modes: [...PLUGIN_TRANSFORM_MODES], reservedTriggers: [] }
const MODE_SET = new Set<string>(PLUGIN_TRANSFORM_MODES)

export function initialPluginDraft(): PluginDraft {
  return { schemaVersion: 1, displayName: '', summary: '', transforms: [], sourceSummary: '', sourceRefs: [] }
}

export function emptyTransform(): PluginTransformDraft {
  return { id: '', trigger: '/', description: '', instruction: '', mode: 'prepend', priority: 0 }
}

/** Same source rules as the Character Generator; the wire shape is shared. */
export const validatePluginSource: (source: CharacterSourceInput) => string | undefined = validateCharacterSource

/** Lowercase, trimmed, with exactly one leading slash; validation reports whatever is still wrong. */
export function normalizeTrigger(value: string): string {
  return `/${value.trim().toLowerCase().replace(/^\/+/u, '')}`
}

export function transformIdFromTrigger(trigger: string): string {
  return normalizeTrigger(trigger).slice(1)
}

export function reservedTriggerOwner(trigger: string, catalog: PluginGeneratorCatalog): PluginGeneratorReservedTrigger | undefined {
  const normalized = normalizeTrigger(trigger)
  return catalog.reservedTriggers.find((item) => item.trigger === normalized)
}

/** The first thing wrong with one transform, as a message key; undefined when it is publishable. */
export function transformIssue(transform: PluginTransformDraft, index: number, draft: PluginDraft, catalog: PluginGeneratorCatalog): string | undefined {
  const { limits } = catalog
  const trigger = normalizeTrigger(transform.trigger)
  if (!PLUGIN_TRIGGER.test(trigger) || trigger.length > limits.maxTriggerLength) return 'transform.triggerInvalid'
  if (draft.transforms.some((other, otherIndex) => otherIndex < index && normalizeTrigger(other.trigger) === trigger)) return 'transform.triggerDuplicate'
  if (reservedTriggerOwner(trigger, catalog) !== undefined) return 'transform.triggerReserved'
  const description = transform.description.trim()
  if (description.length === 0) return 'transform.descriptionRequired'
  if (description.length > limits.maxDescriptionLength) return 'transform.descriptionTooLong'
  const instruction = transform.instruction.trim()
  if (instruction.length === 0) return 'transform.instructionRequired'
  if (instruction.length > limits.maxInstructionLength) return 'transform.instructionTooLong'
  if (!MODE_SET.has(transform.mode)) return 'transform.modeInvalid'
  if (!Number.isSafeInteger(transform.priority)) return 'transform.priorityInvalid'
  return undefined
}

export function validatePluginDraft(draft: PluginDraft, catalog: PluginGeneratorCatalog = EMPTY_PLUGIN_CATALOG): string | undefined {
  if (draft.schemaVersion !== 1) return 'draft.invalidVersion'
  if (draft.displayName.trim().length === 0) return 'draft.displayNameRequired'
  if (draft.displayName.trim().length > 100) return 'draft.displayNameTooLong'
  if (draft.summary.trim().length === 0) return 'draft.summaryRequired'
  if (draft.summary.trim().length > 500) return 'draft.summaryTooLong'
  if (draft.transforms.length === 0) return 'draft.transformsEmpty'
  if (draft.transforms.length > catalog.limits.maxTransforms) return 'draft.transformsTooMany'
  for (const [index, transform] of draft.transforms.entries()) {
    const issue = transformIssue(transform, index, draft, catalog)
    if (issue !== undefined) return issue
  }
  return undefined
}

/**
 * Rebuild a draft from anything the server or a stub returned. Only the six
 * transform fields survive; a mode or priority the host cannot read becomes
 * the default for the user to review, never a value passed through.
 */
export function normalizePluginDraft(value: unknown): PluginDraft {
  const record = isRecord(value) ? value : {}
  return {
    schemaVersion: 1,
    displayName: readString(record.displayName ?? record.name),
    summary: readString(record.summary ?? record.description),
    transforms: readArray(record.transforms).map(normalizeTransform).filter(isDefined),
    sourceSummary: readString(record.sourceSummary),
    sourceRefs: unique(readStringArray(record.sourceRefs)),
  }
}

export function normalizePluginCatalog(value: unknown): PluginGeneratorCatalog {
  const root = isRecord(value) && isRecord(value.catalog) ? value.catalog : value
  const record = isRecord(root) ? root : {}
  const limits = isRecord(record.limits) ? record.limits : {}
  const readLimit = (key: keyof PluginGeneratorLimits): number => {
    const candidate = limits[key]
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : DEFAULT_PLUGIN_LIMITS[key]
  }
  return {
    limits: {
      maxTransforms: readLimit('maxTransforms'),
      maxIdLength: readLimit('maxIdLength'),
      maxTriggerLength: readLimit('maxTriggerLength'),
      maxDescriptionLength: readLimit('maxDescriptionLength'),
      maxInstructionLength: readLimit('maxInstructionLength'),
    },
    modes: [...PLUGIN_TRANSFORM_MODES],
    reservedTriggers: readArray(record.reservedTriggers).map(normalizeReserved).filter(isDefined),
  }
}

export function trimPluginDraft(draft: PluginDraft): PluginDraft {
  return {
    ...draft,
    schemaVersion: 1,
    displayName: draft.displayName.trim(),
    summary: draft.summary.trim(),
    transforms: draft.transforms.map((transform) => {
      const trigger = normalizeTrigger(transform.trigger)
      return {
        id: transformIdFromTrigger(trigger),
        trigger,
        description: transform.description.trim(),
        instruction: transform.instruction.replace(/\r\n?/gu, '\n').trim(),
        mode: MODE_SET.has(transform.mode) ? transform.mode : 'prepend',
        priority: Number.isSafeInteger(transform.priority) ? transform.priority : 0,
      }
    }),
    sourceSummary: draft.sourceSummary.trim(),
    sourceRefs: unique(draft.sourceRefs.filter(Boolean)),
  }
}

/**
 * The runtime prompt a transform produces for one sample message — the same
 * composition `applyInstalledPromptTransforms` makes when this transform is
 * the only match: prepend and append join with a blank line, replace
 * substitutes the instruction for the message.
 */
export function previewPrompt(transform: PluginTransformDraft, message: string): string {
  const instruction = transform.instruction.trim()
  if (transform.mode === 'replace') return instruction
  return transform.mode === 'append' ? `${message}\n\n${instruction}` : `${instruction}\n\n${message}`
}

function normalizeTransform(value: unknown): PluginTransformDraft | undefined {
  if (!isRecord(value)) return undefined
  const trigger = readString(value.trigger)
  return {
    id: readString(value.id) || transformIdFromTrigger(trigger),
    trigger,
    description: readString(value.description),
    instruction: readString(value.instruction),
    mode: typeof value.mode === 'string' && MODE_SET.has(value.mode) ? value.mode as PluginTransformMode : 'prepend',
    priority: typeof value.priority === 'number' && Number.isSafeInteger(value.priority) ? value.priority : 0,
  }
}

function normalizeReserved(value: unknown): PluginGeneratorReservedTrigger | undefined {
  if (!isRecord(value) || typeof value.trigger !== 'string' || typeof value.packageId !== 'string') return undefined
  return { trigger: value.trigger, packageId: value.packageId, displayName: readString(value.displayName) || value.packageId }
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
