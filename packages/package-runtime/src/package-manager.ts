import { createHash, randomBytes } from 'node:crypto'

import type {
  CyberPackageManifest,
  InstalledPackage,
  PackageInstallTransaction,
  PackagePermissionPreview,
} from '@dsh-cyber/contracts'

export interface StagedPackage {
  manifest: CyberPackageManifest
  path: string
}

export interface PackageActivationReceipt {
  packageId: string
  version: string
  installedPath: string
  previousState?: string
}

export interface PackageRuntimePort {
  stage(manifest: CyberPackageManifest, sourceDirectory: string): Promise<StagedPackage>
  activate(staged: StagedPackage): Promise<PackageActivationReceipt>
  rollback(receipt: PackageActivationReceipt): Promise<void>
  discard(staged: StagedPackage): Promise<void>
}

export interface PackageStorePort {
  getActivePackage(workspaceId: string, packageId: string): InstalledPackage | undefined
  getPackageInstallTransaction(transactionId: string): PackageInstallTransaction | undefined
  beginPackageInstall(input: {
    workspaceId: string
    manifest: CyberPackageManifest
    approvedCapabilities: string[]
    actorId?: string
  }): PackageInstallTransaction
  markPackageInstallStaged(transactionId: string): PackageInstallTransaction
  completePackageInstall(input: {
    transactionId: string
    manifest: CyberPackageManifest
    installedPath: string
    actorId?: string
  }): InstalledPackage
  rollbackPackageInstall(input: {
    transactionId: string
    errorCode: string
    actorId?: string
  }): PackageInstallTransaction
  compensateActivatedPackageInstall(input: {
    transactionId: string
    errorCode: string
    actorId?: string
  }): PackageInstallTransaction
}

export interface InstallPackageInput {
  workspaceId: string
  manifest: CyberPackageManifest
  sourceDirectory: string
  approvalToken: string
  actorId?: string
}

export interface ReversiblePackageInstallation {
  installed: InstalledPackage
  transactionId: string
  receipt: PackageActivationReceipt
}

export class PackageApprovalRequiredError extends Error {
  constructor() {
    super('Package permissions changed or were not approved')
    this.name = 'PackageApprovalRequiredError'
  }
}

export class PackageInstallError extends Error {
  readonly causeCode: string

  constructor(causeCode: string, cause?: unknown) {
    super(`Package installation failed: ${causeCode}`, { cause })
    this.name = 'PackageInstallError'
    this.causeCode = causeCode
  }
}

interface PackageApprovalGrant {
  workspaceId: string
  manifestDigest: string
  activePackageDigest?: string
  capabilities: string[]
  expiresAtMs: number
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000
const MAX_APPROVAL_GRANTS = 2_048
const PACKAGE_KINDS = new Set(['plugin', 'skill', 'employee-blueprint', 'world-theme', 'asset', 'model-provider'])
const ENTRYPOINT_KINDS = new Set(['prompt-transform', 'employee-blueprint', 'world-theme', 'skill'])
const PACKAGE_KEYS = new Set([
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
])
const MAX_PACKAGE_FILES = 2_048
const MAX_PACKAGE_ENTRYPOINTS = 128
const MAX_PACKAGE_CAPABILITIES = 256
const MAX_PACKAGE_EGRESS = 128

export class PackageManager {
  readonly #store: PackageStorePort
  readonly #runtime: PackageRuntimePort
  readonly #clock: () => Date
  readonly #approvalTtlMs: number
  readonly #validateStaged: ((staged: StagedPackage) => Promise<void>) | undefined
  readonly #approvalGrants = new Map<string, PackageApprovalGrant>()

