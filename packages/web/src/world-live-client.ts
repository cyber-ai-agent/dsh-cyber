const WORLD_LIVE_EVENT_NAMES = [
  'error',
  'ready',
  'conversation-control',
  'runtime',
  'trace',
  'world-cue',
  'world-decision',
  'world-artifact',
  'world-knowledge',
  'world-task',
  'world-runtime',
  'world-state',
] as const

type WorldLiveEventName = (typeof WORLD_LIVE_EVENT_NAMES)[number]
type WorldLiveListener = (event: Event) => void | Promise<void>

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
  // Each call owns a distinct subscription, even when callbacks are identical.
  const ownedListener: WorldLiveListener = (event) => listener(event)
  bucket.add(ownedListener)
  let stopped = false

  return () => {
    if (stopped) return
    stopped = true
    const current = clients.get(worldId)
    if (current !== client) return
    current.listeners.get(eventName)?.delete(ownedListener)
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
      const bucket = client.listeners.get(eventName)
      // Subscribers added by a callback start at the next event. Removed owners
      // are skipped rather than receiving a callback after unmount.
      for (const listener of [...(bucket ?? [])]) {
        if (!bucket?.has(listener)) continue
        try {
          const pending = listener(event)
          if (pending !== undefined) void Promise.resolve(pending).catch(reportSubscriberError)
        } catch (error) {
          reportSubscriberError(error)
        }
      }
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

function reportSubscriberError(error: unknown): void {
  console.error('[dsh-cyber] world live subscriber failed', error)
}

/**
 * For snapshot-backed panels only: ready reconciles events missed while offline.
 * Coalesce bursts and allow at most one live-refresh request plus one dirty bit.
 * Transient deltas/cues must still use subscribeWorldLive directly.
 */
export function subscribeWorldLiveRefresh(
  worldId: string,
  eventName: 'world-task' | 'world-artifact' | 'world-knowledge',
  refresh: () => void | Promise<void>,
): () => void {
  let disposed = false
  let running = false
  let dirty = false
  let timer: number | undefined
  const schedule = () => {
    if (disposed) return
    dirty = true
    if (running || timer !== undefined) return
    timer = window.setTimeout(() => { timer = undefined; void flush() }, 50)
  }
  const flush = async () => {
    if (disposed) return
    dirty = false
    running = true
    try { await refresh() } catch (error) { reportSubscriberError(error) }
    finally {
      running = false
      if (dirty && !disposed) schedule()
    }
  }
  const stopEvent = subscribeWorldLive(worldId, eventName, schedule)
  const stopReady = subscribeWorldLive(worldId, 'ready', schedule)
  return () => {
    disposed = true
    if (timer !== undefined) window.clearTimeout(timer)
    stopEvent()
    stopReady()
  }
}
