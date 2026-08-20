import { join } from 'node:path'

import type { JsonObject, ModelProfile } from '@dsh-cyber/contracts'
import {
  clearActiveHarnessRuntime,
  inspectHarnessCandidate,
  inspectHarnessCandidateContract,
  inspectHarnessCompatibility,
  readActiveHarnessRuntime,
  runHarnessCandidateCanary,
  writeActiveHarnessRuntime,
  type HarnessModelRoute,
} from '@dsh-cyber/harness-adapter'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import {
  optionalPositiveInteger,
  readJson,
  requiredBoolean,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'

export interface SystemRoutesDependencies {
  store: SqliteStore
  stateRoot: string
  workspaceRoot: string
}

export function registerSystemRoutes(router: Router, dependencies: SystemRoutesDependencies): void {
  const { store, stateRoot, workspaceRoot } = dependencies
  const runtimeRoot = join(stateRoot, 'runtime')

  router.get('/api/health', ({ response }) => {
    writeJson(response, 200, { ok: true, database: store.doctor() })
  })

  router.get('/api/system/compatibility', async ({ response }) => {
    const compatibility = await inspectHarnessCompatibility(join(runtimeRoot, 'harness-home'))
    writeJson(response, compatibility.ok ? 200 : 503, compatibility)
  })

  router.get('/api/system/status', async ({ response }) => {
    const compatibility = await inspectHarnessCompatibility(join(runtimeRoot, 'harness-home'))
    const database = store.doctor()
    writeJson(response, 200, {
      ok: compatibility.ok && database.ok,
      checkedAt: new Date().toISOString(),
      stateRoot,
      database,
      compatibility,
      activeRuntime: await readActiveHarnessRuntime(runtimeRoot),
      runtimeUpdates: store.listRuntimeUpdateTransactions().slice(0, 10),
    })
  })

  router.post('/api/system/doctor', ({ response }) => {
    const database = store.doctor()
    writeJson(response, 200, { ok: database.ok, checkedAt: new Date().toISOString(), database })
  })

  router.post('/api/system/backup', async ({ response }) => {
    const destination = join(stateRoot, 'backups', `dsh-cyber-${artifactTimestamp()}.sqlite`)
    const output = await store.backup(destination)
    writeJson(response, 201, { ok: true, kind: 'backup', output, createdAt: new Date().toISOString() })
  })

  router.post('/api/system/export', async ({ response }) => {
    const destination = join(stateRoot, 'backups', `dsh-cyber-${artifactTimestamp()}.json`)
    const output = await store.exportJson(destination)
    writeJson(response, 201, { ok: true, kind: 'export', output, createdAt: new Date().toISOString() })
  })

  router.post('/api/system/update/verify', async ({ request, response }) => {
    const body = await readJson(request)
    const report = await inspectHarnessCandidate({
      candidateRoot: requiredString(body, 'candidateRoot'),
      stateRoot: runtimeRoot,
    })
    if (!report.ok || report.version === undefined || report.contractId === undefined) {
      writeJson(response, 200, report)
      return
    }
    const activeRuntime = await readActiveHarnessRuntime(runtimeRoot)
    const transaction = store.beginRuntimeUpdate({
      candidateRoot: report.candidateRoot,
      version: report.version,
      contractId: report.contractId,
      ...(activeRuntime === undefined ? {} : { previousRuntimeRoot: activeRuntime.candidateRoot }),
      report: report as unknown as JsonObject,
    })
    writeJson(response, 201, { ...report, transaction })
  })

  router.get('/api/system/updates', async ({ response }) => {
    writeJson(response, 200, {
      items: store.listRuntimeUpdateTransactions(),
      activeRuntime: await readActiveHarnessRuntime(runtimeRoot),
    })
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/contract-test$/, async ({ response, params }) => {
    const transaction = store.getRuntimeUpdateTransaction(params[0]!)
    if (transaction === undefined) throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    try {
      const report = await inspectHarnessCandidateContract({
        candidateRoot: transaction.candidateRoot,
        stateRoot: runtimeRoot,
      })
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'contract-tested',
        report,
      })
      writeJson(response, 200, { ok: true, transaction: updated })
    } catch (error) {
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'rejected',
        errorCode: 'runtime_contract_failed',
        report: { ok: false, message: errorMessage(error) },
      })
      writeJson(response, 422, { ok: false, transaction: updated, errors: [errorMessage(error)] })
    }
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/canary$/, async ({ request, response, params }) => {
    const transaction = store.getRuntimeUpdateTransaction(params[0]!)
    if (transaction === undefined) throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    const body = await readJson(request)
    const modelProfile = store.getModelProfile(requiredString(body, 'modelProfileId'))
    if (modelProfile === undefined) throw new HttpError(404, 'model_profile_not_found', 'Model profile not found')
    try {
      const report = await runHarnessCandidateCanary({
        candidateRoot: transaction.candidateRoot,
        stateRoot: join(runtimeRoot, 'updates', transaction.id),
        workspacePath: workspaceRoot,
        route: harnessModelRoute(modelProfile),
        inheritedEnvironment: process.env,
      })
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'canary-passed',
        report,
      })
      writeJson(response, 200, { ok: true, transaction: updated })
    } catch (error) {
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'rejected',
        errorCode: 'runtime_canary_failed',
        report: { ok: false, message: errorMessage(error) },
      })
      writeJson(response, 422, { ok: false, transaction: updated, errors: [errorMessage(error)] })
    }
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/activate$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    if (!requiredBoolean(body, 'approved')) {
      throw new HttpError(409, 'runtime_activation_approval_required', 'Explicit activation approval is required')
    }
    const transaction = store.getRuntimeUpdateTransaction(params[0]!)
    if (transaction === undefined) throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    if (transaction.status !== 'canary-passed') {
      throw new HttpError(409, 'runtime_update_not_ready', 'Runtime must pass the canary before activation')
    }
    const verification = await inspectHarnessCandidate({
      candidateRoot: transaction.candidateRoot,
      stateRoot: runtimeRoot,
    })
    if (!verification.ok || verification.version !== transaction.version) {
      throw new HttpError(409, 'runtime_candidate_changed', 'Candidate changed after canary verification')
    }
    const backup = await store.backup(join(stateRoot, 'backups', `pre-runtime-${artifactTimestamp()}.sqlite`))
    const previousPointer = await readActiveHarnessRuntime(runtimeRoot)
    try {
      await writeActiveHarnessRuntime(runtimeRoot, {
        schemaVersion: 1,
        transactionId: transaction.id,
        candidateRoot: transaction.candidateRoot,
        version: transaction.version,
        activatedAt: new Date().toISOString(),
      })
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'activated',
        report: { ok: true, backup, restartRequired: true },
      })
      writeJson(response, 200, { ok: true, transaction: updated, backup, restartRequired: true })
    } catch (error) {
      if (previousPointer === undefined) await clearActiveHarnessRuntime(runtimeRoot)
      else await writeActiveHarnessRuntime(runtimeRoot, previousPointer)
      throw error
    }
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/rollback$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    if (!requiredBoolean(body, 'approved')) {
      throw new HttpError(409, 'runtime_rollback_approval_required', 'Explicit rollback approval is required')
    }
    const transaction = store.getRuntimeUpdateTransaction(params[0]!)
    if (transaction === undefined) throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    if (transaction.status !== 'activated') {
      throw new HttpError(409, 'runtime_update_not_active', 'Only an activated runtime can be rolled back')
    }
    const backup = await store.backup(join(stateRoot, 'backups', `pre-rollback-${artifactTimestamp()}.sqlite`))
    if (transaction.previousRuntimeRoot === undefined) {
      await clearActiveHarnessRuntime(runtimeRoot)
    } else {
      const previous = await inspectHarnessCandidate({
        candidateRoot: transaction.previousRuntimeRoot,
        stateRoot: runtimeRoot,
      })
      if (!previous.ok || previous.version === undefined) {
        throw new HttpError(409, 'previous_runtime_unavailable', 'Previous runtime is unavailable; use the CLI recovery command to return to bundled DSH')
      }
      await writeActiveHarnessRuntime(runtimeRoot, {
        schemaVersion: 1,
        transactionId: `rollback-${transaction.id}`,
        candidateRoot: previous.candidateRoot,
        version: previous.version,
        activatedAt: new Date().toISOString(),
      })
    }
    const updated = store.transitionRuntimeUpdate({
      transactionId: transaction.id,
      status: 'rolled-back',
      report: { ok: true, backup, restartRequired: true },
    })
    writeJson(response, 200, { ok: true, transaction: updated, backup, restartRequired: true })
  })
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