  constructor(options: {
    store: PackageStorePort
    runtime: PackageRuntimePort
    clock?: () => Date
    approvalTtlMs?: number
    validateStaged?: (staged: StagedPackage) => Promise<void>
  }) {
    this.#store = options.store
    this.#runtime = options.runtime
    this.#clock = options.clock ?? (() => new Date())
    this.#approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.#validateStaged = options.validateStaged
    if (!Number.isSafeInteger(this.#approvalTtlMs) || this.#approvalTtlMs <= 0) {
      throw new Error('Package approval TTL must be a positive integer')
    }
  }

  preview(workspaceId: string, manifest: CyberPackageManifest): PackagePermissionPreview {
    validatePackageManifest(manifest)
    const active = this.#store.getActivePackage(workspaceId, manifest.id)
    const capabilities = sortedUnique(manifest.capabilities)
    const previousCapabilities = new Set(active?.capabilities ?? [])
    const currentCapabilities = new Set(capabilities)
    const now = this.#clock()
    const expiresAt = new Date(now.getTime() + this.#approvalTtlMs)
    const approvalToken = randomBytes(32).toString('base64url')
    const previewBase = {
      workspaceId,
      packageId: manifest.id,
      version: manifest.version,
      capabilities,
      addedCapabilities: capabilities.filter((item) => !previousCapabilities.has(item)),
      removedCapabilities: [...previousCapabilities].filter((item) => !currentCapabilities.has(item)).sort(),
      dataEgress: sortedUnique(manifest.dataEgress),
      ...(active === undefined ? {} : { previousVersion: active.version }),
    }
    this.#purgeApprovalGrants(now.getTime())
    this.#approvalGrants.set(tokenDigest(approvalToken), {
      workspaceId,
      manifestDigest: packageManifestDigest(manifest),
      ...(active === undefined ? {} : { activePackageDigest: installedPackageDigest(active) }),
      capabilities,
      expiresAtMs: expiresAt.getTime(),
    })
    this.#trimApprovalGrants()
    return {
      ...previewBase,
      approvalToken,
      approvalExpiresAt: expiresAt.toISOString(),
    }
  }

  async install(input: InstallPackageInput): Promise<InstalledPackage> {
    return (await this.installReversible(input)).installed
  }

  async installReversible(input: InstallPackageInput): Promise<ReversiblePackageInstallation> {
    validatePackageManifest(input.manifest)
    const digest = tokenDigest(input.approvalToken)
    const grant = this.#approvalGrants.get(digest)
    if (grant === undefined) {
      throw new PackageApprovalRequiredError()
    }
    this.#approvalGrants.delete(digest)
    const active = this.#store.getActivePackage(input.workspaceId, input.manifest.id)
    const activePackageDigest = active === undefined ? undefined : installedPackageDigest(active)
    if (
      grant.expiresAtMs <= this.#clock().getTime()
      || grant.workspaceId !== input.workspaceId
      || grant.manifestDigest !== packageManifestDigest(input.manifest)
      || grant.activePackageDigest !== activePackageDigest
    ) throw new PackageApprovalRequiredError()
    const beginInput: Parameters<PackageStorePort['beginPackageInstall']>[0] = {
      workspaceId: input.workspaceId,
      manifest: input.manifest,
      approvedCapabilities: grant.capabilities,
    }
    if (input.actorId !== undefined) beginInput.actorId = input.actorId
    const transaction = this.#store.beginPackageInstall(beginInput)
    let staged: StagedPackage | undefined
    let receipt: PackageActivationReceipt | undefined
    try {
      staged = await this.#runtime.stage(input.manifest, input.sourceDirectory)
      await this.#validateStaged?.(staged)
      this.#store.markPackageInstallStaged(transaction.id)
      receipt = await this.#runtime.activate(staged)
      const completeInput: Parameters<PackageStorePort['completePackageInstall']>[0] = {
        transactionId: transaction.id,
        manifest: input.manifest,
        installedPath: receipt.installedPath,
      }
      if (input.actorId !== undefined) completeInput.actorId = input.actorId
      const installed = this.#store.completePackageInstall(completeInput)
      return { installed, transactionId: transaction.id, receipt }
    } catch (error) {
      if (receipt !== undefined) await this.#runtime.rollback(receipt).catch(() => undefined)
      if (staged !== undefined) await this.#runtime.discard(staged).catch(() => undefined)
      const errorCode = packageErrorCode(error)
      const rollbackInput: Parameters<PackageStorePort['rollbackPackageInstall']>[0] = {
        transactionId: transaction.id,
        errorCode,
      }
      if (input.actorId !== undefined) rollbackInput.actorId = input.actorId
      this.#store.rollbackPackageInstall(rollbackInput)
      throw new PackageInstallError(errorCode, error)
    }
  }

