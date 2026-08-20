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
}

export interface InstallPackageInput {
  workspaceId: string
  manifest: CyberPackageManifest
  sourceDirectory: string
  approvalToken: string
  actorId?: string
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

export class PackageManager {
  readonly #store: PackageStorePort
  readonly #runtime: PackageRuntimePort
  readonly #clock: () => Date
  readonly #approvalTtlMs: number
  readonly #approvalGrants = new Map<string, PackageApprovalGrant>()

  constructor(options: {
    store: PackageStorePort
    runtime: PackageRuntimePort
    clock?: () => Date
    approvalTtlMs?: number
  }) {
    this.#store = options.store
    this.#runtime = options.runtime
    this.#clock = options.clock ?? (() => new Date())
    this.#approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
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
      this.#store.markPackageInstallStaged(transaction.id)
      receipt = await this.#runtime.activate(staged)
      const completeInput: Parameters<PackageStorePort['completePackageInstall']>[0] = {
        transactionId: transaction.id,
        manifest: input.manifest,
        installedPath: receipt.installedPath,
      }
      if (input.actorId !== undefined) completeInput.actorId = input.actorId
      return this.#store.completePackageInstall(completeInput)
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
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported package manifest schema')
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
    throw new Error('Invalid package id')
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('Invalid package version')
  }
  for (const field of [manifest.displayName, manifest.summary, manifest.license, manifest.publisher]) {
    if (!field.trim()) throw new Error('Package metadata cannot be empty')
  }
  assertUnique(manifest.capabilities, 'capability')
  assertUnique(manifest.dataEgress, 'data egress declaration')
  assertUnique(manifest.files.map((file) => file.path), 'file path')
  for (const file of manifest.files) {
    if (!safeRelativePath(file.path)) throw new Error(`Unsafe package file path: ${file.path}`)
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid SHA-256: ${file.path}`)
  }
  const entrypoints = manifest.entrypoints ?? []
  assertUnique(entrypoints.map((entrypoint) => entrypoint.id), 'entrypoint id')
  const packageFiles = new Set(manifest.files.map((file) => file.path))
  for (const entrypoint of entrypoints) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(entrypoint.id)) {
      throw new Error(`Invalid package entrypoint id: ${entrypoint.id}`)
    }
    if (!safeRelativePath(entrypoint.path) || !packageFiles.has(entrypoint.path)) {
      throw new Error(`Package entrypoint is not a declared file: ${entrypoint.path}`)
    }
  }
  if (manifest.certification !== undefined) {
    if (!manifest.certification.authority.trim()) throw new Error('Package certification authority cannot be empty')
    if (!/^[a-f0-9]{64}$/.test(manifest.certification.contentSha256)) {
      throw new Error('Invalid package certification content SHA-256')
    }
    if (manifest.certification.contentSha256 !== packageContentDigest(manifest)) {
      throw new Error('Package certification digest does not match declared files')
    }
  }
}

export function packageContentDigest(manifest: Pick<CyberPackageManifest, 'files'>): string {
  const inventory = [...manifest.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}:${file.sha256}`)
    .join('\n')
  return createHash('sha256').update(inventory).digest('hex')
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
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function packageErrorCode(error: unknown): string {
  if (error instanceof PackageInstallError) return error.causeCode
  if (error instanceof Error && error.name) return error.name.replaceAll(/[^A-Za-z0-9_-]/g, '-').toLowerCase()
  return 'install-failed'
}
