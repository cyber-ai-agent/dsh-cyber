import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  World,
  WorldCue,
  WorldInteractionRequest,
  WorldInteractionResult,
  WorldRuntimeEntityState,
  WorldRuntimeSnapshot,
  WorldRuntimeStreamEnvelope,
  WorldThemeManifestV1,
  WorldThemeOption,
  WorldThemeSceneManifest,
} from '@dsh-cyber/contracts'
import { cyberCompanyTheme, findPath, getAnchor, getScene } from '@dsh-cyber/world-runtime'

import { api } from '../../api.js'
import type { CyberEmployee } from '../../types.js'

export interface WorldClientState {
  snapshot?: WorldRuntimeSnapshot
  manifest: WorldThemeManifestV1
  rendererIdentity: string
  cues: WorldCue[]
  loading: boolean
  connected: boolean
  error?: string
}

interface UseWorldClientInput {
  demoMode: boolean
  world: World
  employees: CyberEmployee[]
}

export function useWorldClient({ demoMode, world, employees }: UseWorldClientInput) {
  const manifest = cyberCompanyTheme
  const [state, setState] = useState<WorldClientState>(() => ({
    manifest,
    rendererIdentity: builtInRendererIdentity(manifest),
    cues: [],
    loading: !demoMode,
    connected: demoMode,
    ...(demoMode ? { snapshot: demoSnapshot(world, employees, manifest) } : {}),
  }))

  useEffect(() => {
    if (!demoMode) return
    setState((current) => ({
      ...current,
      manifest,
      rendererIdentity: builtInRendererIdentity(manifest),
      snapshot: mergeDemoEmployees(current.snapshot, world, employees, manifest),
      loading: false,
      connected: true,
    }))
  }, [demoMode, employees, manifest, world])

  useEffect(() => {
    if (demoMode) return
    let cancelled = false
    let stream: EventSource | undefined
    void Promise.all([
      api<WorldRuntimeSnapshot>(`/api/worlds/${encodeURIComponent(world.id)}/runtime-snapshot`),
      api<WorldThemeManifestV1>(`/api/worlds/${encodeURIComponent(world.id)}/theme-manifest`),
      api<{ items: WorldThemeOption[] }>(`/api/worlds/${encodeURIComponent(world.id)}/themes`),
    ]).then(([snapshot, nextManifest, themes]) => {
      if (cancelled) return
      const activeTheme = themes.items.find((item) => item.active)
      setState((current) => ({
        ...current,
        snapshot,
        manifest: nextManifest,
        rendererIdentity: activeTheme === undefined ? builtInRendererIdentity(nextManifest) : rendererIdentity(activeTheme),
        loading: false,
        connected: true,
      }))
      stream = new EventSource(`/api/worlds/${encodeURIComponent(world.id)}/stream?after=${snapshot.sequence}`)
      let currentSequence = snapshot.sequence
      const onState = (event: Event) => {
        const envelope = parseEnvelope(event)
        if (envelope?.kind !== 'world-state') return
        currentSequence = Math.max(currentSequence, envelope.sequence)
        setState((current) => reduceWorldStreamState(current, envelope))
      }
      const onCue = (event: Event) => {
        const envelope = parseEnvelope(event)
        if (envelope?.kind !== 'world-cue') return
        setState((current) => reduceWorldStreamState(current, envelope))
      }
      const onRecovery = () => {
        setState((current) => ({ ...current, cues: [], connected: false }))
        void api<WorldRuntimeSnapshot>(`/api/worlds/${encodeURIComponent(world.id)}/runtime-snapshot`)
          .then((recovered) => {
            currentSequence = Math.max(currentSequence, recovered.sequence)
            if (!cancelled) setState((current) => ({ ...current, snapshot: recovered, cues: [], connected: true }))
          })
      }
      const onReady = (event: Event) => {
        const envelope = parseEnvelope(event)
        if (envelope === undefined || currentSequence >= envelope.sequence) {
          setState((current) => ({ ...current, connected: true }))
          return
        }
        void api<WorldRuntimeSnapshot>(`/api/worlds/${encodeURIComponent(world.id)}/runtime-snapshot`)
          .then((recovered) => {
            currentSequence = Math.max(currentSequence, recovered.sequence)
            if (!cancelled) setState((latest) => ({ ...latest, snapshot: recovered, cues: [], connected: true }))
          })
      }
      stream.addEventListener('world-state', onState)
      stream.addEventListener('world-cue', onCue)
      stream.addEventListener('recovery-required', onRecovery)
      stream.addEventListener('ready', onReady)
      stream.onerror = () => { if (!cancelled) setState((current) => ({ ...current, connected: false })) }
    }).catch((cause: unknown) => {
      if (!cancelled) setState((current) => ({
        ...current,
        loading: false,
        connected: false,
        error: cause instanceof Error ? cause.message : '世界运行时加载失败',
      }))
    })
    return () => {
      cancelled = true
      stream?.close()
    }
  }, [demoMode, world.id])

  const interact = useCallback(async (request: WorldInteractionRequest) => {
    if (demoMode) {
      setState((current) => demoInteraction(current, request))
      return
    }
    const result = await api<WorldInteractionResult>(`/api/worlds/${encodeURIComponent(world.id)}/interactions`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
    setState((current) => ({
      ...current,
      snapshot: result.snapshot,
      cues: result.cues.reduce(appendCue, current.cues),
      connected: true,
    }))
  }, [demoMode, world.id])

  return useMemo(() => ({ ...state, interact }), [interact, state])
}

function rendererIdentity(theme: WorldThemeOption): string {
  return [theme.packageId ?? '@dsh-cyber/builtin-world-themes', theme.packageVersion ?? theme.version, theme.themeId, theme.version, theme.contentDigest].join(':')
}

function builtInRendererIdentity(manifest: WorldThemeManifestV1): string {
  return `@dsh-cyber/builtin-world-themes:${manifest.version}:${manifest.id}:${manifest.version}:bundled`
}

function parseEnvelope(event: Event): WorldRuntimeStreamEnvelope | undefined {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as WorldRuntimeStreamEnvelope
  } catch {
    return undefined
  }
}

