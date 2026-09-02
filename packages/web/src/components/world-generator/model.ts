import type {
  CharacterBlueprintDraft,
  CharacterSourceInput,
  WorldGeneratorCatalog,
  WorldGeneratorPublishResult,
  WorldGeneratorSceneCatalogItem,
  WorldGeneratorSceneSelection,
  WorldThemeDraft,
} from '@dsh-cyber/contracts'
import { normalizeSkillCatalogEntry } from '../skill-catalog.js'
import { normalizeDraft as normalizeCharacterDraft, validateCharacterDraft, validateCharacterSource } from '../character-generator/model.js'

export type WorldGeneratorStep = 'source' | 'analysis' | 'preview' | 'publish'

export interface WorldGeneratorProps {
  workspaceId: string
  onClose(): void
  onPublished(result: WorldGeneratorPublishResult): Promise<void> | void
  closeRequest?: number
}

export const WORLD_THEME_MAX_CAST = 8
export const WORLD_THEME_MAX_WORKFLOW_STEPS = 12
export const WORLD_THEME_MAX_RULES = 12
/** The theme installer's image limit; the server refuses anything larger before decoding it. */
export const WORLD_BACKGROUND_MAX_BYTES = 4 * 1024 * 1024
const MAX_TERM = 40

export const EMPTY_WORLD_CATALOG: WorldGeneratorCatalog = {
  targetWorldTemplateId: 'personal-world',
  scenes: [],
  skills: [],
  capabilities: [],
}

export function initialWorldDraft(targetWorldTemplateId: string): WorldThemeDraft {
  return {
    schemaVersion: 1,
    targetWorldTemplateId,
    displayName: '',
    summary: '',
    terminology: { world: '', participant: '', session: '', milestone: '' },
    workflow: [],
    rules: [],
    cast: [],
    sourceSummary: '',
    sourceRefs: [],
  }
}

/** Same source rules as the Character Generator; the wire shape is shared. */
export const validateWorldSource: (source: CharacterSourceInput) => string | undefined = validateCharacterSource

export function validateWorldDraft(draft: WorldThemeDraft, catalog?: WorldGeneratorCatalog): string | undefined {
  if (draft.schemaVersion !== 1 || draft.targetWorldTemplateId.trim().length === 0) return 'draft.invalidVersion'
  if (draft.displayName.trim().length === 0) return 'draft.displayNameRequired'
  if (draft.displayName.trim().length > 100) return 'draft.displayNameTooLong'
  if (draft.summary.trim().length === 0) return 'draft.summaryRequired'
  if (draft.summary.trim().length > 500) return 'draft.summaryTooLong'
  for (const value of Object.values(draft.terminology)) {
    if (value.trim().length === 0) return 'draft.terminologyRequired'
    if (value.trim().length > MAX_TERM) return 'draft.fieldTooLong'
  }
  if (draft.workflow.length > WORLD_THEME_MAX_WORKFLOW_STEPS || draft.workflow.some((step) => step.trim().length > 40)) return 'draft.fieldTooLong'
  if (draft.rules.length > WORLD_THEME_MAX_RULES || draft.rules.some((rule) => rule.trim().length > 200)) return 'draft.fieldTooLong'
  if (draft.cast.length > WORLD_THEME_MAX_CAST) return 'draft.castTooLarge'
  const names = new Set<string>()
  for (const member of draft.cast) {
    const memberError = validateCharacterDraft(member, catalog === undefined ? undefined : { skills: catalog.skills, capabilities: catalog.capabilities, avatars: [] })
    if (memberError !== undefined) return `cast.${memberError}`
    const name = member.displayName.trim()
    if (names.has(name)) return 'draft.castDuplicate'
    names.add(name)
  }
  return undefined
}

