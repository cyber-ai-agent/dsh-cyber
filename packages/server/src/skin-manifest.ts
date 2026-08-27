import type { CyberSkinManifestV1 } from '@dsh-cyber/contracts'

const SKIN_KEYS = new Set(['schemaVersion', 'id', 'skinId', 'themeId', 'displayName', 'summary', 'previewAsset'])
const ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Parse the declaration carried by a skin package.
 *
 * A skin package is intentionally metadata-only. `themeId` is resolved by
 * the host registry; the package cannot provide executable code or arbitrary
 * CSS/JS. This keeps installation extensible without allowing packages to
 * bypass the host's visual/runtime boundary.
 */
export function parseSkinManifest(value: unknown, context: { packageId: string; packageVersion: string }): CyberSkinManifestV1 {
  const input = object(value)
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
  return {
    schemaVersion: 1,
    id,
    skinId,
    themeId,
    displayName: text(input.displayName, 'displayName', 100),
    summary: text(input.summary, 'summary', 500),
    ...(previewAsset === undefined ? {} : { previewAsset }),
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Skin manifest must be an object')
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Skin manifest ${field} must be non-empty text of at most ${maximum} characters`)
  }
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`Invalid skin manifest ${field}`)
  return value
}
