import * as THREE from 'three'

import type {
  WorldCue,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRuntimeEntityState,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldThemeSceneManifest,
} from '@dsh-cyber/contracts'

import { WorldLocomotion } from '../../runtime/world-locomotion.js'
import type { WorldCameraMode } from '../../runtime/world-view-mode.js'
import {
  facingToSceneRotation,
  headingBetween,
  approachHeading,
  worldPointToScene,
} from '../../coordinates/world-to-three.js'
import {
  approachPose,
  poseFor,
  type CameraPose,
} from '../../camera/world-camera-controller.js'
import { planWorldLayout, type SceneLayout, type ScenePlacement, type SceneZone } from './three-world-layout.js'
import { capabilitiesFor, lodFor, stableLod, updateIntervalMs, type AvatarLod } from './three-world-lod.js'
import { LowPolyActor } from './low-poly-actor.js'
import type { VrmActor } from '../../avatar/vrm/VrmActor.js'
import { motionCueForState, visualStateForEntity } from '../../digital-human-motion.js'

/**
 * The world, in three dimensions, from the same runtime the 2D world uses.
 *
 * This is a renderer, not a world: it owns no positions, no schedule and no
 * behaviour. Characters stand where `WorldLocomotion` says they stand, walk the
 * routes the runtime hands out as cues, and do what their snapshot activity
 * says they are doing. Everything visual here is downstream of that, which is
 * what makes switching between 2D and 3D a change of view rather than a change
 * of place.
 *
 * It holds the only WebGL context the world needs. Focusing a character moves
 * this camera; it never builds a second canvas.
 */

const CLEAR_COLOUR = 0x0d1017
const FLOOR_COLOUR = 0x1b212b
const FOV = 45

interface ActorView {
  root: THREE.Group
  actor: LowPolyActor
  /** Present once this character's own avatar has arrived and replaced the stand-in. */
  vrm: VrmActor | undefined
  /** Guards against starting the same download twice. */
  avatarUrl: string | undefined
  lod: AvatarLod
  sinceUpdate: number
  entity: WorldRuntimeEntityState
}

export interface ThreeWorldRendererOptions {
  locomotion?: WorldLocomotion
  /** Ceiling imposed by the device tier. */
  lodCeiling?: AvatarLod
  /** Shadows cost real time on integrated GPUs. */
  shadows?: boolean
  pixelRatio?: number
  /**
   * This character's published avatar, if it has one.
   *
   * Called as characters appear and as they publish new ones, so a user who
   * creates a 3D form sees their character change in place rather than being
   * sent back to a loading screen.
   */
  resolveAvatarUrl?: (entityId: string) => string | undefined
}

export class ThreeWorldRenderer implements WorldRenderer<HTMLElement> {
  readonly kind = 'three-3d' as const

  readonly #callbacks: WorldRendererCallbacks
  readonly #locomotion: WorldLocomotion
  readonly #options: ThreeWorldRendererOptions

  #host: HTMLElement | undefined
  #renderer: THREE.WebGLRenderer | undefined
  #scene: THREE.Scene | undefined
  #camera: THREE.PerspectiveCamera | undefined
  #layout: SceneLayout | undefined
  #sceneManifest: WorldThemeSceneManifest | undefined
  #snapshot: WorldRuntimeSnapshot | undefined
  #resizeObserver: ResizeObserver | undefined
  #frame = 0
  #lastFrameAt = 0
  #destroyed = false

  readonly #actors = new Map<string, ActorView>()
  readonly #objectMeshes = new Map<string, THREE.Object3D>()
  readonly #pickables: THREE.Object3D[] = []
  readonly #disposables: Array<{ dispose(): void }> = []
  readonly #appliedCueIds = new Set<string>()

  #selectedEntityId: string | undefined
  #selectedObjectId: string | undefined
  #cameraMode: WorldCameraMode = 'overview'
  #cameraSubjectId: string | undefined
  #pose: CameraPose | undefined
  #zoom = 1
  #selectionRing: THREE.Mesh | undefined

