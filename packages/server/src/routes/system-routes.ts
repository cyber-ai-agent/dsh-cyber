import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  inspectHarnessCompatibility,
  readActiveHarnessRuntime,
} from '@dsh-cyber/harness-adapter'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, record, requiredBoolean, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import { CUSTOM_TOOL_NAME, type EnvironmentService } from '../environments/environment-service.js'
import type { EnvironmentProbeTier } from '../environments/environment-probe.js'
import { createLocalBackupBundle } from '../services/local-backup-service.js'
import type { RuntimeUpdateService } from '../services/runtime-update-service.js'
import type { ApplicationUpdateService } from '../services/application-update-service.js'

export interface SystemRoutesDependencies {
  store: SqliteStore
  stateRoot: string
  runtimeUpdates: RuntimeUpdateService
  applicationUpdates: ApplicationUpdateService
  /** Host machine profile; absent in embedders that never probed one. */
  environments?: EnvironmentService
}

export function registerSystemRoutes(router: Router, dependencies: SystemRoutesDependencies): void {
  const { store, stateRoot, runtimeUpdates, applicationUpdates, environments } = dependencies
  const runtimeRoot = join(stateRoot, 'runtime')

  // The machine profile is host state, like backup and doctor, so it lives
  // here rather than under a world. A name is a name: the probe always runs
  // its own fixed argument ladder, never a command line the owner typed.
  if (environments !== undefined) {
    router.get(/^\/api\/environments\/local$/, ({ response }) => {
      // Absence is a normal state (nothing probed yet), not an error.
      writeJson(response, 200, { profile: environments.currentLocal() ?? null })
    })

    router.post(/^\/api\/environments\/local\/refresh$/, async ({ request, response }) => {
      writeJson(response, 200, { profile: await environments.refreshLocal(environmentRefreshTier(record(await readJson(request))?.tier)) })
    })

    router.post(/^\/api\/environments\/local\/tools$/, async ({ request, response }) => {
      const name = customEnvironmentToolName(requiredString(await readJson(request), 'name'))
      try {
        writeJson(response, 201, { profile: await environments.addCustomTool(name) })
      } catch (cause) {
        throw new HttpError(422, 'environment_tool_not_addable', cause instanceof Error ? cause.message : '无法添加该工具')
      }
    })

    router.delete(/^\/api\/environments\/local\/tools\/([^/]+)$/, async ({ response, params }) => {
      const name = customEnvironmentToolName(params[0]!)
      try {
        writeJson(response, 200, { profile: await environments.removeCustomTool(name) })
      } catch (cause) {
        throw new HttpError(404, 'environment_tool_not_found', cause instanceof Error ? cause.message : '自定义工具不存在')
      }
    })
  }

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
      included: ['database.sqlite', 'worlds', 'assets', 'packages', 'workshop', 'skills', 'integrations', 'environments'],
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

  router.get('/api/system/application-update', async ({ response }) => {
    writeJson(response, 200, { ok: true, applicationUpdate: await applicationUpdates.check(true) })
  })

  router.post('/api/system/application-update/apply', async ({ request, response }) => {
    const body = await readJson(request)
    writeJson(response, 200, await applicationUpdates.apply(requiredBoolean(body, 'approved')))
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

/** An explicit refresh defaults to the full tier; a live turn may ask for fast. */
function environmentRefreshTier(value: unknown): EnvironmentProbeTier {
  if (value === undefined) return 'full'
  if (value === 'fast' || value === 'full') return value
  throw new HttpError(422, 'environment_tier_invalid', '刷新层级无效')
}

function customEnvironmentToolName(value: string): string {
  const name = value.trim().toLowerCase()
  if (!CUSTOM_TOOL_NAME.test(name)) throw new HttpError(422, 'environment_tool_name_invalid', '自定义工具名无效')
  return name
}
