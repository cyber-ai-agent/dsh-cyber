import { createHash } from 'node:crypto'
import { lstat, open, readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

import type { CyberSkinManifestV1, EmployeeBlueprint, InstalledPackage, WorldThemeManifestV1 } from '@dsh-cyber/contracts'
import { fileStamp, sameFileStamp, type FileStamp, type StagedPackage } from '@dsh-cyber/package-runtime'
import { validateWorldThemeManifest } from '@dsh-cyber/world-runtime'

import { parseEmployeeBlueprintManifest } from './employee-blueprint-manifest.js'
import {
  parsePromptTransformDefinition,
  type PromptTransform,
} from './prompt-transform-parser.js'
import { parseSkillManifest, type SkillManifest } from './skill-manifest.js'
import { parseSkinManifest } from './skin-manifest.js'
import { validateWorldThemePackageAssets } from './world-theme-package.js'

export { parsePromptTransformDefinition } from './prompt-transform-parser.js'

const MAX_ENTRYPOINT_BYTES = 512 * 1024

export interface InstalledWorldTheme {
  packageId: string
  packageVersion: string
  contentDigest: string
  manifest: WorldThemeManifestV1
}

export interface InstalledPromptTransformCommand {
  packageId: string
  packageVersion: string
  displayName: string
  summary: string
  trigger: string
  displayTrigger: string
  description: string
  automatic: boolean
}

/** A parsed, package-owned Skill declaration. It still has no executable code. */
export interface InstalledSkillManifest {
  packageId: string
  packageVersion: string
  entrypointId: string
  entrypointPath: string
  manifest: SkillManifest
}

export interface InstalledSkinManifest {
  packageId: string
  packageVersion: string
  entrypointId: string
  entrypointPath: string
  manifest: CyberSkinManifestV1
}

/** An installed package file opened for streaming instead of buffering. */
export interface InstalledFileStream {
  byteLength: number
  body: Readable
}

export class InstalledPackageVerificationCache {
  readonly #verifiedPackages = new Set<string>()
  /** Package identity -> declared path -> stamp taken while its hash matched. */
  readonly #verifiedFiles = new Map<string, Map<string, FileStamp>>()
  #fullVerificationPasses = 0

  get fullVerificationPasses(): number {
    return this.#fullVerificationPasses
  }

  async verifyPackage(installed: InstalledPackage): Promise<void> {
    const identity = installedIdentity(installed)
    if (this.#verifiedPackages.has(identity)) return
    const stamps = new Map<string, FileStamp>()
    for (const file of installed.manifest.files) {
      stamps.set(file.path, (await readVerifiedPackageFile(installed, file.path)).stamp)
    }
    this.#verifiedFiles.set(identity, stamps)
    this.#verifiedPackages.add(identity)
    this.#fullVerificationPasses += 1
  }

  async readFile(installed: InstalledPackage, relativePath: string): Promise<Buffer> {
    await this.verifyPackage(installed)
    return (await readVerifiedPackageFile(installed, relativePath)).body
  }

  /**
   * Stream a verified package file instead of buffering it.
   *
   * The handle is opened first and fstat'ed through itself, so the stamp check
   * describes the inode the stream reads. A match means this is byte-for-byte
   * the file whose SHA-256 was verified; anything else falls back to the full
   * verifying read, which re-hashes before a byte is returned.
   */
  async openFile(installed: InstalledPackage, relativePath: string): Promise<InstalledFileStream> {
    await this.verifyPackage(installed)
    const stamp = this.#verifiedFiles.get(installedIdentity(installed))?.get(relativePath)
    if (stamp !== undefined) {
      const path = await securePackageFile(installed, relativePath)
      const handle = await open(path, 'r')
      if (sameFileStamp(await handle.stat(), stamp)) {
        const body = handle.createReadStream()
        body.once('close', () => { void handle.close().catch(() => undefined) })
        return { byteLength: stamp.size, body }
      }
      await handle.close()
    }
    const body = await this.readFile(installed, relativePath)
    return { byteLength: body.byteLength, body: Readable.from([body]) }
  }
}

const defaultVerificationCache = new InstalledPackageVerificationCache()

export async function applyInstalledPromptTransforms(
  packages: InstalledPackage[],
  prompt: string,
): Promise<string> {
  const originalPrompt = prompt
  const matched: AppliedPromptTransform[] = []
  const activePackages = packages
    .filter((item) => item.status === 'active')
    .sort(compareInstalledPackages)
  for (const installed of activePackages) {
    for (const entrypoint of installed.manifest.entrypoints ?? []) {
      if (entrypoint.kind !== 'prompt-transform') continue
      assertPromptTransformPackage(installed)
      const definition = parsePromptTransformDefinition(await readEntrypoint<unknown>(installed, entrypoint.path))
      for (const [index, transform] of definition.transforms.entries()) {
        if (!transformMatches(originalPrompt, transform.trigger) && !transformMatches(originalPrompt, localizedPluginTrigger(installed.packageId, transform.trigger))) continue
        matched.push({
          packageId: installed.packageId,
          packageVersion: installed.version,
          entrypointId: entrypoint.id,
          entrypointPath: entrypoint.path,
          index,
          transform,
        })
      }
    }
  }
  matched.sort(compareAppliedTransforms)

  const replacement = matched.find((item) => item.transform.mode === 'replace')?.transform.instruction
  const base = replacement ?? originalPrompt
  const prepends = matched
    .filter((item) => item.transform.mode === 'prepend')
    .map((item) => item.transform.instruction)
  const appends = matched
    .filter((item) => item.transform.mode === 'append')
    .map((item) => item.transform.instruction)
  return [...prepends, base, ...appends].join('\n\n')
}

/**
 * Returns only the command metadata needed by the chat composer. The prompt
 * instructions themselves never leave the server, so the picker cannot leak
 * plugin implementation details or credentials into the browser.
 */
export async function loadInstalledPromptTransformCommands(
  packages: InstalledPackage[],
): Promise<InstalledPromptTransformCommand[]> {
  const commands: InstalledPromptTransformCommand[] = []
  for (const installed of packages.filter((item) => item.status === 'active' && item.kind === 'plugin')) {
    const entrypoints = (installed.manifest.entrypoints ?? []).filter((entrypoint) => entrypoint.kind === 'prompt-transform')
    if (entrypoints.length === 0) continue
    try {
      assertPromptTransformPackage(installed)
      for (const entrypoint of entrypoints) {
        const definition = parsePromptTransformDefinition(await readEntrypoint<unknown>(installed, entrypoint.path))
        for (const transform of definition.transforms) {
          commands.push({
            packageId: installed.packageId,
            packageVersion: installed.version,
            displayName: installed.manifest.displayName,
            summary: installed.manifest.summary,
            trigger: transform.trigger,
            displayTrigger: localizedPluginTrigger(installed.packageId, transform.trigger),
            description: transform.description,
            automatic: transform.trigger === 'always',
          })
        }
      }
    } catch {
      // A malformed installed package stays unavailable to the picker. The
      // runtime's strict parser remains the authority when a turn executes.
    }
  }
  return commands.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.trigger.localeCompare(right.trigger))
}

function localizedPluginTrigger(packageId: string, trigger: string): string {
  const localized: Record<string, Record<string, string>> = {
    'official-decision-log': { '/decision-log': '/决策记录' },
    'official-meeting-notes': { '/meeting-summary': '/会议纪要' },
    'official-release-check': { '/release-check': '/发布检查' },
    'official-research-brief': { '/research-brief': '/研究简报' },
  }
  return localized[packageId]?.[trigger] ?? trigger
}

export async function loadInstalledBlueprints(packages: InstalledPackage[]): Promise<EmployeeBlueprint[]> {
  const blueprints: EmployeeBlueprint[] = []
  for (const installed of packages.filter((item) => item.status === 'active')) {
    const entrypoints = (installed.manifest.entrypoints ?? []).filter((entrypoint) => entrypoint.kind === 'employee-blueprint')
    if (entrypoints.length === 0) continue
    assertEmployeeBlueprintPackage(installed, entrypoints.length)
    for (const entrypoint of entrypoints) {
      const value = await readEntrypoint<unknown>(installed, entrypoint.path)
      blueprints.push(parseEmployeeBlueprintManifest(value, {
        packageId: installed.packageId,
        packageCapabilities: installed.manifest.capabilities,
      }))
    }
  }
  return blueprints
}

/**
 * Read declaration-only Skill entrypoints from verified installed packages.
 * The caller still needs a trusted host Adapter for the returned Skill id;
 * package metadata never supplies an execution implementation.
 */
export async function loadInstalledSkills(
  packages: InstalledPackage[],
  verificationCache = defaultVerificationCache,
): Promise<InstalledSkillManifest[]> {
  const skills: InstalledSkillManifest[] = []
  for (const installed of packages.filter((item) => item.status === 'active' && item.kind === 'skill')) {
    const entrypoints = installed.manifest.entrypoints ?? []
    assertSkillPackage(installed, entrypoints.length)
    await verificationCache.verifyPackage(installed)
    for (const entrypoint of entrypoints) {
      const value = await readEntrypoint<unknown>(installed, entrypoint.path, verificationCache)
      skills.push({
        packageId: installed.packageId,
        packageVersion: installed.version,
        entrypointId: entrypoint.id,
        entrypointPath: entrypoint.path,
        manifest: parseSkillManifest(value, {
          packageId: installed.packageId,
          entrypointId: entrypoint.id,
        }),
      })
    }
  }
  return skills
}

export async function loadInstalledWorldThemes(
  packages: InstalledPackage[],
  verificationCache = defaultVerificationCache,
): Promise<InstalledWorldTheme[]> {
  const themes: InstalledWorldTheme[] = []
  for (const installed of packages.filter((item) => item.status === 'active' && item.kind === 'world-theme')) {
    const entrypoints = (installed.manifest.entrypoints ?? []).filter((entrypoint) => entrypoint.kind === 'world-theme')
    assertWorldThemePackage(installed, entrypoints.length)
    await verificationCache.verifyPackage(installed)
    for (const entrypoint of entrypoints) {
      const value = await readEntrypoint<unknown>(installed, entrypoint.path, verificationCache)
      const validation = validateWorldThemeManifest(value)
      if (!validation.valid) throw new Error(`Invalid installed world theme ${installed.packageId}: ${validation.errors.join('; ')}`)
      const manifest = value as WorldThemeManifestV1
      const declaredFiles = new Set(installed.manifest.files.map((file) => file.path))
      await validateWorldThemePackageAssets(
        manifest,
        declaredFiles,
        (relativePath) => verificationCache.readFile(installed, relativePath),
      )
      const entrypointFile = installed.manifest.files.find((file) => file.path === entrypoint.path)!
      themes.push({ packageId: installed.packageId, packageVersion: installed.version, contentDigest: entrypointFile.sha256, manifest })
    }
  }
  return themes
}

/** Load declaration-only skin packages from the workspace package library. */
export async function loadInstalledSkins(
  packages: InstalledPackage[],
  verificationCache = defaultVerificationCache,
): Promise<InstalledSkinManifest[]> {
  const skins: InstalledSkinManifest[] = []
  for (const installed of packages.filter((item) => item.status === 'active' && item.kind === 'skin')) {
    const entrypoints = (installed.manifest.entrypoints ?? []).filter((entrypoint) => entrypoint.kind === 'skin')
    assertSkinPackage(installed, entrypoints.length)
    await verificationCache.verifyPackage(installed)
    for (const entrypoint of entrypoints) {
      const value = await readEntrypoint<unknown>(installed, entrypoint.path, verificationCache)
      skins.push({
        packageId: installed.packageId,
        packageVersion: installed.version,
        entrypointId: entrypoint.id,
        entrypointPath: entrypoint.path,
        manifest: parseSkinManifest(value, { packageId: installed.packageId, packageVersion: installed.version }),
      })
    }
  }
  return skins
}

export async function validateStagedPackageEntrypoints(staged: StagedPackage): Promise<void> {
  const installed: InstalledPackage = {
    workspaceId: '__staged__',
    packageId: staged.manifest.id,
    version: staged.manifest.version,
    kind: staged.manifest.kind,
    status: 'active',
    installedPath: staged.path,
    capabilities: [...staged.manifest.capabilities],
    manifest: staged.manifest,
    installedAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  }
  const verificationCache = new InstalledPackageVerificationCache()
  await verificationCache.verifyPackage(installed)
  if (installed.kind === 'plugin') {
    await applyInstalledPromptTransforms([installed], '')
    return
  }
  if (installed.kind === 'employee-blueprint') {
    await loadInstalledBlueprints([installed])
    return
  }
  if (installed.kind === 'skill') {
    await loadInstalledSkills([installed], verificationCache)
    return
  }
  if (installed.kind === 'world-theme') {
    await loadInstalledWorldThemes([installed], verificationCache)
    return
  }
  if (installed.kind === 'skin') {
    await loadInstalledSkins([installed], verificationCache)
  }
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

async function readVerifiedPackageFile(
  installed: InstalledPackage,
  relativePath: string,
): Promise<{ body: Buffer; stamp: FileStamp }> {
  const declared = installed.manifest.files.find((file) => file.path === relativePath)
  if (declared === undefined) throw new Error(`Installed package file is not declared: ${installed.packageId}/${relativePath}`)
  const path = await securePackageFile(installed, relativePath)
  const handle = await open(path, 'r')
  try {
    const metadata = await handle.stat()
    const body = await handle.readFile()
    const digest = createHash('sha256').update(body).digest('hex')
    if (digest !== declared.sha256) throw new Error(`Installed package hash mismatch: ${installed.packageId}/${relativePath}`)
    return { body, stamp: fileStamp(metadata) }
  } finally {
    await handle.close()
  }
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

interface AppliedPromptTransform {
  packageId: string
  packageVersion: string
  entrypointId: string
  entrypointPath: string
  index: number
  transform: PromptTransform
}

function assertPromptTransformPackage(installed: InstalledPackage): void {
  if (installed.kind !== 'plugin' || installed.manifest.kind !== 'plugin') {
    throw new Error(`Prompt-transform entrypoint requires plugin package: ${installed.packageId}`)
  }
  if (!installed.manifest.capabilities.includes('prompt:transform')) {
    throw new Error(`Prompt-transform package is missing prompt:transform capability: ${installed.packageId}`)
  }
  if (installed.manifest.dataEgress.length !== 0) {
    throw new Error(`Prompt-transform package must not declare data egress: ${installed.packageId}`)
  }
}

function assertEmployeeBlueprintPackage(installed: InstalledPackage, entrypointCount: number): void {
  if (installed.kind !== 'employee-blueprint' || installed.manifest.kind !== 'employee-blueprint') {
    throw new Error(`Employee-blueprint entrypoint requires employee-blueprint package: ${installed.packageId}`)
  }
  if (entrypointCount !== 1) {
    throw new Error(`Employee-blueprint package requires exactly one entrypoint: ${installed.packageId}`)
  }
  if (!installed.manifest.capabilities.includes('employee:blueprint')) {
    throw new Error(`Employee-blueprint package is missing employee:blueprint capability: ${installed.packageId}`)
  }
  if (installed.manifest.dataEgress.length !== 0) {
    throw new Error(`Employee-blueprint package must not declare data egress: ${installed.packageId}`)
  }
}

function assertSkillPackage(installed: InstalledPackage, entrypointCount: number): void {
  if (installed.kind !== 'skill' || installed.manifest.kind !== 'skill') {
    throw new Error(`Skill entrypoint requires skill package: ${installed.packageId}`)
  }
  if (entrypointCount === 0) {
    throw new Error(`Skill package requires at least one skill entrypoint: ${installed.packageId}`)
  }
  if (installed.manifest.entrypoints?.some((entrypoint) => entrypoint.kind !== 'skill') === true) {
    throw new Error(`Skill package cannot mix entrypoint kinds: ${installed.packageId}`)
  }
}

function assertWorldThemePackage(installed: InstalledPackage, entrypointCount: number): void {
  if (installed.kind !== 'world-theme' || installed.manifest.kind !== 'world-theme') {
    throw new Error(`World-theme entrypoint requires world-theme package: ${installed.packageId}`)
  }
  if (entrypointCount !== 1) {
    throw new Error(`World-theme package requires exactly one entrypoint: ${installed.packageId}`)
  }
  if (!installed.manifest.capabilities.includes('world:render')) {
    throw new Error(`World-theme package is missing world:render capability: ${installed.packageId}`)
  }
  if (installed.manifest.dataEgress.length !== 0) {
    throw new Error(`World-theme package must not declare data egress: ${installed.packageId}`)
  }
}

function assertSkinPackage(installed: InstalledPackage, entrypointCount: number): void {
  if (installed.kind !== 'skin' || installed.manifest.kind !== 'skin') {
    throw new Error(`Skin entrypoint requires skin package: ${installed.packageId}`)
  }
  if (entrypointCount !== 1) {
    throw new Error(`Skin package requires exactly one entrypoint: ${installed.packageId}`)
  }
  if (!installed.manifest.capabilities.includes('ui:skin')) {
    throw new Error(`Skin package is missing ui:skin capability: ${installed.packageId}`)
  }
  if (installed.manifest.dataEgress.length !== 0) {
    throw new Error(`Skin package must not declare data egress: ${installed.packageId}`)
  }
  if (installed.manifest.entrypoints?.some((entrypoint) => entrypoint.kind !== 'skin') === true) {
    throw new Error(`Skin package cannot mix entrypoint kinds: ${installed.packageId}`)
  }
}

function transformMatches(prompt: string, trigger: string): boolean {
  if (trigger === 'always') return true
  const normalized = trigger.trim()
  return prompt === normalized || prompt.startsWith(`${normalized} `) || prompt.startsWith(`${normalized}\n`)
}

function compareInstalledPackages(left: InstalledPackage, right: InstalledPackage): number {
  return compareStrings(left.packageId, right.packageId) ||
    compareStrings(left.version, right.version) ||
    compareStrings(left.installedPath, right.installedPath)
}

function compareAppliedTransforms(left: AppliedPromptTransform, right: AppliedPromptTransform): number {
  return left.transform.priority === right.transform.priority
    ? compareStrings(left.packageId, right.packageId) ||
      compareStrings(left.packageVersion, right.packageVersion) ||
      compareStrings(left.entrypointId, right.entrypointId) ||
      compareStrings(left.entrypointPath, right.entrypointPath) ||
      compareStrings(left.transform.id, right.transform.id) ||
      left.index - right.index
    : left.transform.priority > right.transform.priority ? -1 : 1
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
