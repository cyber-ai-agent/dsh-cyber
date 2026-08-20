import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import type { EmployeeBlueprint, InstalledPackage, WorldThemeManifestV1 } from '@dsh-cyber/contracts'
import { validateWorldThemeManifest } from '@dsh-cyber/world-runtime'

const MAX_ENTRYPOINT_BYTES = 512 * 1024

interface PromptTransformDefinition {
  schemaVersion: 1
  commands: Array<{ trigger: string; instruction: string }>
}

export interface InstalledWorldTheme {
  packageId: string
  packageVersion: string
  contentDigest: string
  manifest: WorldThemeManifestV1
}

export class InstalledPackageVerificationCache {
  readonly #verifiedPackages = new Set<string>()
  #fullVerificationPasses = 0

  get fullVerificationPasses(): number {
    return this.#fullVerificationPasses
  }

  async verifyPackage(installed: InstalledPackage): Promise<void> {
    const identity = installedIdentity(installed)
    if (this.#verifiedPackages.has(identity)) return
    for (const file of installed.manifest.files) await readVerifiedPackageFile(installed, file.path)
    this.#verifiedPackages.add(identity)
    this.#fullVerificationPasses += 1
  }

  async readFile(installed: InstalledPackage, relativePath: string): Promise<Buffer> {
    await this.verifyPackage(installed)
    return readVerifiedPackageFile(installed, relativePath)
  }
}

const defaultVerificationCache = new InstalledPackageVerificationCache()

export async function applyInstalledPromptTransforms(
  packages: InstalledPackage[],
  prompt: string,
): Promise<string> {
  let transformed = prompt
  for (const installed of packages.filter((item) => item.status === 'active')) {
    for (const entrypoint of installed.manifest.entrypoints ?? []) {
      if (entrypoint.kind !== 'prompt-transform') continue
      const definition = await readEntrypoint<PromptTransformDefinition>(installed, entrypoint.path)
      if (definition.schemaVersion !== 1 || !Array.isArray(definition.commands)) continue
      for (const command of definition.commands) {
        if (!validCommand(command) || !commandMatches(transformed, command.trigger)) continue
        transformed = `${command.instruction.trim()}\n\n用户原始请求：\n${transformed}`
      }
    }
  }
  return transformed
}

export async function loadInstalledBlueprints(packages: InstalledPackage[]): Promise<EmployeeBlueprint[]> {
  const blueprints: EmployeeBlueprint[] = []
  for (const installed of packages.filter((item) => item.status === 'active')) {
    for (const entrypoint of installed.manifest.entrypoints ?? []) {
      if (entrypoint.kind !== 'employee-blueprint') continue
      const value = await readEntrypoint<unknown>(installed, entrypoint.path)
      const candidates = Array.isArray(value) ? value : [value]
      for (const candidate of candidates) {
        const blueprint = parseBlueprint(candidate)
        if (blueprint !== undefined) blueprints.push(blueprint)
      }
    }
  }
  return blueprints
}

export async function loadInstalledWorldThemes(
  packages: InstalledPackage[],
  verificationCache = defaultVerificationCache,
): Promise<InstalledWorldTheme[]> {
  const themes: InstalledWorldTheme[] = []
  for (const installed of packages.filter((item) => item.status === 'active' && item.kind === 'world-theme')) {
    await verificationCache.verifyPackage(installed)
    for (const entrypoint of installed.manifest.entrypoints ?? []) {
      if (entrypoint.kind !== 'world-theme') continue
      const value = await readEntrypoint<unknown>(installed, entrypoint.path, verificationCache)
      const validation = validateWorldThemeManifest(value)
      if (!validation.valid) throw new Error(`Invalid installed world theme ${installed.packageId}: ${validation.errors.join('; ')}`)
      const manifest = value as WorldThemeManifestV1
      const declaredFiles = new Set(installed.manifest.files.map((file) => file.path))
      for (const asset of manifest.assets) {
        if (!safeRelativePackagePath(asset.src) || !declaredFiles.has(asset.src)) {
          throw new Error(`World theme asset is not a declared package file: ${asset.src}`)
        }
      }
      const entrypointFile = installed.manifest.files.find((file) => file.path === entrypoint.path)!
      themes.push({ packageId: installed.packageId, packageVersion: installed.version, contentDigest: entrypointFile.sha256, manifest })
    }
  }
  return themes
}

export async function readInstalledWorldThemeAsset(
  installed: InstalledPackage,
  relativePath: string,
  verificationCache = defaultVerificationCache,
): Promise<{ body: Buffer; contentType: string }> {
  const declared = installed.manifest.files.find((file) => file.path === relativePath)
  if (declared === undefined || !safeRelativePackagePath(relativePath)) {
    throw new Error(`World theme asset is not declared: ${relativePath}`)
  }
  return { body: await verificationCache.readFile(installed, relativePath), contentType: assetContentType(relativePath) }
}

async function readEntrypoint<T>(
  installed: InstalledPackage,
  relativePath: string,
  verificationCache?: InstalledPackageVerificationCache,
): Promise<T> {
  const path = await securePackageFile(installed, relativePath)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ENTRYPOINT_BYTES) {
    throw new Error(`Invalid installed package entrypoint: ${installed.packageId}/${relativePath}`)
  }
  const body = verificationCache === undefined
    ? await readFile(path)
    : await verificationCache.readFile(installed, relativePath)
  return JSON.parse(body.toString('utf8')) as T
}

