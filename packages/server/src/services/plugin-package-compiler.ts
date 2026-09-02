import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CyberPackageManifest, JsonObject, PluginTransformDraft } from '@dsh-cyber/contracts'

import { parsePromptTransformDefinition, type PromptTransformDefinition } from '../prompt-transform-parser.js'

const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_SOURCE_BYTES = 128 * 1024

/** The one file a generated plugin's entrypoint points at. */
export const PLUGIN_TRANSFORMS_ENTRYPOINT_PATH = 'transforms.json'
/** The whole capability list of a generated plugin; `assertPromptTransformPackage` requires exactly this at run time. */
export const GENERATED_PLUGIN_CAPABILITIES = ['prompt:transform'] as const

export interface PluginPackageCompilerInput {
  sourceDirectory: string
  packageId: string
  packageVersion?: string
  displayName: string
  summary: string
  transforms: PluginTransformDraft[]
  publisher?: string
  license?: string
  createdAt: string
  source?: {
    originalText: string
    originalFormat: 'md' | 'txt'
    analysis: JsonObject
  }
}

export interface CompiledPluginPackage {
  definition: PromptTransformDefinition
  manifest: CyberPackageManifest
  sourceDirectory: string
}

/**
 * Materializes one generated plugin: a declaration-only plugin package in the
 * exact shape the official plugins ship as — `kind: 'plugin'`, exactly
 * `prompt:transform`, no data egress, one `prompt-transform` entrypoint whose
 * id is the package id.
 *
 * The transform list must pass `parsePromptTransformDefinition` — the same
 * parser the installer and every runtime turn run — before a byte is written;
 * a lighter "generated transform" shape does not exist and no package code is
 * ever evaluated. The compiler owns no PackageManager or SQLite behaviour:
 * callers hand the returned manifest to the normal marketplace boundary when
 * they want anything installed.
 */
export async function compilePluginPackage(input: PluginPackageCompilerInput): Promise<CompiledPluginPackage> {
  validateInput(input)
  const packageVersion = input.packageVersion ?? '1.0.0'
  const definition = parsePromptTransformDefinition({
    schemaVersion: 1,
    transforms: input.transforms.map((transform) => ({
      id: transform.id,
      trigger: transform.trigger,
      description: transform.description,
      instruction: transform.instruction,
      mode: transform.mode,
      priority: transform.priority,
    })),
  })
  assertGeneratedTransforms(definition)

  const files: Array<{ path: string; bytes: Buffer }> = [{ path: PLUGIN_TRANSFORMS_ENTRYPOINT_PATH, bytes: jsonBytes(definition) }]
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
      kind: 'plugin',
      displayName: input.displayName,
      summary: input.summary,
      license: input.license ?? 'LicenseRef-DSH-Cyber-Local',
      publisher: input.publisher ?? 'Local Creative Workshop',
      // A generated plugin only lets the host rewrite the prompt of a turn the
      // user explicitly triggered. It never carries code, a capability beyond
      // prompt:transform, or any egress.
      capabilities: [...GENERATED_PLUGIN_CAPABILITIES],
      dataEgress: [],
      files: files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
      entrypoints: [{ id: input.packageId, kind: 'prompt-transform', path: PLUGIN_TRANSFORMS_ENTRYPOINT_PATH }],
    }
    await writeFile(join(input.sourceDirectory, 'dsh-cyber.package.json'), jsonBytes(manifest), { flag: 'wx', mode: 0o600 })
    return { definition, manifest, sourceDirectory: input.sourceDirectory }
  } catch (error) {
    if (createdDirectory) await rm(input.sourceDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * The two rules a generated plugin adds on top of the runtime parser: every
 * trigger is an explicit slash command (the parser also admits `always`), and
 * triggers are unique within the package (the parser only checks ids).
 */
export function assertGeneratedTransforms(definition: PromptTransformDefinition): void {
  const triggers = new Set<string>()
  for (const transform of definition.transforms) {
    if (transform.trigger === 'always') throw new Error('Generated plugin triggers must be explicit slash commands')
    if (triggers.has(transform.trigger)) throw new Error(`Duplicate generated plugin trigger: ${transform.trigger}`)
    triggers.add(transform.trigger)
  }
}

function validateInput(input: PluginPackageCompilerInput): void {
  if (!PACKAGE_ID.test(input.packageId)) throw new Error('Invalid plugin package id')
  if (!PACKAGE_VERSION.test(input.packageVersion ?? '1.0.0')) throw new Error('Invalid plugin package version')
  for (const [key, value, maximum] of [
    ['displayName', input.displayName, 100],
    ['summary', input.summary, 500],
    ['createdAt', input.createdAt, 64],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Invalid plugin ${key}`)
    }
  }
  if (!Array.isArray(input.transforms)) throw new Error('Invalid plugin transforms')
  if (input.source === undefined) return
  if (Buffer.byteLength(input.source.originalText, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Plugin source exceeds 128 KiB')
  if (input.source.originalFormat !== 'md' && input.source.originalFormat !== 'txt') throw new Error('Invalid plugin source format')
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
