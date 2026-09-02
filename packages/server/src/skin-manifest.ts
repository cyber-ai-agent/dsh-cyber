import type { CyberSkinManifestV1, CyberSkinPaletteV1 } from '@dsh-cyber/contracts'

const SKIN_KEYS = new Set(['schemaVersion', 'id', 'skinId', 'themeId', 'displayName', 'summary', 'previewAsset', 'palette', 'backdropSkinId'])
const ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** The six colour slots a declared palette must fill, and nothing else. */
export const SKIN_PALETTE_COLOR_KEYS = [
  'accentColor',
  'pageBackground',
  'panelBackground',
  'textColor',
  'ownerBubbleColor',
  'characterBubbleColor',
] as const
const PALETTE_KEYS = new Set<string>([...SKIN_PALETTE_COLOR_KEYS, 'backdropOpacity'])
/**
 * A declared colour is exactly one lowercase `#rrggbb` literal. No CSS colour
 * functions, no `var()`, no `url()`, no names: the host never has to parse a
 * package value as CSS, so nothing in a skin can carry a reference or code.
 */
export const SKIN_HEX_COLOR = /^#[0-9a-f]{6}$/
export const SKIN_BACKDROP_OPACITY_MIN = 0.2
export const SKIN_BACKDROP_OPACITY_MAX = 1

/**
 * Official skins whose bundled scene a declared skin may reuse as its
 * conversation backdrop. This is the whole allowlist: the id names a host
 * registry entry, and the host — not the package — resolves it to an asset.
 */
export const SKIN_BACKDROP_SKIN_IDS = [
  'cyber-company',
  'maid-atelier',
  'orca-link',
  'moonlit-tavern',
  'sakura-shrine',
  'starlit-witch',
  'neon-cyber',
  'white-whale',
  'black-orca',
] as const

/**
 * Parse the declaration carried by a skin package.
 *
 * A skin package is intentionally metadata-only. `themeId` is resolved by
 * the host registry; the package cannot provide executable code or arbitrary
 * CSS/JS. A declared `palette` is six hex colours and one bounded opacity,
 * and a declared `backdropSkinId` is one id from a closed list. This keeps
 * installation extensible without allowing packages to bypass the host's
 * visual/runtime boundary.
 */
export function parseSkinManifest(value: unknown, context: { packageId: string; packageVersion: string }): CyberSkinManifestV1 {
  const input = object(value, 'Skin manifest')
  for (const key of Object.keys(input)) {
    if (!SKIN_KEYS.has(key)) throw new Error(`Unknown skin manifest field: ${key}`)
  }
  if (input.schemaVersion !== 1) throw new Error('Skin manifest schemaVersion must be 1')
  const id = text(input.id, 'id', 160, ID)
  const skinId = text(input.skinId, 'skinId', 160, ID)
  const themeId = text(input.themeId, 'themeId', 160, ID)
  if (id !== context.packageId) throw new Error('Skin manifest id must match package id')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(context.packageVersion)) {
    throw new Error('Skin package version is invalid')
  }
  const previewAsset = input.previewAsset === undefined ? undefined : text(input.previewAsset, 'previewAsset', 512, /^assets\/[a-z0-9][a-z0-9./-]*\.(?:png|jpe?g|webp)$/)
  const palette = input.palette === undefined ? undefined : parseSkinPalette(input.palette)
  const backdropSkinId = input.backdropSkinId === undefined ? undefined : text(input.backdropSkinId, 'backdropSkinId', 64, ID)
  if (backdropSkinId !== undefined && !(SKIN_BACKDROP_SKIN_IDS as readonly string[]).includes(backdropSkinId)) {
    throw new Error('Skin manifest backdropSkinId is not an official skin')
  }
  return {
    schemaVersion: 1,
    id,
    skinId,
    themeId,
    displayName: text(input.displayName, 'displayName', 100),
    summary: text(input.summary, 'summary', 500),
    ...(previewAsset === undefined ? {} : { previewAsset }),
    ...(palette === undefined ? {} : { palette }),
    ...(backdropSkinId === undefined ? {} : { backdropSkinId }),
  }
}

/** Parse a declared palette: every slot present, every colour a hex literal, the opacity bounded. */
export function parseSkinPalette(value: unknown): CyberSkinPaletteV1 {
  const input = object(value, 'Skin palette')
  for (const key of Object.keys(input)) {
    if (!PALETTE_KEYS.has(key)) throw new Error(`Unknown skin palette field: ${key}`)
  }
  const colors = {} as Record<(typeof SKIN_PALETTE_COLOR_KEYS)[number], string>
  for (const key of SKIN_PALETTE_COLOR_KEYS) {
    const candidate = input[key]
    if (typeof candidate !== 'string' || !SKIN_HEX_COLOR.test(candidate)) {
      throw new Error(`Skin palette ${key} must be a #rrggbb colour`)
    }
    colors[key] = candidate
  }
  const opacity = input.backdropOpacity
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < SKIN_BACKDROP_OPACITY_MIN || opacity > SKIN_BACKDROP_OPACITY_MAX) {
    throw new Error(`Skin palette backdropOpacity must be between ${SKIN_BACKDROP_OPACITY_MIN} and ${SKIN_BACKDROP_OPACITY_MAX}`)
  }
  return { ...colors, backdropOpacity: opacity }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Skin manifest ${field} must be non-empty text of at most ${maximum} characters`)
  }
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`Invalid skin manifest ${field}`)
  return value
}
