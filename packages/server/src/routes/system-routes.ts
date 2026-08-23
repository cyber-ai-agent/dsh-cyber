import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  inspectHarnessCompatibility,
  readActiveHarnessRuntime,
} from '@dsh-cyber/harness-adapter'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, requiredBoolean, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import { createLocalBackupBundle } from '../services/local-backup-service.js'
import type { RuntimeUpdateService } from '../services/runtime-update-service.js'

export interface SystemRoutesDependencies {
  store: SqliteStore
  stateRoot: string
  runtimeUpdates: RuntimeUpdateService
}

export function registerSystemRoutes(router: Router, dependencies: SystemRoutesDependencies): void {
  const { store, stateRoot, runtimeUpdates } = dependencies
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
    const output = await createLocalBackupBundle(stateRoot, store)
    writeJson(response, 201, {
      ok: true,
      kind: 'backup',
      format: 'dsh-cyber-local-backup',
      bundle: true,
      output,
      createdAt: new Date().toISOString(),
      included: ['database.sqlite', 'worlds', 'assets', 'packages', 'workshop', 'skills'],
      excluded: ['credentials', 'runtime', 'worlds/*/cache', 'backups'],
    })
  })

  router.post('/api/system/export', async ({ response }) => {
    const backupRoot = join(stateRoot, 'backups')
    await mkdir(backupRoot, { recursive: true })
    const destination = join(backupRoot, `dsh-cyber-${artifactTimestamp()}.json`)
    const output = await store.exportJson(destination)
    writeJson(response, 201, { ok: true, kind: 'export', output, createdAt: new Date().toISOString() })
  })

  router.post('/api/system/update/verify', async ({ request, response }) => {
    const body = await readJson(request)
    const result = await runtimeUpdates.verify(requiredString(body, 'candidateRoot'))
    if (result.transaction === undefined) {
      writeJson(response, 200, result.report)
      return
    }
    writeJson(response, 201, { ...result.report, transaction: result.transaction })
  })

  router.get('/api/system/updates', async ({ response }) => {
    writeJson(response, 200, {
      items: store.listRuntimeUpdateTransactions(),
      activeRuntime: await readActiveHarnessRuntime(runtimeRoot),
    })
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/contract-test$/, async ({ response, params }) => {
    const result = await runtimeUpdates.contractTest(params[0]!)
    writeJson(response, result.ok ? 200 : 422, result)
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/canary$/, async ({ request, response, params }) => {
    if (store.getRuntimeUpdateTransaction(params[0]!) === undefined) {
      throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    }
    const body = await readJson(request)
    const result = await runtimeUpdates.canary(params[0]!, requiredString(body, 'modelProfileId'))
    writeJson(response, result.ok ? 200 : 422, result)
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/activate$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    writeJson(response, 200, await runtimeUpdates.activate(params[0]!, requiredBoolean(body, 'approved')))
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/rollback$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    writeJson(response, 200, await runtimeUpdates.rollback(params[0]!, requiredBoolean(body, 'approved')))
  })
}

function artifactTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}
