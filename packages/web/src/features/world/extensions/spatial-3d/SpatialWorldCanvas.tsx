import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorldCue,
  WorldRenderer,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldZoomCommand,
} from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../../../types.js'
import { loadWorldAvatarBasePacks } from '../../avatar/avatar-base-pack-client.js'
import type { AvatarBasePackManifest } from '../../avatar/avatar-base-pack.js'
import { resolveCharacterAvatarRepresentation, type ResolvedAvatarRepresentation } from '../../avatar/avatar-representation.js'
import { loadRendererAvatar, rendererAvatarUrl } from '../../avatar/avatar-representation-loader.js'
import { browserSpatialCapabilityProvider } from '../../avatar/renderer/RenderingQuality.js'
import type { WorldCameraMode } from '../../runtime/world-view-mode.js'
import type { WorldLocomotion } from '../../runtime/world-locomotion.js'

/**
 * Type-only view of the registry module. `typeof import(...)` is erased, so it
 * describes the shape without creating a static edge to the 3D renderer.
 */
type SpatialRendererRegistryModule = typeof import('./spatial-renderer-registry.js')

interface SpatialWorldCanvasProps {
  manifest: WorldThemeManifestV1
  locomotion: WorldLocomotion
  rendererIdentity: string
  snapshot: WorldRuntimeSnapshot
  cues: WorldCue[]
  employees: CyberEmployee[]
  cameraMode: WorldCameraMode
  cameraSubjectId?: string
  selectedEntityId?: string
  selectedObjectId?: string
  fitRequest: number
  zoomCommand?: WorldZoomCommand
  onEntitySelect(entityId: string): void
  onObjectSelect(objectId: string): void
}

/**
 * Canvas owned only by the optional 3D extension.
 *
 * The core map remains mounted and owns locomotion time. This surface observes
 * the same snapshot/store but never starts another world clock or replays route
 * cues into it.
 */
