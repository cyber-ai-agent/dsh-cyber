import type { IncomingMessage } from 'node:http'

import type { CyberPackageKind, CyberPackageManifest } from '@dsh-cyber/contracts'

import { HttpError } from './errors.js'

export const MAX_BODY_BYTES = 8 * 1024 * 1024

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'Request body too large')
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    const body = record(parsed)
    if (body === undefined) throw new Error('JSON body must be an object')
    return body
  } catch {
    throw new HttpError(400, 'invalid_json', 'Invalid JSON body')
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body[key])
  if (value === undefined) throw new HttpError(422, 'field_required', `${key} is required`)
  return value
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

export function nullableString(value: unknown): string | null {
  if (value === null) return null
  const normalized = optionalString(value)
  if (normalized === undefined) throw new HttpError(422, 'invalid_string', 'Expected a string or null')
  return normalized
}

export function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(422, 'invalid_number', `${key} must be a finite number`)
  }
  return value
}

export function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') {
    throw new HttpError(422, 'invalid_boolean', `${key} must be a boolean`)
  }
  return value
}

export function requiredEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = requiredString(body, key)
  if (!values.includes(value as T)) {
    throw new HttpError(422, 'invalid_enum', `${key} has an unsupported value`)
  }
  return value as T
}

export function optionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(optionalString).filter((item): item is string => item !== undefined))]
}

export function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

export function nonNegativeInteger(value: string | null): number {
  if (value === null) return 0
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : 0
}

export function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export function packageManifest(value: unknown): CyberPackageManifest {
  const input = record(value)
  if (input === undefined) throw new HttpError(422, 'manifest_required', 'Package manifest required')
  assertExactObjectKeys(input, [
    'schemaVersion',
    'id',
    'version',
    'kind',
    'displayName',
    'summary',
    'license',
    'publisher',
    'capabilities',
    'dataEgress',
    'files',
    'entrypoints',
    'certification',
  ], 'package manifest')
  if (input.schemaVersion !== 1) {
    throw new HttpError(422, 'invalid_manifest_schema', 'Unsupported package manifest schema')
  }
  const kind = optionalString(input.kind)
  const validKinds: CyberPackageKind[] = [
    'plugin',
    'skill',
    'employee-blueprint',
    'world-theme',
    'asset',
    'model-provider',
  ]
  if (kind === undefined || !validKinds.includes(kind as CyberPackageKind)) {
    throw new HttpError(422, 'invalid_package_kind', 'Invalid package kind')
  }
  if (!Array.isArray(input.files)) {
    throw new HttpError(422, 'invalid_package_files', 'Package files must be an array')
  }
  const files = input.files.map((item) => {
    const file = record(item)
    if (file === undefined) throw new HttpError(422, 'invalid_package_file', 'Invalid package file')
    assertExactObjectKeys(file, ['path', 'sha256'], 'package file')
    return {
      path: requiredString(file, 'path'),
      sha256: requiredString(file, 'sha256'),
    }
  })
  const entrypoints = input.entrypoints === undefined
    ? undefined
    : Array.isArray(input.entrypoints)
      ? input.entrypoints.map((item) => {
          const entrypoint = record(item)
          if (entrypoint === undefined) throw new HttpError(422, 'invalid_package_entrypoint', 'Invalid package entrypoint')
          assertExactObjectKeys(entrypoint, ['id', 'kind', 'path'], 'package entrypoint')
          return {
            id: requiredString(entrypoint, 'id'),
            kind: requiredEnum(entrypoint, 'kind', ['prompt-transform', 'employee-blueprint', 'world-theme', 'skill']),
            path: requiredString(entrypoint, 'path'),
          }
        })
      : (() => { throw new HttpError(422, 'invalid_package_entrypoints', 'Package entrypoints must be an array') })()
  const certificationInput = record(input.certification)
  let certification: CyberPackageManifest['certification']
  if (certificationInput !== undefined) {
    assertExactObjectKeys(certificationInput, ['authority', 'level', 'contentSha256'], 'package certification')
    certification = {
      authority: requiredString(certificationInput, 'authority'),
      level: requiredEnum(certificationInput, 'level', ['official', 'community']),
      contentSha256: requiredString(certificationInput, 'contentSha256'),
    }
  }
  return {
    schemaVersion: 1,
    id: requiredString(input, 'id'),
    version: requiredString(input, 'version'),
    kind: kind as CyberPackageKind,
    displayName: requiredString(input, 'displayName'),
    summary: requiredString(input, 'summary'),
    license: requiredString(input, 'license'),
    publisher: requiredString(input, 'publisher'),
    capabilities: strictStringArray(input.capabilities, 'capabilities'),
    dataEgress: strictStringArray(input.dataEgress, 'dataEgress'),
    files,
    ...(entrypoints === undefined ? {} : { entrypoints }),
    ...(certification === undefined ? {} : { certification }),
  }
}

function strictStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new HttpError(422, 'invalid_manifest_array', `${field} must be an array of non-empty strings`)
  }
  return value.map((item) => (item as string).trim())
}

function assertExactObjectKeys(value: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown !== undefined) {
    throw new HttpError(422, 'invalid_manifest_field', `Unknown ${label} field: ${unknown}`)
  }
}
