import type { IncomingMessage } from 'node:http'

import type { ApplicationAccessService } from '../services/application-access-service.js'

const PUBLIC_API_PATHS = new Set([
  '/api/application-access',
  '/api/application-access/unlock',
  '/api/application-access/recover',
  '/api/health',
  // Internal 联网搜索 bridge: called by spawned DSH workers over loopback with
  // a per-launch token (not a user credential), so it must work even while the
  // app lock is engaged. No active turn — and thus no worker — exists while
  // locked, and the token is the actual gate.
  '/api/integrations/firecrawl/search',
])

export async function assertApplicationAccess(
  service: ApplicationAccessService,
  request: IncomingMessage,
): Promise<void> {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const publicHealthPath = pathname === '/api/health' || pathname.startsWith('/api/health/')
  if (pathname.startsWith('/api/') && !publicHealthPath && !PUBLIC_API_PATHS.has(pathname)) {
    await service.assertUnlocked(request)
  }
}
