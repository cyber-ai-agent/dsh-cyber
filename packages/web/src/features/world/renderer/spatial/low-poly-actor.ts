import * as THREE from 'three'

import type { WorldActivityKind } from '@dsh-cyber/contracts'

import type { LodCapabilities } from './three-world-lod.js'

/**
 * One frame in the same actor atlas the Pixi world uses.
 *
 * A 3D stand-in should preserve identity before it preserves dimensionality:
 * seeing the exact purple-haired analyst from 2D inside a 3D office is less
 * jarring than replacing her with an unrelated capsule person merely because
 * that person is technically geometry.
 */
export interface IdentityPortraitSource {
  src: string
  frameWidth: number
  frameHeight: number
  framesPerActor?: number
  rosterIndex: number
}

export interface IdentityPortraitFrame {
  repeatX: number
  repeatY: number
  offsetX: number
  offsetY: number
  aspect: number
}

/** Pure atlas arithmetic, exported so identity continuity is testable without WebGL. */
export function identityPortraitFrame(
  imageWidth: number,
  imageHeight: number,
  source: IdentityPortraitSource,
): IdentityPortraitFrame | undefined {
  if (
    !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) ||
    imageWidth <= 0 || imageHeight <= 0 ||
    source.frameWidth <= 0 || source.frameHeight <= 0
  ) return undefined
  const columns = Math.max(1, Math.floor(imageWidth / source.frameWidth))
  const rows = Math.max(1, Math.floor(imageHeight / source.frameHeight))
  const framesPerActor = Math.max(1, Math.floor(source.framesPerActor ?? 1))
  const actorCount = Math.max(1, Math.floor((columns * rows) / framesPerActor))
  const actorIndex = ((Math.floor(source.rosterIndex) % actorCount) + actorCount) % actorCount
  const frameIndex = actorIndex * framesPerActor
  const column = frameIndex % columns
  const row = Math.floor(frameIndex / columns)
  const repeatX = source.frameWidth / imageWidth
  const repeatY = source.frameHeight / imageHeight
  return {
    repeatX,
    repeatY,
    offsetX: column * repeatX,
    // Texture UVs start at the bottom; the roster is authored top-to-bottom.
    offsetY: 1 - ((row + 1) * repeatY),
    aspect: source.frameWidth / source.frameHeight,
  }
}

/**
 * A character in the world before, or instead of, a VRM.
 *
 * Every character is in the world from the moment it exists, whether or not
 * anybody has made an avatar for it. Waiting for a rigged model would leave an
 * office of empty desks, and pushing the user out to an avatar editor before
 * they can see their company is the wrong order.
 *
 * When the theme has a 2D actor atlas, that exact portrait is the preferred
 * stand-in. The primitive body remains only as a last fallback for themes that
 * do not ship identity artwork or when the image cannot be loaded.
 */

const BODY_HEIGHT = 1.05
const HEAD_RADIUS = 0.135
const TOTAL_HEIGHT = 1.72

export interface LowPolyActorOptions {
  shadows?: boolean
  /** Stable per-character tint, so a room of primitive fallbacks is still legible. */
  hue?: number
  /** Exact 2D identity to preserve while a matching authored VRM is unavailable. */
  identityPortrait?: IdentityPortraitSource
}

export class LowPolyActor {
  readonly root = new THREE.Group()
  /** The mesh raycasting hits. Kept generous so a small figure is easy to click. */
  readonly picker: THREE.Mesh

  readonly #body: THREE.Mesh
  readonly #head: THREE.Mesh
  readonly #label: THREE.Sprite
  readonly #disposables: Array<{ dispose(): void }> = []
  readonly #shadows: boolean

  #billboard: THREE.Mesh | undefined
  #identityPortrait: THREE.Sprite | undefined
  #identityPortraitKey: string | undefined
  #identityLoadToken = 0
  #standInHidden = false
  #disposed = false
  #detail: LodCapabilities = { face: true, secondaryMotion: true, skinned: true, shadow: true }
  #phase = 0
  #bubbleUntil = 0
  #displayName = ''
  #activityLabel = ''

