import { AnimatedSprite, Rectangle, Texture } from 'pixi.js'
import type {
  WorldActivityKind,
  WorldFacing,
  WorldThemeActorSetManifest,
} from '@dsh-cyber/contracts'

const ACTIVITY_SPEED: Record<WorldActivityKind, number> = {
  idle: 0.06,
  walking: 0.16,
  thinking: 0.08,
  working: 0.12,
  talking: 0.1,
  meeting: 0.08,
  blocked: 0.04,
  celebrating: 0.14,
}

export class ActorAnimationController {
  readonly sprite: AnimatedSprite
  readonly #actorSet: WorldThemeActorSetManifest
  readonly #source: Texture
  readonly #rosterIndex: number
  readonly #textures = new Map<number, Texture>()
  #activity: WorldActivityKind = 'idle'
  #facing: WorldFacing = 'south'
  #elapsed = 0
  #usesFallback = true

  constructor(source: Texture, actorSet: WorldThemeActorSetManifest, rosterIndex: number) {
    this.#source = source
    this.#actorSet = actorSet
    this.#rosterIndex = rosterIndex
    this.sprite = new AnimatedSprite([this.#texture(0)])
    const renderedHeight = actorSet.frameHeight * actorSet.scale
    const anchorY = renderedHeight <= 0 ? 1 : Math.min(1, Math.max(0, actorSet.footOffset.y / renderedHeight))
    this.sprite.anchor.set(0.5, anchorY)
    this.sprite.scale.set(actorSet.scale)
    this.setState('idle', 'south')
  }

  setState(activity: WorldActivityKind, facing: WorldFacing): void {
    if (this.#activity === activity && this.#facing === facing && this.sprite.textures.length > 0) return
    this.#activity = activity
    this.#facing = facing
    const frames = resolveClipFrames(this.#actorSet, activity, facing)
    this.sprite.textures = frames.map((frame) => this.#texture(frame))
    this.sprite.animationSpeed = ACTIVITY_SPEED[activity]
    this.sprite.loop = true
    this.#usesFallback = this.sprite.textures.length < 2
    if (this.#usesFallback) this.sprite.stop()
    else this.sprite.play()
    this.#applyFacingScale()
  }

  tick(deltaMs: number): void {
    this.#elapsed += deltaMs
    this.sprite.x = 0
    this.sprite.y = 0
    this.sprite.rotation = 0
    this.sprite.alpha = 1
    if (!this.#usesFallback) return
    const wave = Math.sin(this.#elapsed / 130)
    if (this.#activity === 'walking') {
      // Static fallback uses a horizontal stride/sway; vertical bob is deliberately avoided.
      this.sprite.x = wave * 1.8
      this.sprite.rotation = wave * 0.025
    } else if (this.#activity === 'thinking') {
      this.sprite.rotation = Math.sin(this.#elapsed / 420) * 0.012
    } else if (this.#activity === 'talking' || this.#activity === 'meeting') {
      this.sprite.rotation = Math.sin(this.#elapsed / 210) * 0.01
    } else if (this.#activity === 'blocked') {
      this.sprite.alpha = 0.72 + Math.abs(Math.sin(this.#elapsed / 500)) * 0.24
    } else if (this.#activity === 'celebrating') {
      this.sprite.rotation = wave * 0.035
      this.sprite.x = wave * 1.2
    }
  }

  destroy(): void {
    this.sprite.stop()
    for (const texture of this.#textures.values()) texture.destroy(false)
    this.#textures.clear()
  }

  get textureCount(): number {
    return this.#textures.size
  }

  #texture(relativeFrame: number): Texture {
    const columns = Math.max(1, Math.floor(this.#source.width / this.#actorSet.frameWidth))
    const rows = Math.max(1, Math.floor(this.#source.height / this.#actorSet.frameHeight))
    const totalFrames = columns * rows
    const framesPerActor = Math.max(1, this.#actorSet.framesPerActor ?? 1)
    const frameIndex = Math.min(totalFrames - 1, Math.max(0, this.#rosterIndex * framesPerActor + relativeFrame))
    const cached = this.#textures.get(frameIndex)
    if (cached !== undefined) return cached
    const texture = new Texture({
      source: this.#source.source,
      frame: new Rectangle(
        (frameIndex % columns) * this.#actorSet.frameWidth,
        Math.floor(frameIndex / columns) * this.#actorSet.frameHeight,
        this.#actorSet.frameWidth,
        this.#actorSet.frameHeight,
      ),
    })
    this.#textures.set(frameIndex, texture)
    return texture
  }

  #applyFacingScale(): void {
    const horizontal = this.#facing === 'west' ? -1 : 1
    this.sprite.scale.set(this.#actorSet.scale * horizontal, this.#actorSet.scale)
  }
}

export function resolveClipFrames(
  actorSet: WorldThemeActorSetManifest,
  activity: WorldActivityKind,
  facing: WorldFacing,
): number[] {
  const clip = actorSet.clips[activity]
  const fallbackOrder: WorldFacing[] = [facing, 'south', 'east', 'west', 'north']
  for (const direction of fallbackOrder) {
    const frames = clip?.[direction]
    if (frames !== undefined && frames.length > 0) return frames
  }
  for (const frames of Object.values(clip ?? {})) {
    if (frames !== undefined && frames.length > 0) return frames
  }
  return [0]
}
