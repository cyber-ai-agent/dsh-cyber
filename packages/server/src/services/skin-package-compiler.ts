import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CyberPackageManifest, CyberSkinManifestV1, CyberSkinPaletteV1, JsonObject } from '@dsh-cyber/contracts'

import { parseSkinManifest } from '../skin-manifest.js'

const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_SOURCE_BYTES = 128 * 1024

export interface SkinPackageCompilerInput {
  sourceDirectory: string
  packageId: string
  packageVersion?: string
  displayName: string
  summary: string
  palette: CyberSkinPaletteV1
  /** Official skin whose scene becomes the conversation backdrop; validated by the skin parser. */
  backdropSkinId?: string
  publisher?: string
  license?: string
  createdAt: string
  source?: {
    originalText: string
    originalFormat: 'md' | 'txt'
    analysis: JsonObject
  }
}

export interface CompiledSkinPackage {
  skin: CyberSkinManifestV1
  manifest: CyberPackageManifest
  sourceDirectory: string
}

/**
 * Materializes one generated skin: a declaration-only skin package in the
 * exact shape the official skins ship as — `kind: 'skin'`, `ui:skin`, no
 * data egress, one `skin.json` entrypoint whose id is the package id.
 *
 * The declaration must pass `parseSkinManifest` — the same parser the
 * installer runs — before a byte is written; a lighter "generated skin"
 * shape does not exist. The compiler owns no PackageManager or SQLite
 * behaviour: callers hand the returned manifest to the normal marketplace
 * boundary when they want anything installed.
 */
export async function compileSkinPackage(input: SkinPackageCompilerInput): Promise<CompiledSkinPackage> {
  validateInput(input)
  const packageVersion = input.packageVersion ?? '1.0.0'
  const skin = parseSkinManifest({
    schemaVersion: 1,
    id: input.packageId,
    skinId: input.packageId,
    themeId: input.packageId,
    displayName: input.displayName,
    summary: input.summary,
    palette: { ...input.palette },
    ...(input.backdropSkinId === undefined ? {} : { backdropSkinId: input.backdropSkinId }),
  }, { packageId: input.packageId, packageVersion })

  const files: Array<{ path: string; bytes: Buffer }> = [{ path: 'skin.json', bytes: jsonBytes(skin) }]
  if (input.source !== undefined) {
    files.push(
      { path: `source/original.${input.source.originalFormat}`, bytes: Buffer.from(input.source.originalText, 'utf8') },
      { path: 'source/analysis.json', bytes: jsonBytes(input.source.analysis) },
    )
  }

  await mkdir(dirname(input.sourceDirectory), { recursive: true, mode: 0o700 })
  let createdDirectory = false
  try {
    // The caller must provide a fresh, host-owned path. Never remove an
    // existing directory when a generated id collides or a caller is wrong.
    await mkdir(input.sourceDirectory, { recursive: false, mode: 0o700 })
    createdDirectory = true
    for (const file of files) {
      const destination = join(input.sourceDirectory, ...file.path.split('/'))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 })
    }
    const manifest: CyberPackageManifest = {
      schemaVersion: 1,
      id: input.packageId,
      version: packageVersion,
      kind: 'skin',
      displayName: input.displayName,
      summary: input.summary,
      license: input.license ?? 'LicenseRef-DSH-Cyber-Local',
      publisher: input.publisher ?? 'Local Creative Workshop',
      // A skin only lets the host restyle its own surface. It never carries
      // code, a capability beyond ui:skin, or any egress.
      capabilities: ['ui:skin'],
      dataEgress: [],
      files: files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
      entrypoints: [{ id: input.packageId, kind: 'skin', path: 'skin.json' }],
    }
    await writeFile(join(input.sourceDirectory, 'dsh-cyber.package.json'), jsonBytes(manifest), { flag: 'wx', mode: 0o600 })
    return { skin, manifest, sourceDirectory: input.sourceDirectory }
  } catch (error) {
    if (createdDirectory) await rm(input.sourceDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function validateInput(input: SkinPackageCompilerInput): void {
  if (!PACKAGE_ID.test(input.packageId)) throw new Error('Invalid skin package id')
  if (!PACKAGE_VERSION.test(input.packageVersion ?? '1.0.0')) throw new Error('Invalid skin package version')
  for (const [key, value, maximum] of [
    ['displayName', input.displayName, 100],
    ['summary', input.summary, 500],
    ['createdAt', input.createdAt, 64],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Invalid skin ${key}`)
    }
  }
  if (input.source === undefined) return
  if (Buffer.byteLength(input.source.originalText, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Skin source exceeds 128 KiB')
  if (input.source.originalFormat !== 'md' && input.source.originalFormat !== 'txt') throw new Error('Invalid skin source format')
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
