import * as THREE from 'three'

import type { WorldActivityKind } from '@dsh-cyber/contracts'

import type { LodCapabilities } from './three-world-lod.js'

/**
 * A character in the world before, or instead of, a VRM.
 *
 * Every character is in the world from the moment it exists, whether or not
 * anybody has made an avatar for it. Waiting for a rigged model would leave an
 * office of empty desks, and pushing the user out to an avatar editor before
 * they can see their company is the wrong order.
 *
 * So this is a real inhabitant, not a placeholder box: it stands, walks, sits
 * at the right height, turns, and carries its name. When a VRM arrives it is
 * swapped out; until then nothing about the world is missing.
 */

const BODY_HEIGHT = 1.05
const HEAD_RADIUS = 0.135
const TOTAL_HEIGHT = 1.72

export interface LowPolyActorOptions {
  shadows?: boolean
  /** Stable per-character tint, so a room of stand-ins is still legible. */
  hue?: number
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
  #phase = 0
  #bubbleUntil = 0

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
  }

  setLabel(displayName: string, activityLabel: string): void {
    const texture = labelTexture(displayName, activityLabel)
    const material = this.#label.material as THREE.SpriteMaterial
    material.map?.dispose()
    material.map = texture
    material.needsUpdate = true
  }

  /** A short-lived line above the character, for an `entity.speech` cue. */
  say(text: string): void {
    if (text.trim() === '') return
    this.#bubbleUntil = performance.now() + 4_000
    this.#label.scale.set(2.1, 0.5, 1)
  }

  /**
   * Trades detail for time.
   *
   * A billboard keeps the character visible and clickable at a fraction of the
   * cost; the point of dropping detail is that nobody can see it from there.
   */
  setDetail(capabilities: LodCapabilities): void {
    const skinned = capabilities.skinned
    this.#body.visible = skinned
    this.#head.visible = skinned
    this.#body.castShadow = capabilities.shadow
    this.#head.castShadow = capabilities.shadow
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

  /**
   * Advances the character's own motion.
   *
   * Procedural and small on purpose: a bob while walking, a settle while
   * standing. It is what a stand-in can honestly do, and it stays out of the
   * way of the real animation a VRM brings.
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
    }
  }

  /**
   * Steps aside for the character's own avatar.
   *
   * Kept rather than destroyed: the label stays, and a VRM that later fails to
   * reload has something to fall back to.
   */
  hideStandIn(): void {
    this.#body.visible = false
    this.#head.visible = false
    this.#billboard?.removeFromParent()
  }

  dispose(): void {
    this.root.removeFromParent()
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
