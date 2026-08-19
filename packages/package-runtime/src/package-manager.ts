import { createHash } from 'node:crypto'

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

export class PackageManager {
  readonly #store: PackageStorePort
  readonly #runtime: PackageRuntimePort

  constructor(options: { store: PackageStorePort; runtime: PackageRuntimePort }) {
    this.#store = options.store
    this.#runtime = options.runtime
  }

  preview(workspaceId: string, manifest: CyberPackageManifest): PackagePermissionPreview {
    validatePackageManifest(manifest)
    const active = this.#store.getActivePackage(workspaceId, manifest.id)
    const capabilities = sortedUnique(manifest.capabilities)
    const previousCapabilities = new Set(active?.capabilities ?? [])
    const currentCapabilities = new Set(capabilities)
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
    return {
      ...previewBase,
      approvalToken: approvalToken(previewBase),
    }
  }

  async install(input: InstallPackageInput): Promise<InstalledPackage> {
    const preview = this.preview(input.workspaceId, input.manifest)
    if (!timingSafeTextEqual(preview.approvalToken, input.approvalToken)) {
      throw new PackageApprovalRequiredError()
    }
    const beginInput: Parameters<PackageStorePort['beginPackageInstall']>[0] = {
      workspaceId: input.workspaceId,
      manifest: input.manifest,
      approvedCapabilities: preview.capabilities,
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
}

function approvalToken(value: Omit<PackagePermissionPreview, 'approvalToken'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return leftHash.equals(rightHash)
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
