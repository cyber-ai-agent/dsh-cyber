import {
  Application,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  type FederatedPointerEvent,
} from 'pixi.js'
import 'pixi.js/unsafe-eval'
import type {
  WorldCue,
  WorldPoint,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRuntimeEntityState,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldThemeSceneManifest,
} from '@dsh-cyber/contracts'

import { ActorAnimationController } from './actor-animation-controller.js'
import { WorldLocomotion, facingBetween } from '../runtime/world-locomotion.js'

interface ActorView {
  root: Container
  animation: ActorAnimationController
  selection: Graphics
  status: Graphics
  name: Text
  activity: Text
  state: WorldRuntimeEntityState
}

interface GrowthMarkerView {
  root: Container
  count: Text
}

const WORLD_MIN_ZOOM = 0.55
const WORLD_MAX_ZOOM = 2.2

export class PixiWorldRenderer implements WorldRenderer<HTMLElement> {
  readonly kind = 'pixi-2d' as const
  readonly #callbacks: WorldRendererCallbacks
  readonly #app = new Application()
  readonly #camera = new Container()
  readonly #sceneRoot = new Container()
  readonly #interactionLayer = new Container()
  readonly #effectsLayer = new Container()
  readonly #actors = new Map<string, ActorView>()
  readonly #objectHints = new Map<string, Graphics>()
  readonly #growthMarkers = new Map<string, GrowthMarkerView>()
  readonly #actorBubbles = new Map<string, Container>()
  readonly #assetTextures = new Map<string, Texture>()
  readonly #layerTextures = new Set<Texture>()
  readonly #appliedCueIds = new Set<string>()
  readonly #lastCueSequence = new Map<string, number>()
  #manifest?: WorldThemeManifestV1
  #scene?: WorldThemeSceneManifest
  #snapshot?: WorldRuntimeSnapshot
  #host?: HTMLElement
  #selectedEntityId: string | undefined
  #selectedObjectId: string | undefined
  #fitScale = 1
  #zoom = 1
  #cameraOffset = { x: 0, y: 0 }
  #drag: { x: number; y: number; offsetX: number; offsetY: number } | undefined
  #darkness?: Graphics
  #resizeObserver: ResizeObserver | undefined
  #initialized = false
  #destroyed = false
  #sharedScene = false
  #wheelListener: ((event: WheelEvent) => void) | undefined

  readonly #locomotion: WorldLocomotion

  /**
   * The walk lives outside the renderer.
   *
   * A character's on-screen position during a walk is not in the snapshot —
   * the server leaves `entity.position` at the origin until a later event
   * settles it — so whoever owns the interpolation owns the truth. Sharing one
   * store with the other renderer is what lets the world survive being redrawn
   * by a different one mid-stride.
   */
  constructor(callbacks: WorldRendererCallbacks, locomotion?: WorldLocomotion) {
    this.#callbacks = callbacks
    this.#locomotion = locomotion ?? new WorldLocomotion()
  }