async function readVerifiedPackageFile(installed: InstalledPackage, relativePath: string): Promise<Buffer> {
  const declared = installed.manifest.files.find((file) => file.path === relativePath)
  if (declared === undefined) throw new Error(`Installed package file is not declared: ${installed.packageId}/${relativePath}`)
  const path = await securePackageFile(installed, relativePath)
  const body = await readFile(path)
  const digest = createHash('sha256').update(body).digest('hex')
  if (digest !== declared.sha256) throw new Error(`Installed package hash mismatch: ${installed.packageId}/${relativePath}`)
  return body
}

function installedIdentity(installed: InstalledPackage): string {
  const inventory = [...installed.manifest.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}:${file.sha256}`)
    .join('\n')
  const digest = createHash('sha256').update(inventory).digest('hex')
  return `${installed.workspaceId}:${installed.packageId}@${installed.version}:${resolve(installed.installedPath)}:${digest}`
}

async function securePackageFile(installed: InstalledPackage, relativePath: string): Promise<string> {
  if (!safeRelativePackagePath(relativePath)) throw new Error(`Unsafe installed package path: ${relativePath}`)
  const root = resolve(installed.installedPath)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Invalid installed package root: ${installed.packageId}`)
  }
  let current = root
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment)
    if (current !== root && !current.startsWith(`${root}${sep}`)) {
      throw new Error(`Installed package path escaped its root: ${relativePath}`)
    }
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in installed packages: ${relativePath}`)
  }
  const metadata = await lstat(current)
  if (!metadata.isFile() || metadata.size > MAX_ENTRYPOINT_BYTES * 32) {
    throw new Error(`Invalid installed package file: ${relativePath}`)
  }
  return current
}

function safeRelativePackagePath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function assetContentType(path: string): string {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function validCommand(value: unknown): value is { trigger: string; instruction: string } {
  if (typeof value !== 'object' || value === null) return false
  const command = value as Record<string, unknown>
  return typeof command.trigger === 'string' && command.trigger.trim().startsWith('/') &&
    typeof command.instruction === 'string' && command.instruction.trim().length > 0
}

function commandMatches(prompt: string, trigger: string): boolean {
  const normalized = trigger.trim()
  return prompt === normalized || prompt.startsWith(`${normalized} `) || prompt.startsWith(`${normalized}\n`)
}

function parseBlueprint(value: unknown): EmployeeBlueprint | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const strings = ['id', 'worldTemplateId', 'displayName', 'role', 'summary', 'persona', 'createdAt'] as const
  if (strings.some((field) => typeof input[field] !== 'string' || !(input[field] as string).trim())) return undefined
  if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1) return undefined
  if (!stringArray(input.requestedSkills) || !stringArray(input.requestedCapabilities)) return undefined
  return {
    id: input.id as string,
    version: input.version,
    worldTemplateId: input.worldTemplateId as string,
    displayName: input.displayName as string,
    role: input.role as string,
    summary: input.summary as string,
    persona: input.persona as string,
    requestedSkills: input.requestedSkills,
    requestedCapabilities: input.requestedCapabilities,
    createdAt: input.createdAt as string,
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0)
}
