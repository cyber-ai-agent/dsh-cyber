import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, requiredString } from '../http/request.js'
import { writeBinary, writeJson } from '../http/response.js'
import type { AssetService } from '../services/asset-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'

export interface AssetRoutesDependencies {
  store: SqliteStore
  assets: AssetService
  access: WorldAccessService
}

export function registerAssetRoutes(router: Router, dependencies: AssetRoutesDependencies): void {
  const { store, assets, access } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/assets$/, ({ response, params }) => {
    writeJson(response, 200, { items: store.listLocalAssets(params[0]!) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/assets\/background$/, async ({ request, response, params }) => {
    if (store.getWorkspace(params[0]!) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const uploaded = await assets.uploadBackground({
      workspaceId: params[0]!,
      mimeType: requiredString(body, 'mimeType'),
      dataBase64: requiredString(body, 'dataBase64'),
    })
    writeJson(response, 201, uploaded)
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/assets\/attachment$/, async ({ request, response, params }) => {
    if (store.getWorkspace(params[0]!) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const uploaded = await assets.uploadAttachment({
      workspaceId: params[0]!,
      name: requiredString(body, 'name'),
      mimeType: requiredString(body, 'mimeType'),
      dataBase64: requiredString(body, 'dataBase64'),
    })
    writeJson(response, 201, uploaded)
  })

  router.post(/^\/api\/employees\/([^/]+)\/avatar-assets$/, async ({ request, response, params }) => {
    const employee = store.getEmployee(params[0]!)
    if (employee === undefined || employee.status === 'archived') {
      throw new HttpError(404, 'character_not_found', 'Character not found')
    }
    await access.assertUnlocked(employee.worldId, request)
    const body = await readJson(request, 28 * 1024 * 1024)
    const uploaded = await assets.uploadCharacterAvatar({
      employeeId: employee.id,
      name: requiredString(body, 'name'),
      mimeType: requiredString(body, 'mimeType'),
      dataBase64: requiredString(body, 'dataBase64'),
    })
    writeJson(response, 201, uploaded)
  })

  router.get(/^\/api\/assets\/([^/]+)$/, async ({ request, response, params }) => {
    const assetId = params[0]!
    const metadata = store.getLocalAsset(assetId)
    if (metadata?.kind === 'avatar') {
      const avatar = store.getCharacterAvatarAsset(assetId)
      if (avatar === undefined) throw new HttpError(404, 'avatar_asset_not_found', 'Character avatar asset not found')
      await access.assertUnlocked(avatar.worldId, request)
    } else if (metadata?.kind === 'attachment') {
      const worldId = legacyAttachmentWorldId(store, assetId)
      if (worldId !== undefined) await access.assertUnlocked(worldId, request)
    }
    const asset = await assets.read(assetId)
    writeBinary(response, 200, asset.body, asset.contentType)
  })
}

function legacyAttachmentWorldId(store: SqliteStore, assetId: string): string | undefined {
  for (const workspace of store.listWorkspaces()) {
    for (const world of store.listWorlds(workspace.id, true)) {
      for (const session of store.listSessions(world.id)) {
        for (const message of store.listMessages(session.id)) {
          const attachments = message.metadata.attachments
          if (!Array.isArray(attachments)) continue
          const found = attachments.some((item) => {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
            return (item as Record<string, unknown>).assetId === assetId
          })
          if (found) return world.id
        }
      }
    }
  }
  return undefined
}