  async mount(host: HTMLElement, manifest: WorldThemeManifestV1, snapshot: WorldRuntimeSnapshot): Promise<void> {
    const startedAt = performance.now()
    this.#destroyed = false
    this.#host = host
    this.#sharedScene = host.classList.contains('world-canvas-host--shared-scene')
    this.#manifest = manifest
    const scene = manifest.scenes.find((candidate) => candidate.id === snapshot.sceneId) ?? manifest.scenes[0]
    if (scene === undefined) throw new Error(`主题 ${manifest.id} 没有可用场景`)
    this.#scene = scene
    await this.#app.init({
      resizeTo: host,
      backgroundColor: 0x05080b,
      // The shell owns one continuous scene image spanning the chat and
      // World panes. Keep the Pixi surface transparent there and draw only
      // actors, cues, and interaction hit areas on top of it.
      backgroundAlpha: this.#sharedScene ? 0 : 1,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: 'webgl',
    })
    if (this.#destroyed) {
      this.#app.destroy(true, { children: true, texture: false, textureSource: false })
      return
    }
    this.#initialized = true
    this.#app.canvas.className = 'world-runtime-canvas'
    this.#app.canvas.setAttribute('aria-hidden', 'true')
    host.appendChild(this.#app.canvas)
    this.#camera.sortableChildren = true
    this.#sceneRoot.sortableChildren = true
    this.#sceneRoot.addChild(this.#interactionLayer, this.#effectsLayer)
    this.#camera.addChild(this.#sceneRoot)
    this.#app.stage.addChild(this.#camera)
    await this.#loadAssets(manifest)
    this.#buildScene()
    this.updateSnapshot(snapshot)
    this.#resizeViewport()
    this.#wireCamera()
    this.#app.ticker.add((ticker) => this.#tick(ticker.deltaMS))
    this.#resizeObserver = new ResizeObserver(() => this.#resizeViewport())
    this.#resizeObserver.observe(host)
    this.#callbacks.onReady?.({
      initializationMs: Math.round(performance.now() - startedAt),
      assetBytesEstimate: manifest.assets.length * 1_500_000,
    })
  }

  updateSnapshot(snapshot: WorldRuntimeSnapshot): void {
    if (this.#snapshot !== undefined && snapshot.sequence < this.#snapshot.sequence) return
    this.#snapshot = snapshot
    this.#locomotion.syncSnapshot(snapshot)
    if (!this.#scene || !this.#manifest) return
    const actorAssetId = this.#manifest.actorSets[0]?.assetId
    if (actorAssetId === undefined || !this.#assetTextures.has(actorAssetId)) return
    const activeIds = new Set(snapshot.entities.filter((entity) => entity.kind === 'agent').map((entity) => entity.id))
    for (const [entityId, actor] of this.#actors) {
      if (activeIds.has(entityId)) continue
      this.#removeBubble(entityId)
      actor.animation.destroy()
      actor.root.destroy({ children: true })
      this.#actors.delete(entityId)
    }
    for (const entity of snapshot.entities) {
      if (entity.kind !== 'agent') continue
      const actor = this.#actors.get(entity.id) ?? this.#createActor(entity)
      const previousRosterIndex = actor.state.visualState['rosterIndex']
      const nextRosterIndex = entity.visualState['rosterIndex']
      if (previousRosterIndex !== nextRosterIndex && !this.#locomotion.isWalking(entity.id)) {
        actor.animation.destroy()
        actor.root.destroy({ children: true })
        this.#actors.delete(entity.id)
        const replacement = this.#createActor(entity)
        replacement.root.position.set(entity.position.x, entity.position.y)
        replacement.root.zIndex = 600 + replacement.root.y
        continue
      }
      actor.state = entity
      // A character mid-walk is drawn where the shared store says it is: the
      // snapshot still reports the place the walk started from, and adopting
      // that on every streamed token would drag it backwards.
      const live = this.#locomotion.stateOf(entity.id)
      if (live !== undefined) {
        actor.root.position.set(live.position.x, live.position.y)
        if (live.walking) actor.state = { ...entity, facing: live.facing, activity: 'walking' }
      } else {
        actor.root.position.set(entity.position.x, entity.position.y)
      }
      actor.root.zIndex = 600 + actor.root.y
      actor.name.text = entity.authorityRole === 'administrator' ? `${entity.displayName}  ♛` : entity.displayName
      actor.activity.text = entity.activityLabel
      actor.selection.visible = entity.id === this.#selectedEntityId
      actor.activity.visible = entity.id === this.#selectedEntityId
      actor.status.clear().circle(-43, -112, 4).fill({ color: statusColor(entity), alpha: 1 })
      actor.root.label = entity.displayName
      this.#applyAnimation(actor)
    }
    for (const object of snapshot.objects) {
      const hint = this.#objectHints.get(object.id)
      if (hint !== undefined) hint.alpha = object.state === 'active' ? 0.34 : 0.001
    }
    this.#updateGrowth(snapshot)
    this.#setLights(snapshot.clock.lightsOn)
  }

  applyCues(cues: WorldCue[]): void {
    for (const cue of cues) {
      if (this.#appliedCueIds.has(cue.id) || cue.sequence < (this.#snapshot?.sequence ?? 0)) continue
      const channel = `${cue.kind}:${cue.entityId ?? cue.objectId ?? 'world'}`
      const previousSequence = this.#lastCueSequence.get(channel) ?? -1
      if (cue.sequence < previousSequence) continue
      this.#appliedCueIds.add(cue.id)
      this.#lastCueSequence.set(channel, cue.sequence)
      const actor = cue.entityId === undefined ? undefined : this.#actors.get(cue.entityId)
      if (cue.kind === 'entity.route' && actor !== undefined) {
        const semanticRoute = cuePoints(cue)
        const route = semanticRoute.length < 2 ? semanticRoute : [{ x: actor.root.x, y: actor.root.y }, ...semanticRoute.slice(1)]
        if (route.length > 1) {
          this.#locomotion.beginRoute(actor.state.id, route)
          actor.state = { ...actor.state, activity: 'walking', facing: facingBetween(route[0]!, route[1]!) }
          this.#applyAnimation(actor)
        }
      }
      if (cue.kind === 'entity.focus' && actor !== undefined) this.focusEntity(actor.state.id)
      if (cue.kind === 'entity.speech' && actor !== undefined) this.#showBubble(actor, cueText(cue) || actor.state.activityLabel)
      if (cue.kind === 'growth.unlocked' && actor !== undefined) this.#showBubble(actor, '解锁了一项成长记录')
    }
  }

  selectEntity(entityId?: string): void {
    this.#selectedEntityId = entityId
    this.#selectedObjectId = undefined
    for (const [id, actor] of this.#actors) {
      actor.selection.visible = id === entityId
      actor.activity.visible = id === entityId
    }
    if (entityId !== undefined) this.focusEntity(entityId)
  }

  selectObject(objectId?: string): void {
    this.#selectedObjectId = objectId
    for (const [id, hint] of this.#objectHints) hint.alpha = id === objectId ? 0.58 : 0.001
  }

  focusEntity(entityId: string): void {
    const actor = this.#actors.get(entityId)
    if (actor === undefined || !this.#host) return
    const nextZoom = Math.max(this.#zoom, 1.25, this.#minimumZoomForCoverage())
    const scale = this.#fitScale * nextZoom
    this.#zoom = nextZoom
    this.#cameraOffset = {
      x: this.#host.clientWidth / 2 - actor.root.x * scale,
      y: this.#host.clientHeight / 2 - actor.root.y * scale,
    }
    this.#applyCamera()
  }

  fitScene(): void {
    this.fillScene()
  }

  fillScene(): void {
    if (!this.#scene || !this.#host || !this.#initialized) return
    const availableWidth = Math.max(this.#host.clientWidth, 1)
    const availableHeight = Math.max(this.#host.clientHeight, 1)
    const containScale = Math.min(availableWidth / this.#scene.size.width, availableHeight / this.#scene.size.height)
    this.#fitScale = containScale
    this.#zoom = this.#minimumZoomForCoverage()
    const scale = this.#fitScale * this.#zoom
    this.#cameraOffset = {
      x: (availableWidth - this.#scene.size.width * scale) / 2,
      y: (availableHeight - this.#scene.size.height * scale) / 2,
    }
    this.#applyCamera()
  }

  #resizeViewport(): void {
    if (!this.#host || !this.#initialized) return
    const width = Math.max(1, Math.round(this.#host.clientWidth))
    const height = Math.max(1, Math.round(this.#host.clientHeight))
    // Pixi's resizeTo plugin follows window resize events. The world pane can
    // also change size when navigation panels move without resizing the
    // browser, so keep the renderer buffer and interaction hit area in sync
    // with the observed host before recalculating the cover camera.
    if (this.#app.screen.width !== width || this.#app.screen.height !== height) {
      this.#app.renderer.resize(width, height)
    }
    this.#app.stage.hitArea = this.#app.screen
    this.fillScene()
  }

  zoomBy(delta: number): void {
    const coverageZoom = this.#minimumZoomForCoverage()
    this.#zoom = clamp(this.#zoom + delta, coverageZoom, Math.max(WORLD_MAX_ZOOM, coverageZoom))
    this.#applyCamera()
  }

  getZoom(): number {
    return this.#zoom
  }

  destroy(): void {
    this.#destroyed = true
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = undefined
    if (this.#host !== undefined && this.#wheelListener !== undefined) this.#host.removeEventListener('wheel', this.#wheelListener)
    this.#wheelListener = undefined
    for (const actor of this.#actors.values()) actor.animation.destroy()
    this.#actors.clear()
    this.#objectHints.clear()
    for (const marker of this.#growthMarkers.values()) marker.root.destroy({ children: true })
    this.#growthMarkers.clear()
    for (const bubble of this.#actorBubbles.values()) bubble.destroy({ children: true })
    this.#actorBubbles.clear()
    this.#appliedCueIds.clear()
    this.#lastCueSequence.clear()
    if (this.#initialized) this.#app.destroy(true, { children: true, texture: false, textureSource: false })
    for (const texture of this.#layerTextures) texture.destroy(false)
    this.#layerTextures.clear()
    for (const texture of this.#assetTextures.values()) texture.destroy(true)
    this.#assetTextures.clear()
    this.#initialized = false
    this.#sharedScene = false
  }

  async #loadAssets(manifest: WorldThemeManifestV1): Promise<void> {
    await Promise.all(manifest.assets.map(async (asset) => {
      const image = await loadImage(asset.src)
      const texture = manifest.actorSets.some((actorSet) => actorSet.assetId === asset.id) ? createRosterTexture(image) : Texture.from(image)
      texture.source.scaleMode = asset.pixelArt ? 'nearest' : 'linear'
      this.#assetTextures.set(asset.id, texture)
    }))
  }

  #buildScene(): void {
    if (!this.#scene) return
    const actorZ = 600
    for (const layer of this.#scene.layers) {
      if (this.#sharedScene) continue
      const sourceTexture = this.#assetTextures.get(layer.assetId)
      if (sourceTexture === undefined) continue
      const texture = layer.source === undefined
        ? sourceTexture
        : new Texture({ source: sourceTexture.source, frame: new Rectangle(layer.source.x, layer.source.y, layer.source.width, layer.source.height) })
      if (texture !== sourceTexture) this.#layerTextures.add(texture)
      const sprite = new Sprite(texture)
      sprite.position.set(layer.destination.x, layer.destination.y)
      sprite.width = layer.destination.width
      sprite.height = layer.destination.height
      sprite.alpha = layer.alpha ?? 1
      sprite.zIndex = layer.occludesActors ? Math.max(layer.zIndex, actorZ + layer.destination.y) : layer.zIndex
      this.#sceneRoot.addChild(sprite)
    }
    this.#interactionLayer.zIndex = 8_000
    this.#effectsLayer.zIndex = 9_000
    for (const interactable of this.#scene.interactables) {
      const hint = new Graphics()
        .roundRect(interactable.bounds.x, interactable.bounds.y, interactable.bounds.width, interactable.bounds.height, 10)
        .stroke({ color: 0x51d4e8, width: 2, alpha: 0.8 })
      hint.eventMode = 'static'
      hint.cursor = 'pointer'
      hint.alpha = 0.001
      hint.on('pointerover', () => { hint.alpha = 0.72 })
      hint.on('pointerout', () => { hint.alpha = this.#selectedObjectId === interactable.id ? 0.58 : 0.001 })
      hint.on('pointertap', (event: FederatedPointerEvent) => {
        event.stopPropagation()
        this.#callbacks.onObjectSelect(interactable.id)
      })
      hint.on('rightclick', (event: FederatedPointerEvent) => {
        event.stopPropagation()
        this.#callbacks.onObjectContext?.(interactable.id, { x: event.global.x, y: event.global.y })
      })
      this.#interactionLayer.addChild(hint)
      this.#objectHints.set(interactable.id, hint)
    }
    this.#darkness = new Graphics()
    this.#darkness.zIndex = 7_500
    this.#sceneRoot.addChild(this.#darkness)
  }

  #createActor(entity: WorldRuntimeEntityState): ActorView {
    const actorSet = this.#manifest?.actorSets[0]
    const source = actorSet === undefined ? undefined : this.#assetTextures.get(actorSet.assetId)
    if (actorSet === undefined || source === undefined) throw new Error('角色图集尚未加载')
    const animation = new ActorAnimationController(source, actorSet, rosterIndexFor(entity))
    const root = new Container()
    root.eventMode = 'static'
    root.cursor = 'pointer'
    root.hitArea = new Rectangle(-58, -136, 116, 152)
    const shadow = new Graphics().ellipse(0, -2, 34, 10).fill({ color: 0x000000, alpha: 0.42 })
    const selection = new Graphics().ellipse(0, -2, 45, 15).stroke({ color: 0x58e2ff, width: 3, alpha: 0.95 })
    selection.visible = false
    const status = new Graphics()
    const name = new Text({ text: entity.authorityRole === 'administrator' ? `${entity.displayName}  ♛` : entity.displayName, style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 15, fontWeight: '700', fill: 0xf4f7fb, stroke: { color: 0x05080b, width: 4 } } })
    name.anchor.set(0.5, 0)
    name.position.set(0, -151)
    const activity = new Text({ text: entity.activityLabel, style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 12, fill: 0x8fd9e6, stroke: { color: 0x05080b, width: 3 } } })
    activity.anchor.set(0.5, 0)
    activity.position.set(0, -130)
    activity.visible = false
    root.addChild(shadow, selection, animation.sprite, status, name, activity)
    root.on('pointertap', (event: FederatedPointerEvent) => { event.stopPropagation(); this.#callbacks.onEntitySelect(entity.id) })
    root.on('rightclick', (event: FederatedPointerEvent) => { event.stopPropagation(); this.#callbacks.onEntityContext?.(entity.id, { x: event.global.x, y: event.global.y }) })
    root.on('pointerover', () => { activity.visible = true })
    root.on('pointerout', () => { activity.visible = this.#selectedEntityId === entity.id })
    root.label = entity.displayName
    const actor: ActorView = { root, animation, selection, status, name, activity, state: entity }
    this.#sceneRoot.addChild(root)
    this.#actors.set(entity.id, actor)
    return actor
  }

  #tick(deltaMs: number): void {
    this.#locomotion.advance(deltaMs)
    for (const actor of this.#actors.values()) {
      const live = this.#locomotion.stateOf(actor.state.id)
      if (live !== undefined) {
        actor.root.position.set(live.position.x, live.position.y)
        const settled = this.#snapshot?.entities.find((entity) => entity.id === actor.state.id)
        actor.state = live.walking
          ? { ...actor.state, facing: live.facing, activity: 'walking' }
          : { ...(settled ?? actor.state), facing: live.facing }
        this.#applyAnimation(actor)
      }
      actor.animation.tick(deltaMs)
      actor.root.zIndex = 600 + actor.root.y
    }
  }

  #applyAnimation(actor: ActorView): void {
    actor.animation.setState(this.#locomotion.isWalking(actor.state.id) ? 'walking' : actor.state.activity, actor.state.facing)
  }

  #updateGrowth(snapshot: WorldRuntimeSnapshot): void {
    if (this.#scene === undefined) return
    for (const slot of this.#scene.growthSlots) {
      const milestoneIds = snapshot.growthSlots[slot.category] ?? []
      let marker = this.#growthMarkers.get(slot.id)
      if (marker === undefined) {
        const root = new Container()
        root.position.set(slot.position.x, slot.position.y)
        root.zIndex = slot.zIndex
        const color = slot.category === 'promotion' ? 0xf3b83f : slot.category === 'delivery' ? 0x55d691 : 0x58e2ff
        const badge = new Graphics().circle(0, 0, 18).fill({ color: 0x10171d, alpha: 0.94 }).stroke({ color, width: 3, alpha: 0.95 })
        const glyph = new Text({ text: growthGlyph(slot.category), style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 16, fill: color, fontWeight: '800' } })
        glyph.anchor.set(0.5)
        const count = new Text({ text: '', style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 11, fill: 0xffffff, fontWeight: '700' } })
        count.anchor.set(0.5)
        count.position.set(18, -16)
        root.addChild(badge, glyph, count)
        this.#sceneRoot.addChild(root)
        marker = { root, count }
        this.#growthMarkers.set(slot.id, marker)
      }
      marker.root.visible = milestoneIds.length > 0
      marker.count.text = String(milestoneIds.length)
      marker.root.label = `${slot.category}:${milestoneIds.join(',')}`
    }
  }

  #showBubble(actor: ActorView, text: string): void {
    const compact = text.replace(/\s+/g, ' ').trim().slice(0, 38)
    if (!compact) return
    this.#removeBubble(actor.state.id)
    const bubble = new Container()
    const label = new Text({ text: compact, style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 14, fill: 0xf6f7f8, wordWrap: true, wordWrapWidth: 220, lineHeight: 20 } })
    const width = Math.min(240, Math.max(110, label.width + 24))
    const height = label.height + 18
    const plate = new Graphics().roundRect(-width / 2, -height, width, height, 9).fill({ color: 0x10171d, alpha: 0.96 }).stroke({ color: 0x4fd8ed, width: 1, alpha: 0.72 })
    label.anchor.set(0.5, 1)
    label.position.set(0, -8)
    bubble.position.set(actor.root.x, actor.root.y - 150)
    bubble.zIndex = 9_500
    bubble.addChild(plate, label)
    this.#effectsLayer.addChild(bubble)
    this.#actorBubbles.set(actor.state.id, bubble)
    window.setTimeout(() => {
      if (this.#actorBubbles.get(actor.state.id) !== bubble) return
      this.#removeBubble(actor.state.id)
    }, 4_000)
  }

  #removeBubble(entityId: string): void {
    const bubble = this.#actorBubbles.get(entityId)
    if (bubble === undefined) return
    this.#actorBubbles.delete(entityId)
    bubble.destroy({ children: true })
  }

  #setLights(lightsOn: boolean): void {
    if (!this.#darkness || !this.#scene) return
    if (this.#sharedScene) {
      this.#darkness.clear()
      return
    }
    this.#darkness.clear().rect(0, 0, this.#scene.size.width, this.#scene.size.height).fill({ color: 0x02050a, alpha: lightsOn ? 0.04 : 0.58 })
  }

  #wireCamera(): void {
    if (!this.#host) return
    this.#wheelListener = (event) => { event.preventDefault(); this.zoomBy(event.deltaY > 0 ? -0.1 : 0.1) }
    this.#host.addEventListener('wheel', this.#wheelListener, { passive: false })
    this.#app.stage.eventMode = 'static'
    this.#app.stage.hitArea = this.#app.screen
    this.#app.stage.on('pointerdown', (event: FederatedPointerEvent) => {
      this.#drag = { x: event.global.x, y: event.global.y, offsetX: this.#cameraOffset.x, offsetY: this.#cameraOffset.y }
    })
    this.#app.stage.on('pointermove', (event: FederatedPointerEvent) => {
      if (this.#drag === undefined) return
      this.#cameraOffset = { x: this.#drag.offsetX + event.global.x - this.#drag.x, y: this.#drag.offsetY + event.global.y - this.#drag.y }
      this.#applyCamera()
    })
    const release = () => { this.#drag = undefined }
    this.#app.stage.on('pointerup', release)
    this.#app.stage.on('pointerupoutside', release)
  }

  #minimumZoomForCoverage(): number {
    if (!this.#scene || !this.#host || this.#fitScale <= 0) return WORLD_MIN_ZOOM
    const bounds = this.#scene.cameraBounds ?? { x: 0, y: 0, width: this.#scene.size.width, height: this.#scene.size.height }
    return minimumCoverageZoom(this.#host.clientWidth, this.#host.clientHeight, bounds.width, bounds.height, this.#fitScale)
  }

  #clampCameraOffset(scale: number): void {
    if (!this.#scene || !this.#host) return
    const bounds = this.#scene.cameraBounds ?? { x: 0, y: 0, width: this.#scene.size.width, height: this.#scene.size.height }
    const viewportWidth = Math.max(1, this.#host.clientWidth)
    const viewportHeight = Math.max(1, this.#host.clientHeight)
    const minX = viewportWidth - (bounds.x + bounds.width) * scale
    const maxX = -bounds.x * scale
    const minY = viewportHeight - (bounds.y + bounds.height) * scale
    const maxY = -bounds.y * scale
    this.#cameraOffset = {
      x: minX <= maxX ? clamp(this.#cameraOffset.x, minX, maxX) : (viewportWidth - bounds.width * scale) / 2 - bounds.x * scale,
      y: minY <= maxY ? clamp(this.#cameraOffset.y, minY, maxY) : (viewportHeight - bounds.height * scale) / 2 - bounds.y * scale,
    }
  }

  #applyCamera(): void {
    this.#zoom = Math.max(this.#zoom, this.#minimumZoomForCoverage())
    const scale = this.#fitScale * this.#zoom
    this.#clampCameraOffset(scale)
    this.#camera.scale.set(scale)
    this.#camera.position.set(this.#cameraOffset.x, this.#cameraOffset.y)
  }
}

export function minimumCoverageZoom(viewportWidth: number, viewportHeight: number, sceneWidth: number, sceneHeight: number, fitScale: number): number {
  const widthZoom = viewportWidth / Math.max(1, sceneWidth * fitScale)
  const heightZoom = viewportHeight / Math.max(1, sceneHeight * fitScale)
  // Coverage is a layout invariant, not a user zoom preference. Very tall or
  // very wide panes (notably the world pane on 4K displays) can require more
  // than the normal interactive zoom ceiling to avoid letterboxing.
  return Math.max(WORLD_MIN_ZOOM, widthZoom, heightZoom)
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`世界资源加载失败：${source}`))
    image.src = source
  })
}

function createRosterTexture(image: HTMLImageElement): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return Texture.from(image)
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const visited = new Uint8Array(canvas.width * canvas.height)
  const queue = new Int32Array(canvas.width * canvas.height)
  let head = 0
  let tail = 0
  const enqueue = (index: number) => {
    if (index < 0 || index >= visited.length || visited[index] === 1) return
    visited[index] = 1
    queue[tail++] = index
  }
  for (let x = 0; x < canvas.width; x += 1) {
    enqueue(x)
    enqueue((canvas.height - 1) * canvas.width + x)
  }
  for (let y = 0; y < canvas.height; y += 1) {
    enqueue(y * canvas.width)
    enqueue(y * canvas.width + canvas.width - 1)
  }
  while (head < tail) {
    const index = queue[head++]!
    const offset = index * 4
    const red = pixels.data[offset]!
    const green = pixels.data[offset + 1]!
    const blue = pixels.data[offset + 2]!
    const maximum = Math.max(red, green, blue)
    const minimum = Math.min(red, green, blue)
    if (minimum < 226 || maximum - minimum > 7) continue
    pixels.data[offset + 3] = 0
    const x = index % canvas.width
    if (x > 0) enqueue(index - 1)
    if (x + 1 < canvas.width) enqueue(index + 1)
    if (index >= canvas.width) enqueue(index - canvas.width)
    if (index + canvas.width < visited.length) enqueue(index + canvas.width)
  }
  context.putImageData(pixels, 0, 0)
  return Texture.from(canvas)
}

function rosterIndexFor(entity: WorldRuntimeEntityState): number {
  const configured = entity.visualState['rosterIndex']
  if (typeof configured === 'number' && Number.isInteger(configured)) return clamp(configured, 0, 7)
  let hash = 0
  for (const character of entity.id) hash = (hash * 31 + character.charCodeAt(0)) % 8
  return hash
}

function statusColor(entity: WorldRuntimeEntityState): number {
  if (entity.status === 'blocked') return 0xf26464
  if (entity.status === 'working') return 0x4fd8ed
  if (entity.status === 'waiting') return 0xf3b83f
  return 0x55d691
}

function growthGlyph(category: string): string {
  if (category === 'promotion') return '▲'
  if (category === 'delivery') return '✓'
  return '✦'
}

function cuePoints(cue: WorldCue): WorldPoint[] {
  const route = cue.payload['route']
  if (!Array.isArray(route)) return []
  return route.flatMap((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const point = value as Record<string, unknown>
    return typeof point.x === 'number' && typeof point.y === 'number' ? [{ x: point.x, y: point.y }] : []
  })
}

function cueText(cue: WorldCue): string {
  // `excerpt` is the key the projector writes; without it every speech bubble
  // silently degraded to the character's activity label.
  const value = cue.payload['text'] ?? cue.payload['excerpt'] ?? cue.payload['label']
  return typeof value === 'string' ? value : ''
}



function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