function appendCue(current: WorldCue[], cue: WorldCue): WorldCue[] {
  return [...current.filter((item) => item.id !== cue.id), cue].slice(-48)
}

export function reduceWorldStreamState(
  current: WorldClientState,
  envelope: WorldRuntimeStreamEnvelope,
): WorldClientState {
  if (envelope.kind === 'world-state') {
    const snapshot = envelope.payload as unknown as WorldRuntimeSnapshot
    if (current.snapshot !== undefined && snapshot.sequence < current.snapshot.sequence) return current
    return { ...current, snapshot, connected: true }
  }
  if (envelope.kind === 'world-cue') {
    const cue = envelope.payload as unknown as WorldCue
    if (current.snapshot !== undefined && cue.sequence < current.snapshot.sequence) return current
    if (current.cues.some((item) => item.id === cue.id)) return { ...current, connected: true }
    return { ...current, cues: appendCue(current.cues, cue), connected: true }
  }
  return current
}

function demoSnapshot(world: World, employees: CyberEmployee[], manifest: WorldThemeManifestV1): WorldRuntimeSnapshot {
  const scene = getScene(manifest)
  const now = new Date().toISOString()
  return {
    contractVersion: 1,
    workspaceId: world.workspaceId,
    worldId: world.id,
    templateId: world.templateId,
    themeId: manifest.id,
    sceneId: scene.id,
    sequence: 1,
    generatedAt: now,
    clock: { now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', lightsOn: true },
    entities: employees.map((employee, index) => {
      const placement = demoPlacement(scene, index)
      return demoEntity(employee, placement.anchorId, placement.position, placement.facing, now)
    }),
    objects: scene.interactables.map((object) => ({
      id: object.id,
      sceneId: scene.id,
      kind: object.kind,
      displayName: object.displayName,
      anchorId: object.approachAnchorIds[0] ?? 'spawn',
      state: 'idle',
      activityLabel: '可交互',
      visualState: {},
      updatedAt: now,
    })),
    growthSlots: {},
  }
}

function mergeDemoEmployees(
  previous: WorldRuntimeSnapshot | undefined,
  world: World,
  employees: CyberEmployee[],
  manifest: WorldThemeManifestV1,
): WorldRuntimeSnapshot {
  if (previous === undefined || previous.worldId !== world.id) return demoSnapshot(world, employees, manifest)
  const scene = getScene(manifest, previous.sceneId)
  const existing = new Map(previous.entities.map((entity) => [entity.id, entity]))
  return {
    ...previous,
    entities: employees.map((employee, index) => {
      const current = existing.get(employee.id)
      if (current !== undefined) return { ...current, displayName: employee.displayName, role: employee.role, status: employee.status }
      const placement = demoPlacement(scene, index)
      return demoEntity(employee, placement.anchorId, placement.position, placement.facing, new Date().toISOString())
    }),
  }
}

function demoPlacement(scene: WorldThemeSceneManifest, index: number): {
  anchorId: string
  position: { x: number; y: number }
  facing: WorldRuntimeEntityState['facing']
} {
  const anchors = scene.anchors.filter((anchor) => anchor.tags.some((tag) => tag === 'work' || tag === 'idle'))
  const placements = anchors.flatMap((anchor) => {
    const count = Math.max(1, Math.min(anchor.capacity, 3))
    return Array.from({ length: count }, (_, slot) => {
      const spread = count === 1 ? 0 : 74
      const x = anchor.position.x + (slot - (count - 1) / 2) * spread
      const y = anchor.position.y + (count === 3 && slot === 1 ? 34 : 0)
      return { anchorId: anchor.id, position: { x, y }, facing: anchor.facing }
    })
  })
  return placements[index % placements.length] ?? (() => {
    const spawn = getAnchor(scene, 'spawn')
    return { anchorId: spawn.id, position: spawn.position, facing: spawn.facing }
  })()
}

function demoEntity(
  employee: CyberEmployee,
  anchorId: string,
  position: { x: number; y: number },
  facing: WorldRuntimeEntityState['facing'],
  now: string,
): WorldRuntimeEntityState {
  return {
    id: employee.id,
    kind: 'agent',
    sceneId: 'headquarters',
    sourceId: employee.id,
    displayName: employee.displayName,
    role: employee.role,
    anchorId,
    position: { ...position },
    footOffset: { x: 0, y: 112 },
    facing,
    activity: employee.status === 'working' ? 'working' : employee.status === 'blocked' ? 'blocked' : 'idle',
    activityLabel: employee.currentActivity,
    status: employee.status,
    route: [],
    visualState: { rosterIndex: employee.avatarIndex },
    updatedAt: now,
  }
}

function demoInteraction(current: WorldClientState, request: WorldInteractionRequest): WorldClientState {
  const snapshot = current.snapshot
  if (snapshot === undefined) return current
  const scene = getScene(current.manifest, snapshot.sceneId)
  if (request.action === 'toggle-lights') {
    return {
      ...current,
      snapshot: { ...snapshot, clock: { ...snapshot.clock, lightsOn: !snapshot.clock.lightsOn } },
    }
  }
  if (request.action === 'start-meeting' || request.action === 'assign-task') return current
  const entity = request.entityId === undefined ? undefined : snapshot.entities.find((item) => item.id === request.entityId)
  const object = request.objectId === undefined ? undefined : scene.interactables.find((item) => item.id === request.objectId)
  const anchor = object?.approachAnchorIds[0] === undefined ? undefined : getAnchor(scene, object.approachAnchorIds[0])
  if (entity === undefined || anchor === undefined) return current
  const path = findPath(scene.navigation, entity.position, anchor.position)
  const cue = routeCue(snapshot, entity.id, anchor.id, path)
  const activity = request.action === 'talk' ? 'talking' : request.action === 'inspect' ? 'idle' : 'working'
  return {
    ...current,
    snapshot: {
      ...snapshot,
      sequence: snapshot.sequence + 1,
      entities: snapshot.entities.map((item) => item.id === entity.id ? {
        ...item,
        position: { ...anchor.position },
        anchorId: anchor.id,
        facing: anchor.facing,
        route: [],
        activity,
        activityLabel: request.action === 'assign-task' ? '正在执行新任务' : `正在使用${object?.displayName ?? '场景设施'}`,
      } : item),
      objects: snapshot.objects.map((item) => item.id === request.objectId ? { ...item, state: 'active', activityLabel: '正在使用' } : item),
    },
    cues: appendCue(current.cues, cue),
  }
}

function routeCue(
  snapshot: WorldRuntimeSnapshot,
  entityId: string,
  targetAnchorId: string,
  path: { x: number; y: number }[],
): WorldCue {
  return {
    id: `demo-route-${entityId}-${snapshot.sequence + 1}-${Date.now()}`,
    worldId: snapshot.worldId,
    sequence: snapshot.sequence + 1,
    kind: 'entity.route',
    entityId,
    payload: { entityId, targetAnchorId, route: path },
    createdAt: new Date().toISOString(),
  }
}