  /**
   * Idempotently compensate one previously activated install.
   *
   * Crash recovery may replay compensation after the filesystem or DB half of a
   * rollback already completed. The durable transaction is authoritative: a
   * rolled-back transaction is already safe, while any other non-activated
   * state is not a valid compensation target.
   */
  async compensate(
    installation: ReversiblePackageInstallation,
    errorCode: string,
    actorId = 'system',
  ): Promise<void> {
    const transaction = this.#store.getPackageInstallTransaction(installation.transactionId)
    if (transaction?.status === 'rolled-back') return
    if (transaction === undefined || transaction.status !== 'activated') {
      throw new Error(`Package install transaction cannot be compensated from ${transaction?.status ?? 'missing'}`)
    }

    // LocalPackageRuntime.rollback is intentionally idempotent: restoring the
    // previous pointer twice and force-removing an already removed install path
    // are both safe. This closes the crash window between filesystem rollback
    // and SQLite compensation.
    await this.#runtime.rollback(installation.receipt)
    this.#store.compensateActivatedPackageInstall({
      transactionId: installation.transactionId,
      errorCode,
      actorId,
    })
  }

  #purgeApprovalGrants(nowMs: number): void {
    for (const [key, grant] of this.#approvalGrants) {
      if (grant.expiresAtMs <= nowMs) this.#approvalGrants.delete(key)
    }
  }

  #trimApprovalGrants(): void {
    while (this.#approvalGrants.size > MAX_APPROVAL_GRANTS) {
      const oldest = this.#approvalGrants.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.#approvalGrants.delete(oldest)
    }
  }
}

export function validatePackageManifest(manifest: CyberPackageManifest): void {
  if (!isRecord(manifest)) throw new Error('Package manifest must be an object')
  assertAllowedKeys(manifest, PACKAGE_KEYS, 'package manifest')
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported package manifest schema')
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
    throw new Error('Invalid package id')
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('Invalid package version')
  }
  if (!PACKAGE_KINDS.has(manifest.kind)) throw new Error('Invalid package kind')
  assertText(manifest.displayName, 'displayName', 100)
  assertText(manifest.summary, 'summary', 500)
  assertText(manifest.license, 'license', 128)
  if (!/^[A-Za-z0-9.+-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$/.test(manifest.license)) {
    throw new Error('Package license must be an SPDX identifier or expression')
  }
  assertText(manifest.publisher, 'publisher', 200)
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > MAX_PACKAGE_CAPABILITIES) {
    throw new Error(`Package capabilities must contain at most ${MAX_PACKAGE_CAPABILITIES} items`)
  }
  if (!Array.isArray(manifest.dataEgress) || manifest.dataEgress.length > MAX_PACKAGE_EGRESS) {
    throw new Error(`Package data egress must contain at most ${MAX_PACKAGE_EGRESS} items`)
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_PACKAGE_FILES) {
    throw new Error(`Package files must contain between 1 and ${MAX_PACKAGE_FILES} items`)
  }
  manifest.capabilities.forEach((capability) => {
    if (typeof capability !== 'string' || !/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/.test(capability)) {
      throw new Error(`Invalid package capability: ${String(capability)}`)
    }
  })
  manifest.dataEgress.forEach(assertDataEgress)
  assertUnique(manifest.capabilities, 'capability')
  assertUnique(manifest.dataEgress, 'data egress declaration')
  const filePaths: string[] = []
  for (const file of manifest.files) {
    if (!isRecord(file)) throw new Error('Package file entry must be an object')
    assertAllowedKeys(file, new Set(['path', 'sha256']), 'package file')
    if (typeof file.path !== 'string' || file.path.length > 512) throw new Error('Invalid package file path')
    if (!safeRelativePath(file.path)) throw new Error(`Unsafe package file path: ${file.path}`)
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid SHA-256: ${file.path}`)
    filePaths.push(file.path)
  }
  assertUnique(filePaths, 'file path')
  const entrypoints = manifest.entrypoints ?? []
  if (!Array.isArray(entrypoints) || entrypoints.length > MAX_PACKAGE_ENTRYPOINTS) {
    throw new Error(`Package entrypoints must contain at most ${MAX_PACKAGE_ENTRYPOINTS} items`)
  }
  const entrypointIds: string[] = []
  const packageFiles = new Set(filePaths)
  for (const entrypoint of entrypoints) {
    if (!isRecord(entrypoint)) throw new Error('Package entrypoint must be an object')
    assertAllowedKeys(entrypoint, new Set(['id', 'kind', 'path']), 'package entrypoint')
    if (typeof entrypoint.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(entrypoint.id)) {
      throw new Error(`Invalid package entrypoint id: ${String(entrypoint.id)}`)
    }
    if (typeof entrypoint.kind !== 'string' || !ENTRYPOINT_KINDS.has(entrypoint.kind)) throw new Error(`Invalid package entrypoint kind: ${String(entrypoint.kind)}`)
    if (typeof entrypoint.path !== 'string' || !safeRelativePath(entrypoint.path) || !packageFiles.has(entrypoint.path)) {
      throw new Error(`Package entrypoint is not a declared file: ${String(entrypoint.path)}`)
    }
    entrypointIds.push(entrypoint.id)
    assertEntrypointContract(manifest, entrypoint.kind)
  }
  assertUnique(entrypointIds, 'entrypoint id')
  if (['plugin', 'employee-blueprint', 'world-theme'].includes(manifest.kind) && entrypoints.length === 0) {
    throw new Error(`Package kind ${manifest.kind} requires an entrypoint`)
  }
  if (['employee-blueprint', 'world-theme'].includes(manifest.kind) && entrypoints.length !== 1) {
    throw new Error(`Package kind ${manifest.kind} requires exactly one entrypoint`)
  }
  if (manifest.certification !== undefined) {
    if (!isRecord(manifest.certification)) throw new Error('Package certification must be an object')
    assertAllowedKeys(manifest.certification, new Set(['authority', 'level', 'contentSha256']), 'package certification')
    assertText(manifest.certification.authority, 'certification authority', 200)
    if (!['official', 'community'].includes(manifest.certification.level)) throw new Error('Invalid package certification level')
    if (!/^[a-f0-9]{64}$/.test(manifest.certification.contentSha256)) {
      throw new Error('Invalid package certification content SHA-256')
    }
    if (manifest.certification.contentSha256 !== packageContentDigest(manifest)) {
      throw new Error('Package certification digest does not match the declared manifest contents')
    }
  }
}

export function packageContentDigest(manifest: CyberPackageManifest): string {
  const certification = manifest.certification === undefined
    ? undefined
    : { authority: manifest.certification.authority, level: manifest.certification.level }
  const unsignedManifest = {
    ...manifest,
    ...(certification === undefined ? {} : { certification }),
  }
  return createHash('sha256').update(stableSerialize(unsignedManifest)).digest('hex')
}

export function packageManifestDigest(manifest: CyberPackageManifest): string {
  return createHash('sha256').update(stableSerialize(manifest)).digest('hex')
}

function installedPackageDigest(installed: InstalledPackage): string {
  return `${installed.packageId}@${installed.version}:${packageManifestDigest(installed.manifest)}`
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate package ${label}`)
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const parts = value.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
}

