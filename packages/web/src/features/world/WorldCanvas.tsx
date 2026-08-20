import { useEffect, useRef } from 'react'
import type { WorldCue, WorldRuntimeSnapshot, WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import { PixiWorldRenderer } from './renderer/pixi-world-renderer.js'

interface WorldCanvasProps {
  manifest: WorldThemeManifestV1
  snapshot: WorldRuntimeSnapshot
  cues: WorldCue[]
  selectedEntityId?: string
  selectedObjectId?: string
  fitRequest: number
  zoomRequest: number
  onEntitySelect(entityId: string): void
  onObjectSelect(objectId: string): void
  onReady(metrics: { initializationMs: number; assetBytesEstimate: number }): void
}

export function WorldCanvas({
  manifest,
  snapshot,
  cues,
  selectedEntityId,
  selectedObjectId,
  fitRequest,
  zoomRequest,
  onEntitySelect,
  onObjectSelect,
  onReady,
}: WorldCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<PixiWorldRenderer | undefined>(undefined)
  const appliedCueIds = useRef(new Set<string>())
  const mountedKey = `${manifest.id}:${manifest.version}:${snapshot.sceneId}`

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const renderer = new PixiWorldRenderer({ onEntitySelect, onObjectSelect, onReady })
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
  useEffect(() => { if (zoomRequest !== 0) rendererRef.current?.zoomBy(zoomRequest) }, [zoomRequest])

  return <div ref={hostRef} className="world-canvas-host" aria-label="互动世界画布" />
}
