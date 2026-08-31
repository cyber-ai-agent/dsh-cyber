import { useEffect, useMemo, useRef } from 'react'
import type {
  RendererRegistry,
  RendererKind,
  WorldCue,
  WorldRenderer,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldZoomCommand,
} from '@dsh-cyber/contracts'

import { createWorldRendererRegistry } from './renderer/renderer-registry.js'
import { WorldLocomotion, WorldLocomotionClock } from './runtime/world-locomotion.js'
import { browserSpatialCapabilityProvider, type SpatialCapabilityProvider } from './avatar/renderer/RenderingQuality.js'
import type { WorldCameraMode } from './runtime/world-view-mode.js'
import { resolveCharacterAvatarRepresentation, type ResolvedAvatarRepresentation } from './avatar/avatar-representation.js'
import { loadRendererAvatar, rendererAvatarUrl } from './avatar/avatar-representation-loader.js'

interface WorldCanvasProps {
  manifest: WorldThemeManifestV1
  /**
   * How to draw this world.
   *
   * The theme still declares the renderer it was authored for, but drawing is
   * a property of the view rather than of the world: the same company can be
   * looked at in 2D or 3D without becoming a different place. Defaults to the
   * manifest so a caller that has no opinion keeps the old behaviour.
   */
  rendererKind?: RendererKind
  /** Shared so a renderer swap does not restart everybody's walk. */
  locomotion?: WorldLocomotion
  /**
   * Where the camera looks. Renderers that only draw the whole world ignore it.
   *
   * Focusing a character is a camera move, not a different screen, so it
   * arrives here rather than replacing this component with another one.
   */
  cameraMode?: WorldCameraMode
  cameraSubjectId?: string
  /** Legacy employee-specific published avatar resolver. */
  resolveAvatarUrl?: (entityId: string) => string | undefined
  /**
   * Full representation resolver. A published avatar still wins, but when one
   * does not exist this may return an identity-safe shared Base Pack assembly.
   */
  resolveAvatarRepresentation?: (entityId: string) => ResolvedAvatarRepresentation | undefined
  /** Injectable renderer registry for real renderer integration tests. */
  rendererRegistry?: RendererRegistry<HTMLElement>
  /** Injectable capability policy; production defaults to browser detection. */
  spatialCapabilityProvider?: SpatialCapabilityProvider
  rendererIdentity: string
  snapshot: WorldRuntimeSnapshot
  cues: WorldCue[]
  selectedEntityId?: string
  selectedObjectId?: string
  focusEntityId?: string
  fitRequest: number
  zoomCommand?: WorldZoomCommand
  onEntitySelect(entityId: string): void
  onObjectSelect(objectId: string): void
  onEntityContext?(entityId: string, position: { x: number; y: number }): void
  onObjectContext?(objectId: string, position: { x: number; y: number }): void
  onReady(metrics: { initializationMs: number; assetBytesEstimate: number }): void
  /**
   * The renderer that actually ran.
   *
   * Not always the one that was asked for: a device without a GPU is degraded
   * to the 2D world. Callers that change their own layout for 3D have to know
   * which one they got, or a degraded world ends up with a panel that dropped
   * its avatar stage for a 3D scene that never appeared.
   */
  onRendererResolved?(kind: RendererKind): void
}

