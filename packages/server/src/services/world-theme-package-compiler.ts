import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  CharacterBlueprintDraft,
  CyberPackageManifest,
  JsonObject,
  WorldThemeManifestV1,
} from '@dsh-cyber/contracts'
import { validateWorldThemeManifest } from '@dsh-cyber/world-runtime'
import { compileWorldSemantics } from '@dsh-cyber/world-simulation'

import { validateWorldThemePackageAssets } from '../world-theme-package.js'
import type { AvatarMediaType } from './avatar-image-guard.js'
import { CHARACTER_GENERATOR_CAPABILITIES } from './character-import-analyzer.js'
import {
  compileEmployeeBlueprintPackage,
  type CompiledEmployeeBlueprintPackage,
} from './employee-blueprint-package-compiler.js'

const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_SOURCE_BYTES = 128 * 1024
const CAPABILITY_SET = new Set<string>(CHARACTER_GENERATOR_CAPABILITIES)

/**
 * The official scene a generated theme clones: its renderer, assets, actor
 * sets, scenes and activity mapping, with the bytes of every declared asset.
 * The generator never draws a scene of its own; it re-labels an existing one.
 */
export interface WorldThemeSceneBase {
  renderer: WorldThemeManifestV1['renderer']
  assets: WorldThemeManifestV1['assets']
  actorSets: WorldThemeManifestV1['actorSets']
  scenes: WorldThemeManifestV1['scenes']
  activityMapping: WorldThemeManifestV1['activityMapping']
  /** Asset `src` -> bytes, read from the official package's declared files. */
  assetBytes: ReadonlyMap<string, Buffer>
}

export interface WorldThemeCastCompileInput {
  packageId: string
  sourceDirectory: string
  draft: CharacterBlueprintDraft
  /** Built-in 2D avatar slot (0-7) frozen for this cast member. */
  fallbackAvatarIndex: number
  preview: { bytes: Buffer; mimeType: AvatarMediaType }
}

export interface WorldThemePackageCompilerInput {
  sourceDirectory: string
  packageId: string
  packageVersion?: string
  entrypointId?: string
  templateId: string
  displayName: string
  summary: string
  terminology: JsonObject
  publisher?: string
  license?: string
  base: WorldThemeSceneBase
  cast: WorldThemeCastCompileInput[]
  /** The real host skill catalog. A cast member naming anything else is refused. */
  allowedSkillIds: ReadonlySet<string>
  createdAt: string
  source?: {
    originalText: string
    originalFormat: 'md' | 'txt'
    analysis: JsonObject
  }
}

export interface CompiledWorldThemePackage {
  theme: WorldThemeManifestV1
  manifest: CyberPackageManifest
  sourceDirectory: string
  cast: CompiledEmployeeBlueprintPackage[]
}

/**
 * Materializes one generated world: a declaration-only world-theme package
 * plus one employee-blueprint package per cast member.
 *
 * The theme is the same artifact the official themes ship as. It must pass
 * `validateWorldThemeManifest`, compile through `compileWorldSemantics` and
 * clear `validateWorldThemePackageAssets` before a byte is written; a
 * lighter "generated theme" shape does not exist. The compiler owns no
 * PackageManager or SQLite behaviour: callers hand the returned manifests to
 * the normal marketplace boundary when they want anything installed.
 */
