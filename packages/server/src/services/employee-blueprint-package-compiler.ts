import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  CyberPackageManifest,
  EmployeeBlueprint,
  EmbodimentProfile,
  JsonObject,
} from '@dsh-cyber/contracts'

import { EMPLOYEE_REQUESTABLE_CAPABILITIES } from '../employee-blueprint-manifest.js'

const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const TOKEN = /^[a-z][a-z0-9._-]*(?::[a-z][a-z0-9._-]*)?$/
const MAX_SOURCE_BYTES = 128 * 1024
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
export const EMPLOYEE_PERSONA_MAX_CHARACTERS = 2_000

export interface EmployeeBlueprintPackageSource {
  originalText: string
  originalFormat: 'md' | 'txt'
  analysis: JsonObject
  preview: {
    bytes: Buffer
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  }
}

export interface EmployeeBlueprintPackageCompilerInput {
  sourceDirectory: string
  packageId: string
  blueprintVersion?: number
  packageVersion?: string
  entrypointId?: string
  worldTemplateId: string
  displayName: string
  role: string
  summary: string
  persona: string
  publisher?: string
  license?: string
  requestedSkills?: string[]
  requestedCapabilities?: string[]
  embodiment?: EmbodimentProfile
  createdAt: string
  source?: EmployeeBlueprintPackageSource
}

export interface CompiledEmployeeBlueprintPackage {
  blueprint: EmployeeBlueprint
  manifest: CyberPackageManifest
  sourceDirectory: string
}

/**
 * Materializes one declaration-only employee blueprint package.
 *
 * This compiler owns no PackageManager or SQLite behavior. Callers must pass a
 * host-generated directory and then hand the returned manifest/source to the
 * normal PackageManager boundary when they want the package installed.
 */
export async function compileEmployeeBlueprintPackage(
  input: EmployeeBlueprintPackageCompilerInput,
): Promise<CompiledEmployeeBlueprintPackage> {
  validateInput(input)
  const packageVersion = input.packageVersion ?? '1.0.0'
  const blueprintVersion = input.blueprintVersion ?? 1
  const requestedSkills = uniqueText(input.requestedSkills ?? [], 'requestedSkills')
  const requestedCapabilities = uniqueText(input.requestedCapabilities ?? [], 'requestedCapabilities')
  for (const capability of requestedCapabilities) {
    if (!EMPLOYEE_REQUESTABLE_CAPABILITIES.includes(capability)) {
      throw new Error(`Unsupported character capability: ${capability}`)
    }
  }

  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1,
    id: input.packageId,
    version: blueprintVersion,
    worldTemplateId: input.worldTemplateId,
    displayName: input.displayName,
    role: input.role,
    summary: input.summary,
    // Only the reviewed persona reaches the runtime prompt. background and
    // personalityTraits belong to EmployeeProfile, which the runtime composes
    // separately; composing them here baked unreviewed draft text — including
    // raw slabs of the untrusted import source — permanently into the
    // blueprint, behind the persona-only source-echo guard.
    persona: input.persona.trim(),
    requestedSkills,
    requestedCapabilities,
    ...(input.embodiment === undefined ? {} : { embodiment: structuredClone(input.embodiment) }),
    createdAt: input.createdAt,
  }

  const files: Array<{ path: string; bytes: Buffer }> = [
    { path: 'blueprint.json', bytes: jsonBytes(blueprint) },
  ]
  if (input.source !== undefined) {
    const extension = input.source.originalFormat
    files.push(
      { path: `source/original.${extension}`, bytes: Buffer.from(input.source.originalText, 'utf8') },
      { path: 'source/analysis.json', bytes: jsonBytes(input.source.analysis) },
      { path: `preview.${previewExtension(input.source.preview.mimeType)}`, bytes: input.source.preview.bytes },
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
      kind: 'employee-blueprint',
      displayName: input.displayName,
      summary: input.summary,
      license: input.license ?? 'LicenseRef-DSH-Cyber-Local',
      publisher: input.publisher ?? 'Local Creative Workshop',
      // What installing THIS PACKAGE needs. A talent package is declaration
      // only, so that is exactly one capability. The blueprint's
      // requestedCapabilities are a different permission layer: what a future
      // Employee would like, approved per employee in recruitment. Installing a
      // talent package must never hand out an employee's requested permissions.
      capabilities: ['employee:blueprint'],
      dataEgress: [],
      files: files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
      entrypoints: [{ id: input.entrypointId ?? 'role-blueprint', kind: 'employee-blueprint', path: 'blueprint.json' }],
    }
    await writeFile(join(input.sourceDirectory, 'dsh-cyber.package.json'), jsonBytes(manifest), { flag: 'wx', mode: 0o600 })
    return { blueprint, manifest, sourceDirectory: input.sourceDirectory }
  } catch (error) {
    if (createdDirectory) await rm(input.sourceDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export class EmployeeBlueprintPackageCompiler {
  compile(input: EmployeeBlueprintPackageCompilerInput): Promise<CompiledEmployeeBlueprintPackage> {
    return compileEmployeeBlueprintPackage(input)
  }
}

function validateInput(input: EmployeeBlueprintPackageCompilerInput): void {
  if (!PACKAGE_ID.test(input.packageId)) throw new Error('Invalid employee blueprint package id')
  if (!PACKAGE_VERSION.test(input.packageVersion ?? '1.0.0')) throw new Error('Invalid employee blueprint package version')
  if (!Number.isSafeInteger(input.blueprintVersion ?? 1) || (input.blueprintVersion ?? 1) < 1) {
    throw new Error('Employee blueprint version must be a positive integer')
  }
  for (const [key, value, maximum] of [
    ['worldTemplateId', input.worldTemplateId, 128],
    ['displayName', input.displayName, 100],
    ['role', input.role, 100],
    ['summary', input.summary, 500],
    ['persona', input.persona, EMPLOYEE_PERSONA_MAX_CHARACTERS],
    ['createdAt', input.createdAt, 64],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Invalid employee blueprint ${key}`)
    }
  }
  if (input.source === undefined) return
  if (Buffer.byteLength(input.source.originalText, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Character source exceeds 128 KiB')
  if (input.source.originalFormat !== 'md' && input.source.originalFormat !== 'txt') throw new Error('Invalid character source format')
  if (input.source.preview.bytes.byteLength < 1 || input.source.preview.bytes.byteLength > MAX_PREVIEW_BYTES) {
    throw new Error('Character preview must be between 1 byte and 5 MiB')
  }
  assertPreviewSignature(input.source.preview.bytes, input.source.preview.mimeType)
}

function uniqueText(values: readonly string[], field: string): string[] {
  const output = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Invalid employee blueprint ${field}`)
    }
    if (!TOKEN.test(value.trim())) throw new Error(`Invalid employee blueprint ${field}`)
    return value.trim()
  })
  if (new Set(output).size !== output.length) throw new Error(`Duplicate employee blueprint ${field}`)
  return output
}

function assertPreviewSignature(bytes: Buffer, mimeType: EmployeeBlueprintPackageSource['preview']['mimeType']): void {
  if (mimeType === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Character preview PNG signature is invalid')
  }
  if (mimeType === 'image/jpeg' && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new Error('Character preview JPEG signature is invalid')
  }
  if (mimeType === 'image/webp' && !(bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')) {
    throw new Error('Character preview WebP signature is invalid')
  }
}

function previewExtension(mimeType: EmployeeBlueprintPackageSource['preview']['mimeType']): 'png' | 'jpg' | 'webp' {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp'
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
