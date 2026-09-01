import { useEffect, useRef } from 'react'
import type {
  RendererRegistry,
  WorldCue,
  WorldRenderer,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldZoomCommand,
} from '@dsh-cyber/contracts'

import { createWorldRendererRegistry } from './renderer/renderer-registry.js'
import { WorldLocomotion, WorldLocomotionClock } from './runtime/world-locomotion.js'
import type { WorldCameraMode } from './runtime/world-view-mode.js'

interface WorldCanvasProps {
  manifest: WorldThemeManifestV1
  locomotion?: WorldLocomotion
  cameraMode?: WorldCameraMode
  cameraSubjectId?: string
  rendererRegistry?: RendererRegistry<HTMLElement>
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
}

/**
 * Core world canvas.
 *
 * It deliberately owns only the lightweight Pixi renderer. Three, VRM,
 * spatial capability probing, Avatar Base Pack discovery and 3D camera state
 * live in the optional spatial extension and are never imported by this path.
 */
export function WorldCanvas({
  manifest,
  locomotion,
  cameraMode,
  cameraSubjectId,
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
  rendererRegistry,
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
  const retainedZoom = useRef<number>()
  const worldKey = `${manifest.id}:${snapshot.sceneId}`
  const mountedKey = `${rendererIdentity}:pixi-2d:${worldKey}`

  useEffect(() => { appliedCueIds.current.clear() }, [worldKey])

  // The simulation clock is core world state. Optional renderers only observe
  // this shared locomotion store; they never start a second clock.
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
    const registry = rendererRegistry ?? createWorldRendererRegistry({ locomotion: sharedLocomotion })
    const toViewport = (position: { x: number; y: number }) => {
      const rect = host.getBoundingClientRect()
      return { x: rect.left + position.x, y: rect.top + position.y }
    }
    const renderer = registry.create('pixi-2d', {
      onEntitySelect,
      onObjectSelect,
      onReady,
      ...(onEntityContext === undefined ? {} : { onEntityContext: (id, position) => onEntityContext(id, toViewport(position)) }),
      ...(onObjectContext === undefined ? {} : { onObjectContext: (id, position) => onObjectContext(id, toViewport(position)) }),
    })
    rendererRef.current = renderer
    rendererMounted.current = false
    let cancelled = false
    void renderer.mount(host, manifest, snapshot).then(() => {
      if (cancelled) return
      rendererMounted.current = true
      const selection = latestSelection.current
      renderer.selectEntity(selection.entityId)
      renderer.selectObject(selection.objectId)
      if (retainedZoom.current !== undefined && retainedZoom.current !== renderer.getZoom()) {
        renderer.zoomBy(retainedZoom.current - renderer.getZoom())
      }
      if (selection.focusEntityId !== undefined) renderer.focusEntity(selection.focusEntityId)
      const camera = renderer as { setCameraMode?: (mode: WorldCameraMode, subjectId?: string) => void }
      if (latestCameraState.current.mode !== undefined) {
        camera.setCameraMode?.(latestCameraState.current.mode, latestCameraState.current.subjectId)
      }
    }).catch((cause: unknown) => {
      if (!cancelled) host.dataset.error = cause instanceof Error ? cause.message : '世界画布初始化失败'
    })
    return () => {
      cancelled = true
      rendererMounted.current = false
      retainedZoom.current = renderer.getZoom()
      renderer.destroy()
      rendererRef.current = undefined
    }
  }, [mountedKey, rendererRegistry, sharedLocomotion])

  useEffect(() => { rendererRef.current?.updateSnapshot(snapshot) }, [snapshot])

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
    if (focusEntityId !== undefined && rendererMounted.current) rendererRef.current?.focusEntity(focusEntityId)
  }, [focusEntityId])
  useEffect(() => { if (fitRequest > 0) rendererRef.current?.fitScene() }, [fitRequest])
  useEffect(() => {
    if (zoomCommand !== undefined) rendererRef.current?.zoomBy(zoomCommand.delta)
  }, [zoomCommand?.id])

  const keyboardPosition = () => {
    const rect = hostRef.current?.getBoundingClientRect()
    return rect === undefined ? { x: 24, y: 24 } : { x: rect.left + 48, y: rect.top + 48 }
  }

  return <>
    <div ref={hostRef} className="world-canvas-host" data-theme-id={manifest.id} data-scene-id={snapshot.sceneId} data-renderer-kind="pixi-2d" aria-label="互动世界画布" onContextMenu={(event) => event.preventDefault()} />
    <div className="sr-only" aria-label="世界角色与设施快捷操作">
      {snapshot.entities.filter((entity) => entity.kind === 'agent').map((entity) => <button key={entity.id} type="button" aria-label={`${entity.displayName}世界角色`} onClick={() => onEntitySelect(entity.id)} onContextMenu={(event) => { event.preventDefault(); onEntityContext?.(entity.id, { x: event.clientX, y: event.clientY }) }} onKeyDown={(event) => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; event.preventDefault(); onEntityContext?.(entity.id, keyboardPosition()) }}>{entity.displayName}</button>)}
      {snapshot.objects.map((object) => <button key={object.id} type="button" aria-label={`${object.displayName}世界设施`} onClick={() => onObjectSelect(object.id)} onContextMenu={(event) => { event.preventDefault(); onObjectContext?.(object.id, { x: event.clientX, y: event.clientY }) }} onKeyDown={(event) => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; event.preventDefault(); onObjectContext?.(object.id, keyboardPosition()) }}>{object.displayName}</button>)}
    </div>
  </>
}
