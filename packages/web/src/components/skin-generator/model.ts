import type {
  CharacterSourceInput,
  CyberSkinPaletteV1,
  SkinDraft,
  SkinGeneratorBackdropCatalogItem,
  SkinGeneratorBackdropSelection,
  SkinGeneratorCatalog,
  SkinGeneratorPublishResult,
} from '@dsh-cyber/contracts'
import { themeRegistry } from '../../features/world/world-themes.js'
import { validateCharacterSource } from '../character-generator/model.js'

export type { SkinDraft, SkinGeneratorCatalog } from '@dsh-cyber/contracts'
export type { InstalledSkinDeclaration } from '../../features/world/installed-skin-themes.js'

export type SkinGeneratorStep = 'source' | 'analysis' | 'preview' | 'publish'

export interface SkinGeneratorProps {
  workspaceId: string
  onClose(): void
  onPublished(result: SkinGeneratorPublishResult): Promise<void> | void
  closeRequest?: number
}

/** The six colour slots, in the order the editor shows them. */
export const SKIN_PALETTE_COLOR_KEYS = [
  'accentColor',
  'pageBackground',
  'panelBackground',
  'textColor',
  'ownerBubbleColor',
  'characterBubbleColor',
] as const
export type SkinPaletteColorKey = (typeof SKIN_PALETTE_COLOR_KEYS)[number]

/** Same literal the server's skin schema accepts: one lowercase `#rrggbb`. */
export const SKIN_HEX_COLOR = /^#[0-9a-f]{6}$/u
export const SKIN_BACKDROP_OPACITY_MIN = 0.2
export const SKIN_BACKDROP_OPACITY_MAX = 1
const DEFAULT_BACKDROP_OPACITY = 0.9
const LOOSE_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu

export const EMPTY_SKIN_CATALOG: SkinGeneratorCatalog = { backdrops: [] }

export function initialSkinDraft(): SkinDraft {
  return {
    schemaVersion: 1,
    displayName: '',
    summary: '',
    palette: {
      accentColor: '',
      pageBackground: '',
      panelBackground: '',
      textColor: '',
      ownerBubbleColor: '',
      characterBubbleColor: '',
      backdropOpacity: DEFAULT_BACKDROP_OPACITY,
    },
    sourceSummary: '',
    sourceRefs: [],
  }
}

/** Same source rules as the Character Generator; the wire shape is shared. */
export const validateSkinSource: (source: CharacterSourceInput) => string | undefined = validateCharacterSource

export function validateSkinDraft(draft: SkinDraft): string | undefined {
  if (draft.schemaVersion !== 1) return 'draft.invalidVersion'
  if (draft.displayName.trim().length === 0) return 'draft.displayNameRequired'
  if (draft.displayName.trim().length > 100) return 'draft.displayNameTooLong'
  if (draft.summary.trim().length === 0) return 'draft.summaryRequired'
  if (draft.summary.trim().length > 500) return 'draft.summaryTooLong'
  for (const key of SKIN_PALETTE_COLOR_KEYS) {
    if (parseHexColor(draft.palette[key]) === undefined) return 'draft.colorInvalid'
  }
  const opacity = draft.palette.backdropOpacity
  if (!Number.isFinite(opacity) || opacity < SKIN_BACKDROP_OPACITY_MIN || opacity > SKIN_BACKDROP_OPACITY_MAX) return 'draft.opacityInvalid'
  return undefined
}

/**
 * Rebuild a draft from anything the server or a stub returned. A colour that
 * is not a hex literal becomes an empty slot for the user to fill; nothing
 * unparseable is ever kept as text.
 */
export function normalizeSkinDraft(value: unknown): SkinDraft {
  const record = isRecord(value) ? value : {}
  const palette = isRecord(record.palette) ? record.palette : {}
  const opacity = palette.backdropOpacity
  return {
    schemaVersion: 1,
    displayName: readString(record.displayName ?? record.name),
    summary: readString(record.summary ?? record.description),
    palette: {
      ...Object.fromEntries(SKIN_PALETTE_COLOR_KEYS.map((key) => [key, parseHexColor(palette[key]) ?? ''])) as Record<SkinPaletteColorKey, string>,
      backdropOpacity: typeof opacity === 'number' && Number.isFinite(opacity) && opacity >= SKIN_BACKDROP_OPACITY_MIN && opacity <= SKIN_BACKDROP_OPACITY_MAX ? opacity : DEFAULT_BACKDROP_OPACITY,
    },
    sourceSummary: readString(record.sourceSummary),
    sourceRefs: unique(readStringArray(record.sourceRefs)),
  }
}

export function normalizeSkinCatalog(value: unknown): SkinGeneratorCatalog {
  const root = isRecord(value) && isRecord(value.catalog) ? value.catalog : value
  const record = isRecord(root) ? root : {}
  return { backdrops: readArray(record.backdrops).map(normalizeBackdrop).filter(isDefined) }
}

export function trimSkinDraft(draft: SkinDraft): SkinDraft {
  const palette: CyberSkinPaletteV1 = {
    ...Object.fromEntries(SKIN_PALETTE_COLOR_KEYS.map((key) => [key, parseHexColor(draft.palette[key]) ?? draft.palette[key].trim()])) as Record<SkinPaletteColorKey, string>,
    backdropOpacity: Math.round(draft.palette.backdropOpacity * 100) / 100,
  }
  return {
    ...draft,
    schemaVersion: 1,
    displayName: draft.displayName.trim(),
    summary: draft.summary.trim(),
    palette,
    sourceSummary: draft.sourceSummary.trim(),
    sourceRefs: unique(draft.sourceRefs.filter(Boolean)),
  }
}

/** `#rgb` or `#rrggbb` in any case → lowercase `#rrggbb`; anything else is not a colour here. */
export function parseHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const candidate = value.trim()
  if (!LOOSE_HEX_COLOR.test(candidate)) return undefined
  const digits = candidate.slice(1).toLowerCase()
  const expanded = digits.length === 3 ? digits.split('').map((digit) => digit + digit).join('') : digits
  return `#${expanded}`
}

/** The analyzer's suggestion wins when the catalog lists it; otherwise a skin starts colours-only. */
export function defaultBackdropSelection(catalog: SkinGeneratorCatalog, suggested?: string): SkinGeneratorBackdropSelection | undefined {
  const pick = catalog.backdrops.find((backdrop) => backdrop.id === suggested)
  return pick === undefined ? undefined : { kind: 'official', id: pick.id }
}

/** Host-resolved preview for an official backdrop: the built-in skin's own scene, never a package path. */
export function backdropPreviewUrl(id: string): string | undefined {
  const theme = themeRegistry.get(id)
  if (theme.id !== id || theme.source !== 'builtin') return undefined
  return theme.tokens.backdropImage ?? theme.tokens.worldMapImage
}

function normalizeBackdrop(value: unknown): SkinGeneratorBackdropCatalogItem | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.packageId !== 'string' || typeof value.packageVersion !== 'string') return undefined
  return {
    id: value.id,
    displayName: readString(value.displayName) || value.id,
    packageId: value.packageId,
    packageVersion: value.packageVersion,
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
