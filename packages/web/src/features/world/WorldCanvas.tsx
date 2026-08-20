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
  fitRequest: number
  zoomCommand?: WorldZoomCommand
  onEntitySelect(entityId: string): void
  onObjectSelect(objectId: string): void
  onReady(metrics: { initializationMs: number; assetBytesEstimate: number }): void
}

export function WorldCanvas({
  manifest,
  rendererIdentity,
  snapshot,
  cues,
  selectedEntityId,
  selectedObjectId,
  fitRequest,
  zoomCommand,
  onEntitySelect,
  onObjectSelect,
  onReady,
}: WorldCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<WorldRenderer<HTMLElement> | undefined>(undefined)
  const appliedCueIds = useRef(new Set<string>())
  const mountedKey = `${rendererIdentity}:${snapshot.sceneId}`

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const registry = createWorldRendererRegistry()
    const renderer = registry.create(manifest.renderer, { onEntitySelect, onObjectSelect, onReady })
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
  useEffect(() => { if (fitRequest > 0) rendererRef.current?.fitScene() }, [fitRequest])
  useEffect(() => {
    if (zoomCommand !== undefined) rendererRef.current?.zoomBy(zoomCommand.delta)
  }, [zoomCommand?.id])

  return <div ref={hostRef} className="world-canvas-host" aria-label="互动世界画布" />
}