export function WorldCanvas({
  manifest,
  rendererKind,
  locomotion,
  cameraMode,
  cameraSubjectId,
  resolveAvatarUrl,
  resolveAvatarRepresentation,
  rendererIdentity,
  snapshot,
  cues,
  selectedEntityId,
  selectedObjectId,
  focusEntityId,
  fitRequest,
  zoomCommand,
  onEntitySelect,
  onObjectSelect,
  onEntityContext,
  onObjectContext,
  onReady,
  onRendererResolved,
  rendererRegistry,
  spatialCapabilityProvider = browserSpatialCapabilityProvider,
}: WorldCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<WorldRenderer<HTMLElement> | undefined>(undefined)
  const rendererMounted = useRef(false)
  const appliedCueIds = useRef(new Set<string>())
  const fallbackLocomotion = useRef<WorldLocomotion | undefined>(undefined)
  const sharedLocomotion = locomotion ?? (fallbackLocomotion.current ??= new WorldLocomotion())
  const latestCameraState = useRef<{ mode: WorldCameraMode | undefined; subjectId: string | undefined }>({ mode: cameraMode, subjectId: cameraSubjectId })
  latestCameraState.current = { mode: cameraMode, subjectId: cameraSubjectId }
  const latestSelection = useRef<{ entityId: string | undefined; objectId: string | undefined; focusEntityId: string | undefined }>({ entityId: selectedEntityId, objectId: selectedObjectId, focusEntityId })
  latestSelection.current = { entityId: selectedEntityId, objectId: selectedObjectId, focusEntityId }
  const latestSnapshot = useRef(snapshot)
  latestSnapshot.current = snapshot
  // Held in refs, not closed over at mount: the renderer is built once and
  // asks again on every snapshot, so a published avatar or installed pack can
  // hot-swap while the world stays mounted.
  const resolveAvatarUrlRef = useRef(resolveAvatarUrl)
  resolveAvatarUrlRef.current = resolveAvatarUrl
  const resolveAvatarRepresentationRef = useRef(resolveAvatarRepresentation)
  resolveAvatarRepresentationRef.current = resolveAvatarRepresentation
  // Zoom is renderer-local state. A Pixi stage scale of 1.8 and a Three camera
  // zoom of 1.8 are not the same semantic value: replaying one into the other
  // is what made a 3D follow camera jump almost inside a character after a 2D
  // zoom. Remember each renderer's zoom independently and restore it only when
  // returning to that renderer.
  const retainedZoomByKind = useRef<Partial<Record<RendererKind, number>>>({})
  // A device that cannot run 3D must not download it to find that out. The
  // degradation ladder ends at the 2D world, and the last rung has to be
  // reachable without fetching the chunk it is meant to avoid.
  //
  // Probed once: reading the GPU string means creating a WebGL context, and
  // doing that in the render body made one per render. `prefers-reduced-motion`
  // is deliberately not a veto here — wanting less movement is not the same as
  // having no GPU, and it reaches the renderer as the lowest tier instead.
  const capability = useMemo(() => ({
    spatial: spatialCapabilityProvider.supportsSpatialRendering(),
    quality: spatialCapabilityProvider.quality(false),
  }), [spatialCapabilityProvider])
  const requestedKind = rendererKind ?? manifest.renderer
  const activeKind = requestedKind === 'three-3d' && !capability.spatial ? 'pixi-2d' : requestedKind
  const worldKey = `${manifest.id}:${snapshot.sceneId}`
  const mountedKey = `${rendererIdentity}:${activeKind}:${worldKey}`

  // Cue de-duplication belongs to the world, not to whoever is drawing it.
  // Clearing it on a renderer swap replayed every retained cue, restarting
  // walks that had already finished.
  useEffect(() => { appliedCueIds.current.clear() }, [worldKey])
  useEffect(() => { onRendererResolved?.(activeKind) }, [activeKind])

  // The simulation clock belongs to the world, not to a renderer. It keeps
  // advancing while the 3D chunk is loading or a canvas is being replaced, so
  // renderer swaps cannot freeze an in-flight walk. A wall-clock delta also
  // catches up after a hidden tab resumes without double-advancing frames.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
    const clock = new WorldLocomotionClock(sharedLocomotion)
    let frame = 0
    const tick = (now: number) => {
      clock.tick(now)
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [sharedLocomotion])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    // The device tier decides how much of a character the world may run, and
    // whether it may afford shadows at all. Deciding it here keeps the policy
    // in one place rather than inside the renderer.
    // Reduced motion still reaches the renderer — as the lowest tier, which
    // strips shadows and secondary motion — rather than as a refusal to draw.
    const quality = capability.quality
    const representationResolver = (entityId: string): ResolvedAvatarRepresentation | undefined => {
      const supplied = resolveAvatarRepresentationRef.current?.(entityId)
      if (supplied !== undefined) return supplied
      const entity = latestSnapshot.current.entities.find((candidate) => candidate.id === entityId)
      const rosterIndex = entity?.visualState['rosterIndex']
      const publishedAvatarUrl = resolveAvatarUrlRef.current?.(entityId)
      // This baseline is intentionally conservative: the snapshot knows the
      // same built-in portrait index as Pixi, which is enough to protect hair,
      // outfit and palette identity. A richer Profile resolver may override it.
      if (entity === undefined && publishedAvatarUrl === undefined) return undefined
      return resolveCharacterAvatarRepresentation({
        employeeId: entityId,
        ...(typeof rosterIndex === 'number' && Number.isFinite(rosterIndex) ? { fallbackAvatarIndex: Math.max(0, Math.floor(rosterIndex)) } : {}),
        ...(publishedAvatarUrl === undefined ? {} : { publishedAvatarUrl }),
      })
    }
    const registry = rendererRegistry ?? createWorldRendererRegistry({
      locomotion: sharedLocomotion,
      lodCeiling: quality === 'high' ? 'full' : quality === 'balanced' ? 'reduced' : 'billboard',
      shadows: quality === 'high',
      pixelRatio: quality === 'high' ? 2 : quality === 'balanced' ? 1.5 : 1,
      resolveAvatarUrl: (entityId: string) => {
        const representation = representationResolver(entityId)
        return representation === undefined
          ? resolveAvatarUrlRef.current?.(entityId)
          : rendererAvatarUrl(entityId, representation)
      },
      // The loader stays lazy. Published URLs follow the old path, while an
      // internal pack key resolves to Base VRM bytes + an assembly plan only
      // after ThreeWorldRenderer actually asks for that actor.
      loadAvatar: (rendererUrl, signal) => loadRendererAvatar(rendererUrl, representationResolver, signal),
    })
    const toViewport = (position: { x: number; y: number }) => { const rect = host.getBoundingClientRect(); return { x: rect.left + position.x, y: rect.top + position.y } }
    const renderer = registry.create(activeKind, { onEntitySelect, onObjectSelect, onReady, ...(onEntityContext === undefined ? {} : { onEntityContext: (id, position) => onEntityContext(id, toViewport(position)) }), ...(onObjectContext === undefined ? {} : { onObjectContext: (id, position) => onObjectContext(id, toViewport(position)) }) })
    rendererRef.current = renderer
    rendererMounted.current = false
    let cancelled = false
    void renderer.mount(host, manifest, snapshot).then(() => {
      if (cancelled) return
      rendererMounted.current = true
      // The world the user was looking at has to still be the world they are
      // looking at: a swap that lost the selection and the renderer's own zoom
      // would read as having been thrown out of the room and back in.
      const latestSelectionState = latestSelection.current
      renderer.selectEntity(latestSelectionState.entityId)
      renderer.selectObject(latestSelectionState.objectId)
      const zoom = retainedZoomByKind.current[activeKind]
      if (zoom !== undefined && zoom !== renderer.getZoom()) renderer.zoomBy(zoom - renderer.getZoom())
      if (latestSelectionState.focusEntityId !== undefined) renderer.focusEntity(latestSelectionState.focusEntityId)
      const spatial = renderer as { setCameraMode?: (mode: WorldCameraMode, subjectId?: string) => void }
      const latestCamera = latestCameraState.current
      if (latestCamera.mode !== undefined) spatial.setCameraMode?.(latestCamera.mode, latestCamera.subjectId)
    }).catch((cause: unknown) => {
      if (!cancelled) host.dataset.error = cause instanceof Error ? cause.message : '世界画布初始化失败'
    })
    return () => {
      cancelled = true
      rendererMounted.current = false
      retainedZoomByKind.current[activeKind] = renderer.getZoom()
      renderer.destroy()
      rendererRef.current = undefined
    }
  }, [mountedKey, rendererRegistry, sharedLocomotion])

  useEffect(() => {
    rendererRef.current?.updateSnapshot(snapshot)
  }, [snapshot])

  useEffect(() => {
    const fresh = cues.filter((cue) => !appliedCueIds.current.has(cue.id))
    for (const cue of fresh) appliedCueIds.current.add(cue.id)
    if (fresh.length > 0) rendererRef.current?.applyCues(fresh)
  }, [cues])

  useEffect(() => {
    if (cameraMode === undefined) return
    const renderer = rendererRef.current as { setCameraMode?: (mode: WorldCameraMode, subjectId?: string) => void } | undefined
    renderer?.setCameraMode?.(cameraMode, cameraSubjectId)
  }, [cameraMode, cameraSubjectId, mountedKey])

  useEffect(() => rendererRef.current?.selectEntity(selectedEntityId), [selectedEntityId])
  useEffect(() => rendererRef.current?.selectObject(selectedObjectId), [selectedObjectId])
  useEffect(() => {
    // `focusEntityId` is a one-shot command. Do not queue an old command in a
    // lazy renderer: if the user leaves focus before the chunk resolves, the
    // stale command must not replay after the current camera state wins.
    if (focusEntityId !== undefined && rendererMounted.current) rendererRef.current?.focusEntity(focusEntityId)
  }, [focusEntityId])
  useEffect(() => { if (fitRequest > 0) rendererRef.current?.fitScene() }, [fitRequest])
  useEffect(() => {
    if (zoomCommand !== undefined) rendererRef.current?.zoomBy(zoomCommand.delta)
  }, [zoomCommand?.id])

  const keyboardPosition = () => { const rect = hostRef.current?.getBoundingClientRect(); return rect === undefined ? { x: 24, y: 24 } : { x: rect.left + 48, y: rect.top + 48 } }
  return <><div ref={hostRef} className="world-canvas-host" data-theme-id={manifest.id} data-scene-id={snapshot.sceneId} data-renderer-kind={activeKind} aria-label="互动世界画布" onContextMenu={(event) => event.preventDefault()} />
    <div className="sr-only" aria-label="世界角色与设施快捷操作">
      {snapshot.entities.filter((entity) => entity.kind === 'agent').map((entity) => <button key={entity.id} type="button" aria-label={`${entity.displayName}世界角色`} onClick={() => onEntitySelect(entity.id)} onContextMenu={(event) => { event.preventDefault(); onEntityContext?.(entity.id, { x: event.clientX, y: event.clientY }) }} onKeyDown={(event) => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; event.preventDefault(); onEntityContext?.(entity.id, keyboardPosition()) }}>{entity.displayName}</button>)}
      {snapshot.objects.map((object) => <button key={object.id} type="button" aria-label={`${object.displayName}世界设施`} onClick={() => onObjectSelect(object.id)} onContextMenu={(event) => { event.preventDefault(); onObjectContext?.(object.id, { x: event.clientX, y: event.clientY }) }} onKeyDown={(event) => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; event.preventDefault(); onObjectContext?.(object.id, keyboardPosition()) }}>{object.displayName}</button>)}
    </div>
  </>
}