export function normalizeWorldDraft(value: unknown, targetWorldTemplateId: string): WorldThemeDraft {
  const record = isRecord(value) ? value : {}
  const terminology = isRecord(record.terminology) ? record.terminology : {}
  const target = readString(record.targetWorldTemplateId) || targetWorldTemplateId
  return {
    schemaVersion: 1,
    targetWorldTemplateId: target,
    displayName: readString(record.displayName ?? record.name),
    summary: readString(record.summary ?? record.description),
    terminology: {
      world: readString(terminology.world),
      participant: readString(terminology.participant),
      session: readString(terminology.session),
      milestone: readString(terminology.milestone),
    },
    workflow: unique(readStringArray(record.workflow)),
    rules: unique(readStringArray(record.rules)),
    cast: readArray(record.cast).map((member) => normalizeCharacterDraft(member, target)).slice(0, WORLD_THEME_MAX_CAST),
    sourceSummary: readString(record.sourceSummary),
    sourceRefs: unique(readStringArray(record.sourceRefs)),
  }
}

export function normalizeWorldCatalog(value: unknown): WorldGeneratorCatalog {
  const root = isRecord(value) && isRecord(value.catalog) ? value.catalog : value
  const record = isRecord(root) ? root : {}
  return {
    targetWorldTemplateId: readString(record.targetWorldTemplateId) || EMPTY_WORLD_CATALOG.targetWorldTemplateId,
    scenes: readArray(record.scenes).map(normalizeScene).filter(isDefined),
    skills: readArray(record.skills).map(normalizeSkillCatalogEntry).filter(isDefined),
    capabilities: readArray(record.capabilities).flatMap((item) => {
      if (!isRecord(item) || (item.id !== 'workspace:read' && item.id !== 'knowledge:read' && item.id !== 'artifact:read')) return []
      return [{ id: item.id, displayName: readString(item.displayName) || item.id, summary: readString(item.summary) }]
    }),
  }
}

export function trimWorldDraft(draft: WorldThemeDraft): WorldThemeDraft {
  return {
    ...draft,
    schemaVersion: 1,
    targetWorldTemplateId: draft.targetWorldTemplateId.trim(),
    displayName: draft.displayName.trim(),
    summary: draft.summary.trim(),
    terminology: {
      world: draft.terminology.world.trim(),
      participant: draft.terminology.participant.trim(),
      session: draft.terminology.session.trim(),
      milestone: draft.terminology.milestone.trim(),
    },
    workflow: unique(draft.workflow.map((step) => step.trim()).filter(Boolean)),
    rules: unique(draft.rules.map((rule) => rule.trim()).filter(Boolean)),
    cast: draft.cast.map(trimCastMember),
    sourceSummary: draft.sourceSummary.trim(),
    sourceRefs: unique(draft.sourceRefs.filter(Boolean)),
  }
}

export function emptyCastMember(targetWorldTemplateId: string): CharacterBlueprintDraft {
  return {
    schemaVersion: 1,
    targetWorldTemplateId,
    displayName: '',
    role: '',
    summary: '',
    persona: '',
    personalityTraits: [],
    background: '',
    requestedSkillIds: [],
    requestedCapabilities: [],
    sourceSummary: '',
    sourceRefs: [],
  }
}

export function defaultSceneSelection(catalog: WorldGeneratorCatalog, suggested?: string): WorldGeneratorSceneSelection | undefined {
  const pick = catalog.scenes.find((scene) => scene.id === suggested) ?? catalog.scenes[0]
  return pick === undefined ? undefined : { kind: 'official', id: pick.id }
}

function trimCastMember(member: CharacterBlueprintDraft): CharacterBlueprintDraft {
  return {
    ...member,
    displayName: member.displayName.trim(),
    role: member.role.trim(),
    summary: member.summary.trim(),
    persona: member.persona.trim(),
    background: member.background.trim(),
    personalityTraits: unique(member.personalityTraits.map((trait) => trait.trim()).filter(Boolean)),
    requestedSkillIds: unique(member.requestedSkillIds.filter(Boolean)),
    requestedCapabilities: [...new Set(member.requestedCapabilities.filter(Boolean))],
  }
}

function normalizeScene(value: unknown): WorldGeneratorSceneCatalogItem | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.packageId !== 'string' || typeof value.packageVersion !== 'string') return undefined
  return {
    id: value.id,
    displayName: readString(value.displayName) || value.id,
    packageId: value.packageId,
    packageVersion: value.packageVersion,
    sceneId: readString(value.sceneId),
    source: 'official',
  }
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
