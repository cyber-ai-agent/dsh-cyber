import { join } from 'node:path'

import type { JsonObject, ModelProfile } from '@dsh-cyber/contracts'
import {
  clearActiveHarnessRuntime,
  inspectHarnessCandidate,
  inspectHarnessCandidateContract,
  readActiveHarnessRuntime,
  runHarnessCandidateCanary,
  writeActiveHarnessRuntime,
  type HarnessModelRoute,
} from '@dsh-cyber/harness-adapter'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { createLocalBackupBundle } from './local-backup-service.js'
import { ServiceError } from './service-error.js'

export class RuntimeUpdateService {
  readonly #store: SqliteStore
  readonly #stateRoot: string
  readonly #runtimeRoot: string
  readonly #workspaceRoot: string

  constructor(store: SqliteStore, stateRoot: string, workspaceRoot: string) {
    this.#store = store
    this.#stateRoot = stateRoot
    this.#runtimeRoot = join(stateRoot, 'runtime')
    this.#workspaceRoot = workspaceRoot
  }

  async verify(candidateRoot: string) {
    const report = await inspectHarnessCandidate({ candidateRoot, stateRoot: this.#runtimeRoot })
    if (!report.ok || report.version === undefined || report.contractId === undefined) {
      return { report }
    }
    const activeRuntime = await readActiveHarnessRuntime(this.#runtimeRoot)
    const transaction = this.#store.beginRuntimeUpdate({
      candidateRoot: report.candidateRoot,
      version: report.version,
      contractId: report.contractId,
      ...(activeRuntime === undefined ? {} : { previousRuntimeRoot: activeRuntime.candidateRoot }),
      report: report as unknown as JsonObject,
    })
    return { report, transaction }
  }

  async contractTest(transactionId: string) {
    const transaction = this.#requireTransaction(transactionId)
    try {
      const report = await inspectHarnessCandidateContract({
        candidateRoot: transaction.candidateRoot,
        stateRoot: this.#runtimeRoot,
      })
      const updated = this.#store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'contract-tested',
        report,
      })
      return { ok: true as const, transaction: updated }
    } catch (error) {
      const message = errorMessage(error)
      const updated = this.#store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'rejected',
        errorCode: 'runtime_contract_failed',
        report: { ok: false, message },
      })
      return { ok: false as const, transaction: updated, errors: [message] }
    }
  }

  async canary(transactionId: string, modelProfileId: string) {
    const transaction = this.#requireTransaction(transactionId)
    const modelProfile = this.#store.getModelProfile(modelProfileId)
    if (modelProfile === undefined) {
      throw new ServiceError('not-found', 'model_profile_not_found', 'Model profile not found')
    }
    try {
      const report = await runHarnessCandidateCanary({
        candidateRoot: transaction.candidateRoot,
        stateRoot: join(this.#runtimeRoot, 'updates', transaction.id),
        workspacePath: this.#workspaceRoot,
        route: harnessModelRoute(modelProfile),
        inheritedEnvironment: process.env,
      })
      const updated = this.#store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'canary-passed',
        report,
      })
      return { ok: true as const, transaction: updated }
    } catch (error) {
      const message = errorMessage(error)
      const updated = this.#store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'rejected',
        errorCode: 'runtime_canary_failed',
        report: { ok: false, message },
      })
      return { ok: false as const, transaction: updated, errors: [message] }
    }
  }

  async activate(transactionId: string, approved: boolean) {
    if (!approved) {
      throw new ServiceError('conflict', 'runtime_activation_approval_required', 'Explicit activation approval is required')
    }
    const transaction = this.#requireTransaction(transactionId)
    if (transaction.status !== 'canary-passed') {
      throw new ServiceError('conflict', 'runtime_update_not_ready', 'Runtime must pass the canary before activation')
    }
    const verification = await inspectHarnessCandidate({
      candidateRoot: transaction.candidateRoot,
      stateRoot: this.#runtimeRoot,
    })
    if (!verification.ok || verification.version !== transaction.version) {
      throw new ServiceError('conflict', 'runtime_candidate_changed', 'Candidate changed after canary verification')
    }
    const backup = await createLocalBackupBundle(this.#stateRoot, this.#store, {
      output: join(this.#stateRoot, 'backups', `pre-runtime-${artifactTimestamp()}.dshbackup`),
    })
    const previousPointer = await readActiveHarnessRuntime(this.#runtimeRoot)
    try {
      await writeActiveHarnessRuntime(this.#runtimeRoot, {
        schemaVersion: 1,
        transactionId: transaction.id,
        candidateRoot: transaction.candidateRoot,
        version: transaction.version,
        activatedAt: new Date().toISOString(),
      })
      const updated = this.#store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'activated',
        report: { ok: true, backup, restartRequired: true, localStateBundle: true },
      })
      return { ok: true as const, transaction: updated, backup, restartRequired: true as const }
    } catch (error) {
      if (previousPointer === undefined) await clearActiveHarnessRuntime(this.#runtimeRoot)
      else await writeActiveHarnessRuntime(this.#runtimeRoot, previousPointer)
      throw error
    }
  }

  async rollback(transactionId: string, approved: boolean) {
    if (!approved) {
      throw new ServiceError('conflict', 'runtime_rollback_approval_required', 'Explicit rollback approval is required')
    }
    const transaction = this.#requireTransaction(transactionId)
    if (transaction.status !== 'activated') {
      throw new ServiceError('conflict', 'runtime_update_not_active', 'Only an activated runtime can be rolled back')
    }
    const backup = await createLocalBackupBundle(this.#stateRoot, this.#store, {
      output: join(this.#stateRoot, 'backups', `pre-rollback-${artifactTimestamp()}.dshbackup`),
    })
    if (transaction.previousRuntimeRoot === undefined) {
      await clearActiveHarnessRuntime(this.#runtimeRoot)
    } else {
      const previous = await inspectHarnessCandidate({
        candidateRoot: transaction.previousRuntimeRoot,
        stateRoot: this.#runtimeRoot,
      })
      if (!previous.ok || previous.version === undefined) {
        throw new ServiceError(
          'conflict',
          'previous_runtime_unavailable',
          'Previous runtime is unavailable; use the CLI recovery command to return to bundled DSH',
        )
      }
      await writeActiveHarnessRuntime(this.#runtimeRoot, {
        schemaVersion: 1,
        transactionId: `rollback-${transaction.id}`,
        candidateRoot: previous.candidateRoot,
        version: previous.version,
        activatedAt: new Date().toISOString(),
      })
    }
    const updated = this.#store.transitionRuntimeUpdate({
      transactionId: transaction.id,
      status: 'rolled-back',
      report: { ok: true, backup, restartRequired: true, localStateBundle: true },
    })
    return { ok: true as const, transaction: updated, backup, restartRequired: true as const }
  }

  #requireTransaction(transactionId: string) {
    const transaction = this.#store.getRuntimeUpdateTransaction(transactionId)
    if (transaction === undefined) {
      throw new ServiceError('not-found', 'runtime_update_not_found', 'Runtime update transaction not found')
    }
    return transaction
  }
}

function harnessModelRoute(profile: ModelProfile): HarnessModelRoute {
  const contextWindow = optionalPositiveInteger(profile.settings.contextWindow)
  const maxTokens = optionalPositiveInteger(profile.settings.maxTokens)
  return {
    id: profile.id,
    displayName: profile.displayName,
    api: profile.api,
    baseURL: profile.baseUrl,
    modelId: profile.modelId,
    ...(profile.credentialEnvName === undefined ? {} : { apiKeyEnv: profile.credentialEnvName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

function artifactTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