export function SpatialWorldCanvas({
  manifest,
  locomotion,
  rendererIdentity,
  snapshot,
  cues,
  employees,
  cameraMode,
  cameraSubjectId,
  selectedEntityId,
  selectedObjectId,
  fitRequest,
  zoomCommand,
  onEntitySelect,
  onObjectSelect,
}: SpatialWorldCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<WorldRenderer<HTMLElement> | undefined>(undefined)
  const appliedCueIds = useRef(new Set<string>())
  const avatarBasePacksRef = useRef<AvatarBasePackManifest[]>([])
  const latestManifest = useRef(manifest)
  latestManifest.current = manifest
  const latestSnapshot = useRef(snapshot)
  latestSnapshot.current = snapshot
  const latestCamera = useRef({ mode: cameraMode, subjectId: cameraSubjectId })
  latestCamera.current = { mode: cameraMode, subjectId: cameraSubjectId }
  const latestSelection = useRef({ entityId: selectedEntityId, objectId: selectedObjectId })
  latestSelection.current = { entityId: selectedEntityId, objectId: selectedObjectId }
  const retainedZoom = useRef<number | undefined>(undefined)
  const employeesRef = useRef(employees)
  employeesRef.current = employees
  const callbacksRef = useRef({ onEntitySelect, onObjectSelect })
  callbacksRef.current = { onEntitySelect, onObjectSelect }

  const capability = useMemo(() => ({
    spatial: browserSpatialCapabilityProvider.supportsSpatialRendering(),
    quality: browserSpatialCapabilityProvider.quality(false),
  }), [])
  const [registryModule, setRegistryModule] = useState<SpatialRendererRegistryModule>()
  const worldKey = `${manifest.id}:${snapshot.sceneId}`
  const mountedKey = `${rendererIdentity}:spatial-extension:${worldKey}`

  useEffect(() => { appliedCueIds.current.clear() }, [worldKey])

  useEffect(() => {
    // The registry statically reaches the lazy Three shell, so a device that
    // can never construct a 3D renderer must not fetch it just by opening this
    // dialog. The real three/three-vrm chunk stays behind `mount`, as before.
    if (!capability.spatial) return
    let cancelled = false
    void import('./spatial-renderer-registry.js').then((module) => {
      if (!cancelled) setRegistryModule(module)
    }).catch((cause: unknown) => {
      if (cancelled) return
      const host = hostRef.current
      if (host !== null) host.dataset.error = cause instanceof Error ? cause.message : '3D 扩展初始化失败'
    })
    return () => { cancelled = true }
  }, [capability.spatial])

  useEffect(() => {
    avatarBasePacksRef.current = []
    if (!capability.spatial) return
    let cancelled = false
    void loadWorldAvatarBasePacks(snapshot.worldId).then((packs) => {
      if (cancelled || latestSnapshot.current.worldId !== snapshot.worldId) return
      avatarBasePacksRef.current = packs
      rendererRef.current?.updateSnapshot(latestSnapshot.current)
    }).catch(() => {
      if (!cancelled) avatarBasePacksRef.current = []
    })
    return () => { cancelled = true }
  }, [capability.spatial, snapshot.worldId])

  useEffect(() => {
    if (!capability.spatial || registryModule === undefined) return
    const host = hostRef.current
    if (host === null) return
    const quality = capability.quality
    const representationResolver = (entityId: string): ResolvedAvatarRepresentation | undefined => {
      const employee = employeesRef.current.find((candidate) => candidate.id === entityId)
      const entity = latestSnapshot.current.entities.find((candidate) => candidate.id === entityId)
      if (employee === undefined && entity === undefined) return undefined
      return resolveCharacterAvatarRepresentation({
        employeeId: entityId,
        ...(employee === undefined ? {} : { fallbackAvatarIndex: employee.avatarIndex }),
        ...(employee?.avatarAssetUrl === undefined ? {} : { publishedAvatarUrl: employee.avatarAssetUrl }),
      }, avatarBasePacksRef.current)
    }
    const registry = registryModule.createSpatialRendererRegistry({
      locomotion,
      lodCeiling: quality === 'high' ? 'full' : quality === 'balanced' ? 'reduced' : 'billboard',
      shadows: quality === 'high',
      pixelRatio: quality === 'high' ? 2 : quality === 'balanced' ? 1.5 : 1,
      resolveAvatarUrl: (entityId) => {
        const representation = representationResolver(entityId)
        return representation === undefined ? undefined : rendererAvatarUrl(entityId, representation)
      },
      loadAvatar: (rendererUrl, signal) => loadRendererAvatar(rendererUrl, representationResolver, signal),
    })
    const renderer = registry.create('three-3d', {
      onEntitySelect: (entityId) => callbacksRef.current.onEntitySelect(entityId),
      onObjectSelect: (objectId) => callbacksRef.current.onObjectSelect(objectId),
    })
    rendererRef.current = renderer
    let cancelled = false
    const mountedManifest = latestManifest.current
    const mountedSnapshot = latestSnapshot.current
    void renderer.mount(host, mountedManifest, mountedSnapshot).then(() => {
      if (cancelled) return
      const selection = latestSelection.current
      renderer.selectEntity(selection.entityId)
      renderer.selectObject(selection.objectId)
      if (retainedZoom.current !== undefined && retainedZoom.current !== renderer.getZoom()) {
        renderer.zoomBy(retainedZoom.current - renderer.getZoom())
      }
      const spatial = renderer as { setCameraMode?: (mode: WorldCameraMode, subjectId?: string) => void }
      spatial.setCameraMode?.(latestCamera.current.mode, latestCamera.current.subjectId)
      // Snapshot may have advanced during the lazy Three chunk load.
      if (latestSnapshot.current.sequence !== mountedSnapshot.sequence) renderer.updateSnapshot(latestSnapshot.current)
    }).catch((cause: unknown) => {
      if (!cancelled) host.dataset.error = cause instanceof Error ? cause.message : '3D 扩展初始化失败'
    })
    return () => {
      cancelled = true
      retainedZoom.current = renderer.getZoom()
      renderer.destroy()
      rendererRef.current = undefined
    }
  }, [capability.quality, capability.spatial, locomotion, mountedKey, registryModule])

  useEffect(() => { rendererRef.current?.updateSnapshot(snapshot) }, [snapshot])
  useEffect(() => {
    // Core Pixi renderer already applied route cues to the shared locomotion
    // store. Replaying them here would restart characters when opening 3D.
    // Nothing is marked applied before the renderer exists, so cues that arrive
    // while the registry chunk is still loading are delivered, not dropped.
    const renderer = rendererRef.current
    if (renderer === undefined) return
    const fresh = cues.filter((cue) => cue.kind !== 'entity.route' && !appliedCueIds.current.has(cue.id))
    for (const cue of fresh) appliedCueIds.current.add(cue.id)
    if (fresh.length > 0) renderer.applyCues(fresh)
  }, [cues, registryModule])
  useEffect(() => {
    const renderer = rendererRef.current as { setCameraMode?: (mode: WorldCameraMode, subjectId?: string) => void } | undefined
    renderer?.setCameraMode?.(cameraMode, cameraSubjectId)
  }, [cameraMode, cameraSubjectId, mountedKey])
  useEffect(() => rendererRef.current?.selectEntity(selectedEntityId), [selectedEntityId])
  useEffect(() => rendererRef.current?.selectObject(selectedObjectId), [selectedObjectId])
  // Camera controls pressed while the registry chunk is in flight stay live:
  // the lazy renderer used to buffer them, so replay once it exists.
  useEffect(() => { if (fitRequest > 0) rendererRef.current?.fitScene() }, [fitRequest, registryModule])
  useEffect(() => { if (zoomCommand !== undefined) rendererRef.current?.zoomBy(zoomCommand.delta) }, [zoomCommand?.id, registryModule])

  if (!capability.spatial) {
    return <div className="spatial-world-extension__unavailable" role="status"><strong>当前设备未启用 3D 空间</strong><span>核心平面地图和 2D 视图不受影响。</span></div>
  }

  return <div ref={hostRef} className="spatial-world-extension__canvas" data-renderer-kind="three-3d" aria-label="可选 3D 空间扩展" />
}
