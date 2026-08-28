import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { cyberCompanyTheme, findPath, getAnchor, getScene, maidPalaceTheme, moonlitTavernTheme } from '@dsh-cyber/world-runtime'

import { api } from '../../api.js'
import type { CyberEmployee } from '../../types.js'
import { worldExperience } from '../../world-experience.js'
import { subscribeWorldLive } from '../../world-live-client.js'
import { readWorldTheme, resolveThemeManifest } from './world-themes.js'

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
  liveEnabled?: boolean
}

function useCurrentSkin(): string | undefined {
  const [skin, setSkin] = useState<string | undefined>(() => {
    return typeof document !== 'undefined' ? document.documentElement.dataset.skin : undefined
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    const observer = new MutationObserver(() => {
      setSkin(document.documentElement.dataset.skin)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] })
    return () => observer.disconnect()
  }, [])

  return skin
}


function resolveSkinManifest(world: World, baseManifest?: WorldThemeManifestV1, currentSkin?: string): WorldThemeManifestV1 {
  const themeId = currentSkin ?? readWorldTheme(world)
  return resolveThemeManifest(world, themeId, baseManifest)
}

export function useWorldClient({ demoMode, world, employees, liveEnabled = true }: UseWorldClientInput) {
  const currentSkin = useCurrentSkin()
  const currentSkinRef = useRef(currentSkin)
  currentSkinRef.current = currentSkin
  const manifest = resolveSkinManifest(world, undefined, currentSkin)
  const [state, setState] = useState<WorldClientState>(() => ({
    manifest,
    rendererIdentity: builtInRendererIdentity(manifest),
    cues: [],
    loading: !demoMode,
    connected: demoMode,
    ...(demoMode ? { snapshot: demoSnapshot(world, employees, manifest) } : {}),
  }))

  useEffect(() => {
    const effective = resolveSkinManifest(world, undefined, currentSkin)
    setState((current) => {
      if (current.manifest.id === effective.id) return current
      return {
        ...current,
        manifest: effective,
        rendererIdentity: builtInRendererIdentity(effective),
      }
    })
  }, [currentSkin, world])

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
    if (demoMode || !liveEnabled) return
    let cancelled = false
    let initialized = false
    const onState = (event: Event) => {
      const envelope = parseEnvelope(event)
      if (envelope?.kind !== 'world-state' || envelope.worldId !== world.id) return
      setState((current) => reduceWorldStreamState(current, envelope))
    }
    const onCue = (event: Event) => {
      const envelope = parseEnvelope(event)
      if (envelope?.kind !== 'world-cue' || envelope.worldId !== world.id) return
      setState((current) => reduceWorldStreamState(current, envelope))
    }
    const onRuntime = (event: Event) => {
      const envelope = parseEnvelope(event)
      if (envelope?.kind !== 'runtime' || envelope.worldId !== world.id) return
      setState((current) => reduceWorldStreamState(current, envelope))
    }
    const recoverSnapshot = () => {
      setState((current) => ({ ...current, connected: false }))
      void api<WorldRuntimeSnapshot>(`/api/worlds/${encodeURIComponent(world.id)}/runtime-snapshot`)
        .then((snapshot) => {
          if (!cancelled) setState((current) => current.snapshot !== undefined && current.snapshot.sequence > snapshot.sequence
            ? { ...current, connected: true }
            : { ...current, snapshot, cues: [], connected: true })
        })
        .catch(() => {
          if (!cancelled) setState((current) => ({ ...current, connected: false }))
        })
    }
    const onReady = () => {
      if (initialized) recoverSnapshot()
      else setState((current) => ({ ...current, connected: true }))
    }
    const onError = () => {
      if (!cancelled) setState((current) => ({ ...current, connected: false }))
    }
    const unsubscribeState = subscribeWorldLive(world.id, 'world-state', onState)
    const unsubscribeCue = subscribeWorldLive(world.id, 'world-cue', onCue)
    const unsubscribeRuntime = subscribeWorldLive(world.id, 'world-runtime', onRuntime)
    const unsubscribeReady = subscribeWorldLive(world.id, 'ready', onReady)
    const unsubscribeError = subscribeWorldLive(world.id, 'error', onError)
    void Promise.all([
      api<WorldRuntimeSnapshot>(`/api/worlds/${encodeURIComponent(world.id)}/runtime-snapshot`),
      api<WorldThemeManifestV1>(`/api/worlds/${encodeURIComponent(world.id)}/theme-manifest`),
      api<{ items: WorldThemeOption[] }>(`/api/worlds/${encodeURIComponent(world.id)}/themes`),
    ]).then(([snapshot, nextManifest, themes]) => {
      if (cancelled) return
      const activeTheme = themes.items.find((item) => item.active)
      // The HTTP response can arrive after the user has changed skins. Resolve
      // against the latest document skin so an old server manifest cannot
      // overwrite the newly selected shared scene.
      const effectiveManifest = resolveSkinManifest(world, nextManifest, currentSkinRef.current)
      setState((current) => ({
        ...current,
        snapshot: current.snapshot !== undefined && current.snapshot.sequence > snapshot.sequence ? current.snapshot : snapshot,
        manifest: effectiveManifest,
        rendererIdentity: activeTheme === undefined || effectiveManifest.id === maidPalaceTheme.id
          ? builtInRendererIdentity(effectiveManifest)
          : rendererIdentity(activeTheme),
        loading: false,
        connected: true,
      }))
      initialized = true
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
      unsubscribeState()
      unsubscribeCue()
      unsubscribeRuntime()
      unsubscribeReady()
      unsubscribeError()
    }
  }, [demoMode, liveEnabled, world.id])

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
  if (envelope.kind === 'runtime') {
    const cue = runtimeCue(envelope)
    return cue === undefined
      ? { ...current, connected: true }
      : { ...current, cues: appendCue(current.cues, cue), connected: true }
  }
  return current
}

function runtimeCue(envelope: WorldRuntimeStreamEnvelope): WorldCue | undefined {
  const agentId = jsonString(envelope.payload, 'agentId')
  const runtimeKind = jsonString(envelope.payload, 'runtimeKind')
  if (agentId === undefined || runtimeKind === undefined) return undefined

  let text: string | undefined
  if (runtimeKind === 'turn.started') text = '正在思考…'
  if (runtimeKind === 'tool.started') {
    const toolName = jsonString(envelope.payload, 'toolName')
    text = toolName === undefined ? '正在使用工具…' : `正在使用 ${toolName}…`
  }
  if (runtimeKind === 'assistant.message') text = jsonString(envelope.payload, 'content')
  if (runtimeKind === 'turn.failed') text = '遇到问题，正在等待处理。'
  if (text === undefined || !text.trim()) return undefined

  return {
    id: `${envelope.id}:speech`,
    worldId: envelope.worldId,
    sequence: envelope.sequence,
    kind: 'entity.speech',
    entityId: agentId,
    payload: {
      text: text.trim().replace(/\s+/g, ' ').slice(0, 120),
      sessionId: jsonString(envelope.payload, 'sessionId') ?? '',
      runtimeKind,
    },
    createdAt: envelope.createdAt,
  }
}

function jsonString(value: WorldRuntimeStreamEnvelope['payload'], key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.trim() ? field.trim() : undefined
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
    activity: employee.health === 'blocked' ? 'blocked' : employee.presence === 'working' ? 'working' : 'idle',
    activityLabel: employee.currentActivity,
    status: employee.status === 'archived' ? 'archived' : employee.health === 'blocked' ? 'blocked' : employee.presence,
    ...(employee.authorityRole === undefined ? {} : { authorityRole: employee.authorityRole }),
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
