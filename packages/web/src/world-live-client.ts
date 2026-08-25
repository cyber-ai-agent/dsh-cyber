const WORLD_LIVE_EVENT_NAMES = [
  'error',
  'ready',
  'runtime',
  'trace',
  'world-cue',
  'world-decision',
  'world-runtime',
  'world-state',
] as const

type WorldLiveEventName = (typeof WORLD_LIVE_EVENT_NAMES)[number]
type WorldLiveListener = (event: Event) => void

interface SharedWorldLiveClient {
  source: EventSource
  listeners: Map<WorldLiveEventName, Set<WorldLiveListener>>
  closeTimer?: number
}

const clients = new Map<string, SharedWorldLiveClient>()

/**
 * Shares the long-lived conversation/trace SSE connection between all consumers
 * for a world. Keeping this origin-wide resource centralized prevents mounted UI
 * panels from exhausting the browser's HTTP/1.1 connection pool.
 */
export function subscribeWorldLive(
  worldId: string,
  eventName: WorldLiveEventName,
  listener: WorldLiveListener,
): () => void {
  const client = getOrCreateClient(worldId)
  if (client.closeTimer !== undefined) {
    window.clearTimeout(client.closeTimer)
    delete client.closeTimer
  }
  // Never assert here: an unknown name should register, not crash the app.
  const bucket = client.listeners.get(eventName) ?? new Set<WorldLiveListener>()
  client.listeners.set(eventName, bucket)
  bucket.add(listener)

  return () => {
    const current = clients.get(worldId)
    if (current === undefined) return
    current.listeners.get(eventName)?.delete(listener)
    if (hasListeners(current)) return

    // React development mode intentionally remounts effects. A short grace period
    // lets the remount reuse the same socket instead of briefly opening duplicates.
    current.closeTimer = window.setTimeout(() => {
      const latest = clients.get(worldId)
      if (latest !== current || hasListeners(current)) return
      current.source.close()
      clients.delete(worldId)
    }, 250)
  }
}

function getOrCreateClient(worldId: string): SharedWorldLiveClient {
  const existing = clients.get(worldId)
  if (existing !== undefined) return existing

  const source = new EventSource(`/api/worlds/${encodeURIComponent(worldId)}/live`)
  // Derived from the event union rather than hand-listed: a name added to the
  // type but forgotten here used to become a runtime crash on first subscribe,
  // and no test caught it because web tests render to static markup and never
  // run effects.
  const listeners = new Map<WorldLiveEventName, Set<WorldLiveListener>>(
    WORLD_LIVE_EVENT_NAMES.map((name) => [name, new Set<WorldLiveListener>()]),
  )
  const client: SharedWorldLiveClient = { source, listeners }
  for (const eventName of listeners.keys()) {
    source.addEventListener(eventName, (event) => {
      for (const listener of client.listeners.get(eventName) ?? []) listener(event)
    })
  }
  clients.set(worldId, client)
  return client
}

function hasListeners(client: SharedWorldLiveClient): boolean {
  for (const listeners of client.listeners.values()) {
    if (listeners.size > 0) return true
  }
  return false
}