export async function compileWorldThemePackage(input: WorldThemePackageCompilerInput): Promise<CompiledWorldThemePackage> {
  validateInput(input)
  const packageVersion = input.packageVersion ?? '1.0.0'
  const theme: WorldThemeManifestV1 = {
    schemaVersion: 1,
    id: input.packageId,
    version: packageVersion,
    templateId: input.templateId,
    displayName: input.displayName,
    renderer: input.base.renderer,
    terminology: structuredClone(input.terminology),
    assets: structuredClone(input.base.assets),
    actorSets: structuredClone(input.base.actorSets),
    scenes: structuredClone(input.base.scenes),
    activityMapping: structuredClone(input.base.activityMapping),
  }
  const validation = validateWorldThemeManifest(theme)
  if (!validation.valid) throw new Error(`Generated world theme is invalid: ${validation.errors.join('; ')}`)
  // Semantics must compile for the runtime to seat characters at all.
  compileWorldSemantics(theme)

  const assetFiles = theme.assets.map((asset) => {
    const bytes = input.base.assetBytes.get(asset.src)
    if (bytes === undefined) throw new Error(`Generated world theme asset has no bytes: ${asset.src}`)
    return { path: asset.src, bytes }
  })
  const files: Array<{ path: string; bytes: Buffer }> = [
    { path: 'theme.json', bytes: jsonBytes(theme) },
    ...assetFiles,
  ]
  // The same check the installer runs, applied to the bytes before they land.
  await validateWorldThemePackageAssets(theme, new Set(files.map((file) => file.path)), async (path) => {
    const file = files.find((candidate) => candidate.path === path)
    if (file === undefined) throw new Error(`World theme asset is not staged: ${path}`)
    return file.bytes
  })
  if (input.source !== undefined) {
    files.push(
      { path: `source/original.${input.source.originalFormat}`, bytes: Buffer.from(input.source.originalText, 'utf8') },
      { path: 'source/analysis.json', bytes: jsonBytes(input.source.analysis) },
    )
  }

  await mkdir(dirname(input.sourceDirectory), { recursive: true, mode: 0o700 })
  let createdDirectory = false
  const compiledCast: CompiledEmployeeBlueprintPackage[] = []
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
      kind: 'world-theme',
      displayName: input.displayName,
      summary: input.summary,
      license: input.license ?? 'LicenseRef-DSH-Cyber-Local',
      publisher: input.publisher ?? 'Local Creative Workshop',
      // Installing a theme only lets it render. The cast's requested skills
      // and capabilities are a different layer, approved per employee at
      // recruitment; a theme package never carries them.
      capabilities: ['world:render'],
      dataEgress: [],
      files: files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
      entrypoints: [{ id: input.entrypointId ?? 'world-theme', kind: 'world-theme', path: 'theme.json' }],
    }
    await writeFile(join(input.sourceDirectory, 'dsh-cyber.package.json'), jsonBytes(manifest), { flag: 'wx', mode: 0o600 })

    for (const member of input.cast) {
      compiledCast.push(await compileEmployeeBlueprintPackage({
        sourceDirectory: member.sourceDirectory,
        packageId: member.packageId,
        blueprintVersion: 1,
        packageVersion,
        entrypointId: 'character-blueprint',
        worldTemplateId: input.templateId,
        displayName: member.draft.displayName,
        role: member.draft.role,
        summary: member.draft.summary,
        persona: member.draft.persona,
        publisher: input.publisher ?? 'Local Creative Workshop',
        requestedSkills: member.draft.requestedSkillIds,
        requestedCapabilities: member.draft.requestedCapabilities,
        ...(member.draft.embodiment === undefined ? {} : { embodiment: member.draft.embodiment }),
        fallbackAvatarIndex: member.fallbackAvatarIndex,
        createdAt: input.createdAt,
        ...(input.source === undefined ? {} : {
          source: {
            originalText: input.source.originalText,
            originalFormat: input.source.originalFormat,
            analysis: castAnalysis(member.draft, input.packageId),
            preview: { bytes: member.preview.bytes, mimeType: member.preview.mimeType },
          },
        }),
      }))
    }
    return { theme, manifest, sourceDirectory: input.sourceDirectory, cast: compiledCast }
  } catch (error) {
    if (createdDirectory) await rm(input.sourceDirectory, { recursive: true, force: true }).catch(() => undefined)
    for (const compiled of compiledCast) await rm(compiled.sourceDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function validateInput(input: WorldThemePackageCompilerInput): void {
  if (!PACKAGE_ID.test(input.packageId)) throw new Error('Invalid world theme package id')
  if (!PACKAGE_VERSION.test(input.packageVersion ?? '1.0.0')) throw new Error('Invalid world theme package version')
  for (const [key, value, maximum] of [
    ['templateId', input.templateId, 128],
    ['displayName', input.displayName, 160],
    ['summary', input.summary, 500],
    ['createdAt', input.createdAt, 64],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Invalid world theme ${key}`)
    }
  }
  if (input.terminology === null || typeof input.terminology !== 'object' || Array.isArray(input.terminology)) {
    throw new Error('Invalid world theme terminology')
  }
  const castIds = new Set<string>()
  for (const member of input.cast) {
    if (!PACKAGE_ID.test(member.packageId) || member.packageId === input.packageId || castIds.has(member.packageId)) {
      throw new Error('Invalid world theme cast package id')
    }
    castIds.add(member.packageId)
    if (member.draft.targetWorldTemplateId !== input.templateId) throw new Error('World theme cast member targets a different template')
    // The host skill catalog is the authority: an id that is not in it — a
    // model invention, a stale draft, a tampered request — never becomes a
    // blueprint request, let alone a grant.
    const unknownSkill = member.draft.requestedSkillIds.find((skillId) => !input.allowedSkillIds.has(skillId))
    if (unknownSkill !== undefined) throw new Error(`World theme cast member requests an unknown skill: ${unknownSkill}`)
    const unknownCapability = member.draft.requestedCapabilities.find((capability) => !CAPABILITY_SET.has(capability))
    if (unknownCapability !== undefined) throw new Error(`World theme cast member requests an unsupported capability: ${unknownCapability}`)
  }
  if (input.source === undefined) return
  if (Buffer.byteLength(input.source.originalText, 'utf8') > MAX_SOURCE_BYTES) throw new Error('World source exceeds 128 KiB')
  if (input.source.originalFormat !== 'md' && input.source.originalFormat !== 'txt') throw new Error('Invalid world source format')
}

function castAnalysis(draft: CharacterBlueprintDraft, themePackageId: string): JsonObject {
  return {
    schemaVersion: draft.schemaVersion,
    targetWorldTemplateId: draft.targetWorldTemplateId,
    generatedWorldPackageId: themePackageId,
    displayName: draft.displayName,
    role: draft.role,
    summary: draft.summary,
    persona: draft.persona,
    personalityTraits: [...draft.personalityTraits],
    background: draft.background,
    requestedSkillIds: [...draft.requestedSkillIds],
    requestedCapabilities: [...draft.requestedCapabilities],
    sourceSummary: draft.sourceSummary,
    sourceRefs: [...draft.sourceRefs],
    ...(draft.embodiment === undefined ? {} : { embodiment: structuredClone(draft.embodiment) as unknown as JsonObject }),
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
