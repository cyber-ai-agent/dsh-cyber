import type { Router } from '../http/router.js'
import { writeJson } from '../http/response.js'
import type { AvatarBasePackService } from '../services/avatar-base-pack-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'

export function registerAvatarBasePackRoutes(
  router: Router,
  dependencies: { packs: AvatarBasePackService; access: WorldAccessService },
): void {
  const { packs, access } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/avatar-base-packs$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await access.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: await packs.list(worldId) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/avatar-base-packs\/([^/]+)\/([^/]+)\/assets\/(.+)$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await access.assertUnlocked(worldId, request)
    const asset = await packs.readBaseAsset(worldId, params[1]!, params[2]!, params[3]!)
    response.writeHead(200, {
      'content-type': asset.contentType,
      'content-length': asset.body.byteLength,
      // Installed package versions are immutable. The URL contains world,
      // package and exact version, so the browser may safely cache the heavy
      // Base VRM while employee recipes reuse it.
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    response.end(asset.body)
  })
}
