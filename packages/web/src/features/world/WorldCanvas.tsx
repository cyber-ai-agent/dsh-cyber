import { useEffect, useMemo, useRef } from 'react'
import type {
  RendererKind,
  WorldCue,
  WorldRenderer,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldZoomCommand,
} from '@dsh-cyber/contracts'

import { createWorldRendererRegistry } from './renderer/renderer-registry.js'
import { WorldLocomotion } from './runtime/world-locomotion.js'
import { detectRenderingQuality, supportsSpatialRendering } from './avatar/renderer/RenderingQuality.js'
import type { WorldCameraMode } from './runtime/world-view-mode.js'

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
  /** This character's published avatar, so the world can adopt it in place. */
  resolveAvatarUrl?: (entityId: string) => string | undefined
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
}: WorldCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<WorldRenderer<HTMLElement> | undefined>(undefined)
  const appliedCueIds = useRef(new Set<string>())
  const fallbackLocomotion = useRef<WorldLocomotion | undefined>(undefined)
  // Held in a ref, not closed over at mount: the renderer is built once and
  // asks again on every snapshot, so a resolver captured at mount would keep
  // answering with the character list from the moment the world opened — and
  // an avatar published while the world is open would never be adopted.
  const resolveAvatarUrlRef = useRef(resolveAvatarUrl)
  resolveAvatarUrlRef.current = resolveAvatarUrl
  // Zoom lives inside the renderer, so it is the one piece of camera state that
  // a swap would otherwise lose. Selection is held above this component and is
  // simply re-applied.
  const retainedZoom = useRef<number | undefined>(undefined)
  // A device that cannot run 3D must not download it to find that out. The
  // degradation ladder ends at the 2D world, and the last rung has to be
  // reachable without fetching the chunk it is meant to avoid.
  //
  // Probed once: reading the GPU string means creating a WebGL context, and
  // doing that in the render body made one per render. `prefers-reduced-motion`
  // is deliberately not a veto here — wanting less movement is not the same as
  // having no GPU, and it reaches the renderer as the lowest tier instead.
  const capability = useMemo(() => ({
    spatial: supportsSpatialRendering(),
    quality: detectRenderingQuality(false),
  }), [])
  const requestedKind = rendererKind ?? manifest.renderer
  const activeKind = requestedKind === 'three-3d' && !capability.spatial ? 'pixi-2d' : requestedKind
  const worldKey = `${manifest.id}:${snapshot.sceneId}`
  const mountedKey = `${rendererIdentity}:${activeKind}:${worldKey}`

  // Cue de-duplication belongs to the world, not to whoever is drawing it.
  // Clearing it on a renderer swap replayed every retained cue, restarting
  // walks that had already finished.
  useEffect(() => { appliedCueIds.current.clear() }, [worldKey])
  useEffect(() => { onRendererResolved?.(activeKind) }, [activeKind])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    fallbackLocomotion.current ??= new WorldLocomotion()
    // The device tier decides how much of a character the world may run, and
    // whether it may afford shadows at all. Deciding it here keeps the policy
    // in one place rather than inside the renderer.
    // Reduced motion still reaches the renderer — as the lowest tier, which
    // strips shadows and secondary motion — rather than as a refusal to draw.
    const quality = capability.quality
    const registry = createWorldRendererRegistry({
      locomotion: locomotion ?? fallbackLocomotion.current,
      lodCeiling: quality === 'high' ? 'full' : quality === 'balanced' ? 'reduced' : 'billboard',
      shadows: quality === 'high',
      pixelRatio: quality === 'high' ? 2 : quality === 'balanced' ? 1.5 : 1,
      resolveAvatarUrl: (entityId: string) => resolveAvatarUrlRef.current?.(entityId),
    })
    const toViewport = (position: { x: number; y: number }) => { const rect = host.getBoundingClientRect(); return { x: rect.left + position.x, y: rect.top + position.y } }
    const renderer = registry.create(activeKind, { onEntitySelect, onObjectSelect, onReady, ...(onEntityContext === undefined ? {} : { onEntityContext: (id, position) => onEntityContext(id, toViewport(position)) }), ...(onObjectContext === undefined ? {} : { onObjectContext: (id, position) => onObjectContext(id, toViewport(position)) }) })
    rendererRef.current = renderer
    let cancelled = false
    void renderer.mount(host, manifest, snapshot).then(() => {
      if (cancelled) return
      // The world the user was looking at has to still be the world they are
      // looking at: a swap that lost the selection and the zoom would read as
      // having been thrown out of the room and back in.
      renderer.selectEntity(selectedEntityId)
      renderer.selectObject(selectedObjectId)
      const zoom = retainedZoom.current
      if (zoom !== undefined && zoom !== renderer.getZoom()) renderer.zoomBy(zoom - renderer.getZoom())
      if (focusEntityId !== undefined) renderer.focusEntity(focusEntityId)
      const spatial = renderer as { setCameraMode?: (mode: WorldCameraMode, subjectId?: string) => void }
      if (cameraMode !== undefined) spatial.setCameraMode?.(cameraMode, cameraSubjectId)
    }).catch((cause: unknown) => {
      if (!cancelled) host.dataset.error = cause instanceof Error ? cause.message : '世界画布初始化失败'
    })
    return () => {
      cancelled = true
      retainedZoom.current = renderer.getZoom()
      renderer.destroy()
      rendererRef.current = undefined
    }
  }, [mountedKey])

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
  useEffect(() => { if (focusEntityId !== undefined) rendererRef.current?.focusEntity(focusEntityId) }, [focusEntityId])
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