  constructor(callbacks: WorldRendererCallbacks, options: ThreeWorldRendererOptions = {}) {
    this.#callbacks = callbacks
    this.#options = options
    this.#locomotion = options.locomotion ?? new WorldLocomotion()
  }

  async mount(host: HTMLElement, manifest: WorldThemeManifestV1, snapshot: WorldRuntimeSnapshot): Promise<void> {
    const startedAt = performance.now()
    this.#destroyed = false
    this.#host = host
    const sceneManifest = manifest.scenes.find((item) => item.id === snapshot.sceneId) ?? manifest.scenes[0]
    if (sceneManifest === undefined) throw new Error('世界主题没有可用场景')
    this.#sceneManifest = sceneManifest
    this.#layout = planWorldLayout(sceneManifest)

    const renderer = new THREE.WebGLRenderer({ antialias: this.#options.shadows !== false, alpha: false })
    renderer.setPixelRatio(Math.min(this.#options.pixelRatio ?? globalThis.devicePixelRatio ?? 1, 2))
    renderer.setClearColor(CLEAR_COLOUR, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    if (this.#options.shadows !== false) {
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
    }
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    host.appendChild(renderer.domElement)
    this.#renderer = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(CLEAR_COLOUR)
    // Fog keeps the far wall from reading as a hard edge without pretending
    // the office is outdoors.
    scene.fog = new THREE.Fog(CLEAR_COLOUR, this.#layout.floor.depth * 0.9, this.#layout.floor.depth * 2.4)
    this.#scene = scene

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400)
    this.#camera = camera

    this.#buildLighting(scene)
    this.#buildRoom(scene, this.#layout)

    this.#resize()
    this.#resizeObserver = new ResizeObserver(() => this.#resize())
    this.#resizeObserver.observe(host)
    host.addEventListener('pointerdown', this.#onPointerDown)
    host.addEventListener('contextmenu', this.#onContextMenu)

    this.updateSnapshot(snapshot)
    this.#pose = this.#targetPose()
    this.#applyPose(this.#pose)
    this.#lastFrameAt = performance.now()
    renderer.setAnimationLoop(() => this.#tick())

    this.#callbacks.onReady?.({
      initializationMs: Math.round(performance.now() - startedAt),
      assetBytesEstimate: 0,
    })
  }

  updateSnapshot(snapshot: WorldRuntimeSnapshot): void {
    if (this.#snapshot !== undefined && snapshot.sequence < this.#snapshot.sequence) return
    this.#snapshot = snapshot
    this.#locomotion.syncSnapshot(snapshot)
    const scene = this.#scene
    const layout = this.#layout
    if (scene === undefined || layout === undefined) return

    const present = new Set<string>()
    for (const entity of snapshot.entities) {
      if (entity.kind !== 'agent') continue
      present.add(entity.id)
      const existing = this.#actors.get(entity.id)
      if (existing === undefined) {
        this.#createActor(scene, entity)
        continue
      }
      existing.entity = entity
      existing.actor.setLabel(entity.displayName, entity.activityLabel)
      this.#adoptAvatar(existing)
    }
    for (const [id, view] of this.#actors) {
      if (present.has(id)) continue
      this.#removeActor(scene, id, view)
    }

    for (const object of snapshot.objects) {
      const mesh = this.#objectMeshes.get(object.id)
      if (mesh === undefined) continue
      const material = (mesh as THREE.Mesh).material
      if (material instanceof THREE.MeshStandardMaterial) {
        material.emissiveIntensity = object.state === 'active' ? 0.55 : 0.08
      }
    }
    this.#applySelectionRing()
  }

  applyCues(cues: WorldCue[]): void {
    for (const cue of cues) {
      if (this.#appliedCueIds.has(cue.id)) continue
      this.#appliedCueIds.add(cue.id)
      if (cue.kind === 'entity.route' && cue.entityId !== undefined) {
        const points = cuePoints(cue)
        // The runtime owns the path; the shared store owns the walk. The 3D
        // world neither plans routes nor keeps its own copy of where anyone is.
        if (points.length > 1) this.#locomotion.beginRoute(cue.entityId, points)
      }
      if (cue.kind === 'entity.focus' && cue.entityId !== undefined) this.focusEntity(cue.entityId)
      if (cue.kind === 'entity.speech' && cue.entityId !== undefined) {
        this.#actors.get(cue.entityId)?.actor.say(cueText(cue))
      }
    }
    if (this.#appliedCueIds.size > 512) {
      const excess = this.#appliedCueIds.size - 512
      let removed = 0
      for (const id of this.#appliedCueIds) {
        this.#appliedCueIds.delete(id)
        removed += 1
        if (removed >= excess) break
      }
    }
  }

  selectEntity(entityId?: string): void {
    this.#selectedEntityId = entityId
    this.#applySelectionRing()
  }

  selectObject(objectId?: string): void {
    this.#selectedObjectId = objectId
    for (const [id, mesh] of this.#objectMeshes) {
      const material = (mesh as THREE.Mesh).material
      if (material instanceof THREE.MeshStandardMaterial) {
        material.emissive.setHex(id === objectId ? 0x3c6ea5 : 0x101720)
      }
    }
  }

  focusEntity(entityId: string): void {
    this.#cameraSubjectId = entityId
    if (this.#cameraMode === 'overview') this.#cameraMode = 'focus'
  }

  /** Camera modes are this renderer's own vocabulary, beyond the shared interface. */
  setCameraMode(mode: WorldCameraMode, subjectId?: string): void {
    this.#cameraMode = mode
    if (subjectId !== undefined) this.#cameraSubjectId = subjectId
    if (mode === 'overview') this.#cameraSubjectId = undefined
  }

  fitScene(): void {
    this.#cameraMode = 'overview'
    this.#cameraSubjectId = undefined
    this.#zoom = 1
  }

  zoomBy(delta: number): void {
    this.#zoom = clamp(this.#zoom + delta, 0.55, 2.2)
  }

  getZoom(): number {
    return this.#zoom
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#renderer?.setAnimationLoop(null)
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = undefined
    this.#host?.removeEventListener('pointerdown', this.#onPointerDown)
    this.#host?.removeEventListener('contextmenu', this.#onContextMenu)
    for (const [, view] of this.#actors) { view.vrm?.dispose(); view.actor.dispose() }
    this.#actors.clear()
    this.#objectMeshes.clear()
    this.#pickables.length = 0
    for (const disposable of this.#disposables) disposable.dispose()
    this.#disposables.length = 0
    this.#scene?.clear()
    this.#scene = undefined
    const renderer = this.#renderer
    if (renderer !== undefined) {
      renderer.domElement.remove()
      // Browsers cap live WebGL contexts; leaking one per swap would take the
      // world down after a handful of switches.
      renderer.forceContextLoss()
      renderer.dispose()
    }
    this.#renderer = undefined
    this.#camera = undefined
    this.#host = undefined
    this.#appliedCueIds.clear()
  }

  #buildLighting(scene: THREE.Scene): void {
    const hemisphere = new THREE.HemisphereLight(0xbcd2f0, 0x1b2330, 1.05)
    scene.add(hemisphere)
    const key = new THREE.DirectionalLight(0xfff4e2, 1.35)
    key.position.set(6, 12, 8)
    if (this.#options.shadows !== false) {
      key.castShadow = true
      key.shadow.mapSize.set(1024, 1024)
      key.shadow.camera.near = 1
      key.shadow.camera.far = 60
      const extent = Math.max(this.#layout?.floor.width ?? 20, this.#layout?.floor.depth ?? 20)
      key.shadow.camera.left = -extent / 2
      key.shadow.camera.right = extent / 2
      key.shadow.camera.top = extent / 2
      key.shadow.camera.bottom = -extent / 2
    }
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.35)
    fill.position.set(-8, 6, -6)
    scene.add(fill)
  }

  #buildRoom(scene: THREE.Scene, layout: SceneLayout): void {
    const floorGeometry = new THREE.PlaneGeometry(layout.floor.width, layout.floor.depth)
    const floorMaterial = new THREE.MeshStandardMaterial({ color: FLOOR_COLOUR, roughness: 0.94, metalness: 0.02 })
    const floor = new THREE.Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = this.#options.shadows !== false
    scene.add(floor)
    this.#disposables.push(floorGeometry, floorMaterial)

    for (const zone of layout.zones) this.#buildZone(scene, zone)
    for (const placement of layout.placements) this.#buildPlacement(scene, placement)

    const ringGeometry = new THREE.RingGeometry(0.42, 0.52, 40)
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x6fa8ff, transparent: true, opacity: 0.75, side: THREE.DoubleSide })
    const ring = new THREE.Mesh(ringGeometry, ringMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.visible = false
    scene.add(ring)
    this.#selectionRing = ring
    this.#disposables.push(ringGeometry, ringMaterial)
  }

  #buildZone(scene: THREE.Scene, zone: SceneZone): void {
    const geometry = new THREE.PlaneGeometry(zone.width, zone.depth)
    const material = new THREE.MeshStandardMaterial({
      color: ZONE_COLOURS[zone.kind],
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.34,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(zone.centre.x, 0.004, zone.centre.z)
    mesh.receiveShadow = false
    scene.add(mesh)
    this.#disposables.push(geometry, material)
  }

  #buildPlacement(scene: THREE.Scene, placement: ScenePlacement): void {
    const geometry = new THREE.BoxGeometry(placement.width, placement.height, placement.depth)
    const material = new THREE.MeshStandardMaterial({
      color: PROP_COLOURS[placement.kind] ?? 0x2a3340,
      roughness: 0.72,
      metalness: 0.06,
      emissive: new THREE.Color(0x101720),
      emissiveIntensity: 0.08,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(placement.centre.x, placement.height / 2, placement.centre.z)
    mesh.rotation.y = placement.rotation
    mesh.castShadow = this.#options.shadows !== false && placement.kind !== 'rug'
    mesh.receiveShadow = true
    scene.add(mesh)
    this.#disposables.push(geometry, material)
    if (placement.objectId !== undefined) {
      mesh.userData.objectId = placement.objectId
      this.#objectMeshes.set(placement.objectId, mesh)
      this.#pickables.push(mesh)
    }
  }

  #createActor(scene: THREE.Scene, entity: WorldRuntimeEntityState): void {
    const actor = new LowPolyActor({ shadows: this.#options.shadows !== false })
    actor.setLabel(entity.displayName, entity.activityLabel)
    actor.root.userData.entityId = entity.id
    scene.add(actor.root)
    this.#pickables.push(actor.picker)
    this.#actors.set(entity.id, { root: actor.root, actor, vrm: undefined, avatarUrl: undefined, lod: 'full', sinceUpdate: 0, entity })
    const view = this.#actors.get(entity.id)!
    this.#placeActor(view, entity)
    this.#adoptAvatar(view)
  }

  /**
   * Replaces the stand-in with the character's own avatar, in place.
   *
   * Publishing an avatar while the world is open should change the character,
   * not the page: no reload, no leaving the office, and no second canvas. The
   * stand-in stays visible until the model is actually ready, so a slow
   * download is a character that has not changed yet rather than a hole in the
   * room.
   */
  #adoptAvatar(view: ActorView): void {
    const url = this.#options.resolveAvatarUrl?.(view.entity.id)
    if (url === undefined || url === view.avatarUrl) return
    view.avatarUrl = url
    void (async () => {
      try {
        const { VrmActor } = await import('../../avatar/vrm/VrmActor.js')
        const actor = await VrmActor.load({ assetUrl: url })
        if (this.#destroyed || this.#actors.get(view.entity.id) !== view || view.avatarUrl !== url) {
          actor.dispose()
          return
        }
        await actor.loadDeclaredMotion()
        view.vrm?.dispose()
        view.vrm = actor
        view.root.add(actor.root)
        view.actor.setDetail({ face: false, secondaryMotion: false, skinned: false, shadow: false })
        view.actor.hideStandIn()
      } catch {
        // An avatar that will not load leaves the character standing there.
        // Emptying its desk would be a worse answer than a plain figure.
        view.avatarUrl = undefined
      }
    })()
  }

  #removeActor(scene: THREE.Scene, id: string, view: ActorView): void {
    scene.remove(view.root)
    const index = this.#pickables.indexOf(view.actor.picker)
    if (index >= 0) this.#pickables.splice(index, 1)
    view.vrm?.dispose()
    view.actor.dispose()
    this.#actors.delete(id)
  }

  #placeActor(view: ActorView, entity: WorldRuntimeEntityState): void {
    const live = this.#locomotion.stateOf(entity.id)
    const point = worldPointToScene(live?.position ?? entity.position, this.#floorRect())
    view.root.position.set(point.x, 0, point.z)
    view.root.rotation.y = facingToSceneRotation(live?.facing ?? entity.facing)
  }

  #tick(): void {
    const renderer = this.#renderer
    const scene = this.#scene
    const camera = this.#camera
    if (renderer === undefined || scene === undefined || camera === undefined) return
    const now = performance.now()
    const deltaMs = Math.min(now - this.#lastFrameAt, 250)
    this.#lastFrameAt = now
    this.#frame += 1

    this.#locomotion.advance(deltaMs)

    const floor = this.#floorRect()
    for (const view of this.#actors.values()) {
      const live = this.#locomotion.stateOf(view.entity.id)
      const previous = view.root.position.clone()
      if (live !== undefined) {
        const point = worldPointToScene(live.position, floor)
        view.root.position.set(point.x, 0, point.z)
        if (live.walking) {
          const heading = headingBetween(
            { x: previous.x, y: previous.z },
            { x: view.root.position.x, y: view.root.position.z },
          )
          view.root.rotation.y = approachHeading(view.root.rotation.y, heading, 0.25)
        } else {
          view.root.rotation.y = approachHeading(view.root.rotation.y, facingToSceneRotation(live.facing), 0.18)
        }
      }
      const distance = camera.position.distanceTo(view.root.position)
      const next = stableLod(view.lod, lodFor({
        distance,
        selected: view.entity.id === this.#selectedEntityId,
        speaking: view.entity.activity === 'talking',
        ...(this.#options.lodCeiling === undefined ? {} : { ceiling: this.#options.lodCeiling }),
      }), distance)
      if (next !== view.lod) {
        view.lod = next
        view.actor.setDetail(capabilitiesFor(next))
      }
      view.sinceUpdate += deltaMs
      const interval = updateIntervalMs(view.lod)
      if (view.sinceUpdate >= interval) {
        const activity = this.#locomotion.isWalking(view.entity.id) ? 'walking' : view.entity.activity
        view.actor.update(view.sinceUpdate, activity)
        if (view.vrm !== undefined) {
          const state = visualStateForEntity(view.entity, true, false)
          view.vrm.update(view.sinceUpdate, {
            state,
            motionCue: motionCueForState(state),
            speaking: view.entity.activity === 'talking',
            animated: true,
            detail: capabilitiesFor(view.lod),
          })
        }
        view.sinceUpdate = 0
      }
    }

    this.#applySelectionRing()
    const target = this.#targetPose()
    this.#pose = this.#pose === undefined ? target : approachPose(this.#pose, target, 0.92, deltaMs)
    this.#applyPose(this.#pose)
    renderer.render(scene, camera)
  }

  #targetPose(): CameraPose {
    const layout = this.#layout
    const camera = this.#camera
    const aspect = camera?.aspect ?? 1
    const framing = {
      width: (layout?.floor.width ?? 20) / this.#zoom,
      depth: (layout?.floor.depth ?? 20) / this.#zoom,
      aspect,
      fov: (FOV * Math.PI) / 180,
    }
    const subjectId = this.#cameraSubjectId ?? this.#selectedEntityId
    const view = subjectId === undefined ? undefined : this.#actors.get(subjectId)
    if (view === undefined) return poseFor({ mode: 'overview', overview: framing })
    return poseFor({
      mode: this.#cameraMode,
      overview: framing,
      subject: {
        position: { x: view.root.position.x, y: 0, z: view.root.position.z },
        heading: view.root.rotation.y,
      },
    })
  }

  #applyPose(pose: CameraPose): void {
    const camera = this.#camera
    if (camera === undefined) return
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
  }

  #applySelectionRing(): void {
    const ring = this.#selectionRing
    if (ring === undefined) return
    const view = this.#selectedEntityId === undefined ? undefined : this.#actors.get(this.#selectedEntityId)
    if (view === undefined) {
      ring.visible = false
      return
    }
    ring.visible = true
    ring.position.set(view.root.position.x, 0.02, view.root.position.z)
  }

  #floorRect() {
    const scene = this.#sceneManifest
    return scene === undefined
      ? { x: 0, y: 0, width: 0, height: 0 }
      : { x: 0, y: 0, width: scene.size.width, height: scene.size.height }
  }

  #resize(): void {
    const host = this.#host
    const renderer = this.#renderer
    const camera = this.#camera
    if (host === undefined || renderer === undefined || camera === undefined) return
    const width = Math.max(host.clientWidth, 1)
    const height = Math.max(host.clientHeight, 1)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const hit = this.#pick(event)
    if (hit === undefined) return
    if (hit.entityId !== undefined) this.#callbacks.onEntitySelect(hit.entityId)
    else if (hit.objectId !== undefined) this.#callbacks.onObjectSelect(hit.objectId)
  }

  readonly #onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    const hit = this.#pick(event)
    if (hit === undefined) return
    const host = this.#host
    const rect = host?.getBoundingClientRect()
    const position = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
    if (hit.entityId !== undefined) this.#callbacks.onEntityContext?.(hit.entityId, position)
    else if (hit.objectId !== undefined) this.#callbacks.onObjectContext?.(hit.objectId, position)
  }

  /**
   * What is under the pointer.
   *
   * Three only answers "which mesh"; the ids it carries are the runtime's own,
   * so a click lands in exactly the selection contract the 2D world uses.
   */
  #pick(event: MouseEvent): { entityId?: string; objectId?: string } | undefined {
    const host = this.#host
    const camera = this.#camera
    if (host === undefined || camera === undefined) return undefined
    const rect = host.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(pointer, camera)
    for (const intersection of raycaster.intersectObjects(this.#pickables, true)) {
      const entityId = findUserData(intersection.object, 'entityId')
      if (entityId !== undefined) return { entityId }
      const objectId = findUserData(intersection.object, 'objectId')
      if (objectId !== undefined) return { objectId }
    }
    return undefined
  }
}

const ZONE_COLOURS: Record<SceneZone['kind'], number> = {
  work: 0x1f2a37,
  meeting: 0x24303f,
  rest: 0x232b33,
  growth: 0x27303d,
  reception: 0x222c38,
}

const PROP_COLOURS: Partial<Record<ScenePlacement['kind'], number>> = {
  desk: 0x36414f,
  seat: 0x2b3440,
  'meeting-table': 0x3c4857,
  board: 0x2f3a48,
  partition: 0x28313c,
  rug: 0x202832,
}

function findUserData(object: THREE.Object3D, key: string): string | undefined {
  let current: THREE.Object3D | null = object
  while (current !== null) {
    const value = current.userData[key]
    if (typeof value === 'string') return value
    current = current.parent
  }
  return undefined
}

function cuePoints(cue: WorldCue): Array<{ x: number; y: number }> {
  const route = cue.payload['route']
  if (!Array.isArray(route)) return []
  return route.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const point = item as { x?: unknown; y?: unknown }
    return typeof point.x === 'number' && typeof point.y === 'number' ? [{ x: point.x, y: point.y }] : []
  })
}

function cueText(cue: WorldCue): string {
  const value = cue.payload['text'] ?? cue.payload['label']
  return typeof value === 'string' ? value : ''
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