function assertEntrypointContract(manifest: CyberPackageManifest, kind: string): void {
  const expectation = ({
    'prompt-transform': { packageKind: 'plugin', capability: 'prompt:transform', noEgress: true },
    'employee-blueprint': { packageKind: 'employee-blueprint', capability: 'employee:blueprint', noEgress: true },
    'world-theme': { packageKind: 'world-theme', capability: 'world:render', noEgress: true },
    // A skill entrypoint is the one kind whose declared egress is not enforced
    // by the runtime, so the declaration itself has to be non-trivial: it must
    // name a capability, and a capability that reaches an external integration
    // must name where the data goes.
    skill: { packageKind: 'skill', capability: undefined, noEgress: false },
  } as const)[kind as 'prompt-transform' | 'employee-blueprint' | 'world-theme' | 'skill']
  if (expectation === undefined || manifest.kind !== expectation.packageKind) {
    throw new Error(`Entrypoint ${kind} is incompatible with package kind ${manifest.kind}`)
  }
  if (expectation.capability !== undefined && !manifest.capabilities.includes(expectation.capability)) {
    throw new Error(`Entrypoint ${kind} requires capability ${expectation.capability}`)
  }
  if (kind === 'skill') {
    if (manifest.capabilities.length === 0) {
      throw new Error('Entrypoint skill must declare at least one capability')
    }
    if (manifest.capabilities.some((capability) => capability.startsWith('integration:')) && manifest.dataEgress.length === 0) {
      throw new Error('Entrypoint skill with an integration capability must declare its data egress')
    }
  }
  if (expectation.noEgress && manifest.dataEgress.length > 0) {
    throw new Error(`Entrypoint ${kind} does not support data egress`)
  }
}

function assertDataEgress(value: string): void {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid package data egress declaration')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid package data egress URL: ${value}`)
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(`Invalid package data egress URL: ${value}`)
  }
}

function assertText(value: unknown, field: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Package ${field} must be non-empty text of at most ${maximum} characters`)
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} field: ${key}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function packageErrorCode(error: unknown): string {
  if (error instanceof PackageInstallError) return error.causeCode
  if (error instanceof Error && error.name) return error.name.replaceAll(/[^A-Za-z0-9_-]/g, '-').toLowerCase()
  return 'install-failed'
}
