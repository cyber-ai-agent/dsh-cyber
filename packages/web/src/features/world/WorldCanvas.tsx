import { useEffect, useRef } from 'react'
import type {
  WorldCue,
  WorldRenderer,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldZoomCommand,
} from '@dsh-cyber/contracts'

import { createWorldRendererRegistry } from './renderer/renderer-registry.js'

interface WorldCanvasProps {
  manifest: WorldThemeManifestV1
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

export function WorldCanvas({
  manifest,
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
}: WorldCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<WorldRenderer<HTMLElement> | undefined>(undefined)
  const appliedCueIds = useRef(new Set<string>())
  const mountedKey = `${rendererIdentity}:${manifest.id}:${snapshot.sceneId}`

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const registry = createWorldRendererRegistry()
    const toViewport = (position: { x: number; y: number }) => { const rect = host.getBoundingClientRect(); return { x: rect.left + position.x, y: rect.top + position.y } }
    const renderer = registry.create(manifest.renderer, { onEntitySelect, onObjectSelect, onReady, ...(onEntityContext === undefined ? {} : { onEntityContext: (id, position) => onEntityContext(id, toViewport(position)) }), ...(onObjectContext === undefined ? {} : { onObjectContext: (id, position) => onObjectContext(id, toViewport(position)) }) })
    rendererRef.current = renderer
    let cancelled = false
    void renderer.mount(host, manifest, snapshot).catch((cause: unknown) => {
      if (!cancelled) host.dataset.error = cause instanceof Error ? cause.message : '世界画布初始化失败'
    })
    return () => {
      cancelled = true
      renderer.destroy()
      rendererRef.current = undefined
      appliedCueIds.current.clear()
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

  useEffect(() => rendererRef.current?.selectEntity(selectedEntityId), [selectedEntityId])
  useEffect(() => rendererRef.current?.selectObject(selectedObjectId), [selectedObjectId])
  useEffect(() => { if (focusEntityId !== undefined) rendererRef.current?.focusEntity(focusEntityId) }, [focusEntityId])
  useEffect(() => { if (fitRequest > 0) rendererRef.current?.fitScene() }, [fitRequest])
  useEffect(() => {
    if (zoomCommand !== undefined) rendererRef.current?.zoomBy(zoomCommand.delta)
  }, [zoomCommand?.id])

  const keyboardPosition = () => { const rect = hostRef.current?.getBoundingClientRect(); return rect === undefined ? { x: 24, y: 24 } : { x: rect.left + 48, y: rect.top + 48 } }
  return <><div ref={hostRef} className="world-canvas-host" data-theme-id={manifest.id} data-scene-id={snapshot.sceneId} aria-label="互动世界画布" onContextMenu={(event) => event.preventDefault()} />
    <div className="sr-only" aria-label="世界角色与设施快捷操作">
      {snapshot.entities.filter((entity) => entity.kind === 'agent').map((entity) => <button key={entity.id} type="button" aria-label={`${entity.displayName}世界角色`} onClick={() => onEntitySelect(entity.id)} onContextMenu={(event) => { event.preventDefault(); onEntityContext?.(entity.id, { x: event.clientX, y: event.clientY }) }} onKeyDown={(event) => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; event.preventDefault(); onEntityContext?.(entity.id, keyboardPosition()) }}>{entity.displayName}</button>)}
      {snapshot.objects.map((object) => <button key={object.id} type="button" aria-label={`${object.displayName}世界设施`} onClick={() => onObjectSelect(object.id)} onContextMenu={(event) => { event.preventDefault(); onObjectContext?.(object.id, { x: event.clientX, y: event.clientY }) }} onKeyDown={(event) => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; event.preventDefault(); onObjectContext?.(object.id, keyboardPosition()) }}>{object.displayName}</button>)}
    </div>
  </>
}