  constructor(options: LowPolyActorOptions = {}) {
    this.#shadows = options.shadows !== false
    const hue = options.hue ?? 0.58
    const skin = new THREE.Color().setHSL(hue, 0.32, 0.62)
    const cloth = new THREE.Color().setHSL(hue, 0.38, 0.34)

    const bodyGeometry = new THREE.CapsuleGeometry(0.19, BODY_HEIGHT - 0.38, 4, 10)
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.78, metalness: 0.04 })
    this.#body = new THREE.Mesh(bodyGeometry, bodyMaterial)
    this.#body.position.y = BODY_HEIGHT / 2 + 0.12
    this.#body.castShadow = this.#shadows
    this.root.add(this.#body)

    const headGeometry = new THREE.SphereGeometry(HEAD_RADIUS, 16, 12)
    const headMaterial = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.62, metalness: 0.02 })
    this.#head = new THREE.Mesh(headGeometry, headMaterial)
    this.#head.position.y = TOTAL_HEIGHT - HEAD_RADIUS
    this.#head.castShadow = this.#shadows
    this.root.add(this.#head)

    const pickerGeometry = new THREE.CylinderGeometry(0.42, 0.42, TOTAL_HEIGHT, 8, 1, true)
    const pickerMaterial = new THREE.MeshBasicMaterial({ visible: false })
    this.picker = new THREE.Mesh(pickerGeometry, pickerMaterial)
    this.picker.position.y = TOTAL_HEIGHT / 2
    this.root.add(this.picker)

    this.#label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
    this.#label.position.y = TOTAL_HEIGHT + 0.28
    this.#label.scale.set(1.5, 0.38, 1)
    this.root.add(this.#label)

    this.#disposables.push(bodyGeometry, bodyMaterial, headGeometry, headMaterial, pickerGeometry, pickerMaterial)
    if (options.identityPortrait !== undefined) this.setIdentityPortrait(options.identityPortrait)
  }

  setLabel(displayName: string, activityLabel: string): void {
    this.#displayName = displayName
    this.#activityLabel = activityLabel
    this.#draw(displayName, activityLabel)
  }

  #draw(displayName: string, secondLine: string): void {
    const texture = labelTexture(displayName, secondLine)
    const material = this.#label.material as THREE.SpriteMaterial
    material.map?.dispose()
    material.map = texture
    material.needsUpdate = true
  }

  /**
   * Asynchronously adopts the exact frame used by the 2D renderer.
   *
   * `THREE.Sprite` is deliberate: it always faces the camera, so focus/follow
   * cameras cannot turn a 2.5D character edge-on. The actor still owns the
   * world position, picker, label and activity state.
   */
  setIdentityPortrait(source: IdentityPortraitSource | undefined): void {
    const key = source === undefined
      ? undefined
      : `${source.src}:${source.frameWidth}x${source.frameHeight}:${source.framesPerActor ?? 1}:${source.rosterIndex}`
    if (key === this.#identityPortraitKey) return
    this.#identityPortraitKey = key
    const token = ++this.#identityLoadToken
    this.#disposeIdentityPortrait()
    if (source === undefined || this.#disposed) {
      this.#applyDetail()
      return
    }
    const loader = new THREE.TextureLoader()
    loader.load(
      source.src,
      (atlas) => {
        if (this.#disposed || token !== this.#identityLoadToken) {
          atlas.dispose()
          return
        }
        const image = atlas.image as { width?: number; height?: number } | undefined
        const frame = identityPortraitFrame(image?.width ?? 0, image?.height ?? 0, source)
        if (frame === undefined) {
          atlas.dispose()
          this.#applyDetail()
          return
        }
        atlas.colorSpace = THREE.SRGBColorSpace
        const texture = atlas.clone()
        texture.colorSpace = THREE.SRGBColorSpace
        texture.wrapS = THREE.ClampToEdgeWrapping
        texture.wrapT = THREE.ClampToEdgeWrapping
        texture.repeat.set(frame.repeatX, frame.repeatY)
        texture.offset.set(frame.offsetX, frame.offsetY)
        texture.needsUpdate = true
        atlas.dispose()
        const material = new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          alphaTest: 0.02,
          depthWrite: false,
          toneMapped: false,
        })
        const portrait = new THREE.Sprite(material)
        portrait.name = 'identity-portrait'
        portrait.position.y = TOTAL_HEIGHT / 2
        portrait.scale.set(TOTAL_HEIGHT * frame.aspect, TOTAL_HEIGHT, 1)
        this.#identityPortrait = portrait
        this.root.add(portrait)
        this.#applyDetail()
      },
      undefined,
      () => {
        if (token === this.#identityLoadToken) this.#applyDetail()
      },
    )
  }

  /** A requested portrait is enough to prefer identity over a generic VRM draft. */
  get identityPortraitRequested(): boolean {
    return this.#identityPortraitKey !== undefined
  }

  /** Whether the exact 2D identity has finished loading into the scene. */
  get identityPortraitReady(): boolean {
    return this.#identityPortrait !== undefined
  }

  /**
   * Shows what the character just said.
   *
   * Stretching the name plate and showing the same two words was the old
   * behaviour and told nobody anything: the 2D world puts the utterance on
   * screen, and the 3D world was silent. Truncated the way the 2D bubble is —
   * a name plate is not a transcript.
   */
  say(text: string): void {
    const line = text.replaceAll(/\s+/g, ' ').trim()
    if (line === '') return
    this.#bubbleUntil = performance.now() + 4_000
    this.#label.scale.set(2.4, 0.6, 1)
    this.#draw(this.#displayName, line.length <= 38 ? line : `${line.slice(0, 37)}…`)
  }

  /**
   * Trades detail for time while keeping identity stable.
   *
   * If an exact portrait exists it remains the stand-in at every LOD; the
   * primitive capsule or blue plane is only a last resort for themes without
   * an actor atlas.
   */
  setDetail(capabilities: LodCapabilities): void {
    this.#detail = capabilities
    this.#standInHidden = false
    this.#applyDetail()
  }

  #applyDetail(): void {
    if (this.#standInHidden) {
      this.#body.visible = false
      this.#head.visible = false
      this.#billboard?.removeFromParent()
      if (this.#identityPortrait !== undefined) this.#identityPortrait.visible = false
      return
    }
    if (this.#identityPortrait !== undefined) {
      this.#body.visible = false
      this.#head.visible = false
      this.#billboard?.removeFromParent()
      this.#identityPortrait.visible = true
      return
    }
    const skinned = this.#detail.skinned
    this.#body.visible = skinned
    this.#head.visible = skinned
    this.#body.castShadow = this.#detail.shadow
    this.#head.castShadow = this.#detail.shadow
    if (skinned) {
      this.#billboard?.removeFromParent()
      return
    }
    if (this.#billboard === undefined) {
      const geometry = new THREE.PlaneGeometry(0.62, TOTAL_HEIGHT)
      const material = new THREE.MeshBasicMaterial({
        color: 0x8fb4e8,
        transparent: true,
        opacity: 0.82,
        side: THREE.DoubleSide,
      })
      this.#billboard = new THREE.Mesh(geometry, material)
      this.#billboard.position.y = TOTAL_HEIGHT / 2
      this.#disposables.push(geometry, material)
    }
    this.root.add(this.#billboard)
  }

  /** Whether this stand-in currently contributes a visible representation. */
  get representationVisible(): boolean {
    return this.#body.visible
      || this.#head.visible
      || this.#billboard?.parent === this.root
      || (this.#identityPortrait?.parent === this.root && this.#identityPortrait.visible)
  }

  /**
   * Advances the character's own motion.
   *
   * Procedural and small on purpose: a bob while walking, a settle while
   * standing. It is what a primitive stand-in can honestly do; the exact
   * identity portrait stays visually stable instead of wobbling like a card.
   */
  update(deltaMs: number, activity: WorldActivityKind): void {
    this.#phase += deltaMs / 1_000
    const walking = activity === 'walking'
    const bob = walking ? Math.sin(this.#phase * 9) * 0.045 : Math.sin(this.#phase * 1.7) * 0.008
    this.#body.position.y = BODY_HEIGHT / 2 + 0.12 + bob
    this.#head.position.y = TOTAL_HEIGHT - HEAD_RADIUS + bob
    const lean = walking ? 0.09 : activity === 'working' ? 0.16 : 0
    this.#body.rotation.x = lean
    this.#head.rotation.x = activity === 'thinking' ? -0.18 : lean * 0.5
    if (this.#bubbleUntil > 0 && performance.now() > this.#bubbleUntil) {
      this.#bubbleUntil = 0
      this.#label.scale.set(1.5, 0.38, 1)
      this.#draw(this.#displayName, this.#activityLabel)
    }
  }

  /**
   * Steps aside for a matching authored avatar.
   *
   * Kept rather than destroyed: the exact portrait stays cached on the actor,
   * and a VRM that later fails or drops to billboard LOD has the same character
   * to fall back to instead of an unrelated body.
   */
  hideStandIn(): void {
    this.#standInHidden = true
    this.#applyDetail()
  }

  #disposeIdentityPortrait(): void {
    const portrait = this.#identityPortrait
    if (portrait === undefined) return
    portrait.removeFromParent()
    const material = portrait.material as THREE.SpriteMaterial
    material.map?.dispose()
    material.dispose()
    this.#identityPortrait = undefined
  }

  dispose(): void {
    this.#disposed = true
    this.#identityLoadToken += 1
    this.root.removeFromParent()
    this.#disposeIdentityPortrait()
    const material = this.#label.material as THREE.SpriteMaterial
    material.map?.dispose()
    material.dispose()
    for (const disposable of this.#disposables) disposable.dispose()
    this.#disposables.length = 0
  }
}

/**
 * The name tag.
 *
 * Drawn into a texture rather than into the DOM because it has to sit in the
 * scene at the character's height and occlude correctly. Everything the user
 * reads and acts on — menus, chat, status — stays in the DOM.
 */
function labelTexture(displayName: string, activityLabel: string): THREE.Texture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context === null) return null
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = 'rgba(12,16,22,0.72)'
  roundedRect(context, 8, 22, 496, 84, 18)
  context.fill()
  context.fillStyle = '#e8f0fb'
  context.font = '600 42px system-ui, -apple-system, "PingFang SC", sans-serif'
  context.textAlign = 'center'
  context.fillText(displayName, 256, 66)
  if (activityLabel !== '') {
    context.fillStyle = 'rgba(190,208,232,0.8)'
    context.font = '400 26px system-ui, -apple-system, "PingFang SC", sans-serif'
    context.fillText(activityLabel, 256, 98)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}
