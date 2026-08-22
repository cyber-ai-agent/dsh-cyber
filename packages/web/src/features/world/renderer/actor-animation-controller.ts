import { AnimatedSprite, Rectangle, Texture } from 'pixi.js'
import type {
  WorldActivityKind,
  WorldFacing,
  WorldThemeActorSetManifest,
} from '@dsh-cyber/contracts'
import {
  characterMotionPhaseOffset,
  sampleCharacterMotion,
  type CharacterMotionProfileId,
  type CharacterMotionSample,
} from '@dsh-cyber/world-runtime'

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

export interface ActorAnimationControllerOptions {
  characterId?: string
  reducedMotion?: boolean
  motionProfileId?: CharacterMotionProfileId
}

export class ActorAnimationController {
  readonly sprite: AnimatedSprite
  readonly #actorSet: WorldThemeActorSetManifest
  readonly #source: Texture
  readonly #rosterIndex: number
  readonly #phaseOffset: number
  readonly #textures = new Map<number, Texture>()
  #activity: WorldActivityKind = 'idle'
  #facing: WorldFacing = 'south'
  #elapsed = 0
  #usesFallback = true
  #reducedMotion: boolean
  #motionProfileId: CharacterMotionProfileId

  constructor(
    source: Texture,
    actorSet: WorldThemeActorSetManifest,
    rosterIndex: number,
    options: ActorAnimationControllerOptions = {},
  ) {
    this.#source = source
    this.#actorSet = actorSet
    this.#rosterIndex = rosterIndex
    this.#phaseOffset = options.characterId === undefined
      ? 0
      : characterMotionPhaseOffset(options.characterId)
    this.#reducedMotion = options.reducedMotion ?? false
    this.#motionProfileId = options.motionProfileId ?? 'standard'
    this.sprite = new AnimatedSprite([this.#texture(0)])
    const renderedHeight = actorSet.frameHeight * actorSet.scale
    const anchorY = renderedHeight <= 0 ? 1 : Math.min(1, Math.max(0, actorSet.footOffset.y / renderedHeight))
    this.sprite.anchor.set(0.5, anchorY)
    this.sprite.scale.set(actorSet.scale)
    this.setState('idle', 'south')
  }

  setState(activity: WorldActivityKind, facing: WorldFacing): void {
    if (this.#activity === activity && this.#facing === facing && this.sprite.textures.length > 0) return
    const activityChanged = this.#activity !== activity
    this.#activity = activity
    this.#facing = facing
    if (activityChanged) this.#elapsed = 0
    const frames = resolveClipFrames(this.#actorSet, activity, facing)
    this.sprite.textures = frames.map((frame) => this.#texture(frame))
    this.sprite.animationSpeed = ACTIVITY_SPEED[activity]
    this.sprite.loop = true
    this.#usesFallback = this.sprite.textures.length < 2
    this.#syncPlayback()
    this.#applyFacingScale()
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.#reducedMotion === reducedMotion) return
    this.#reducedMotion = reducedMotion
    this.#syncPlayback()
  }

  setMotionProfile(motionProfileId: CharacterMotionProfileId): void {
    this.#motionProfileId = motionProfileId
  }

  tick(deltaMs: number): void {
    const safeDelta = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0
    this.#elapsed += safeDelta
    const sample = sampleCharacterMotion(this.#activity, this.#elapsed, {
      reducedMotion: this.#reducedMotion,
      phaseOffset: this.#phaseOffset,
      motionProfileId: this.#motionProfileId,
    })
    this.#applyMotion(sample, this.#usesFallback ? 1 : 0.35)
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

  #syncPlayback(): void {
    if (this.#usesFallback || this.#reducedMotion) {
      this.sprite.gotoAndStop(0)
      return
    }
    this.sprite.play()
  }

  #applyMotion(sample: CharacterMotionSample, strength: number): void {
    const horizontal = this.#facing === 'west' ? -1 : 1
    this.sprite.x = sample.offsetX * strength
    this.sprite.y = sample.offsetY * strength
    this.sprite.rotation = sample.rotation * strength
    this.sprite.alpha = mix(1, sample.alpha, strength)
    this.sprite.scale.set(
      this.#actorSet.scale * horizontal * mix(1, sample.scaleX, strength),
      this.#actorSet.scale * mix(1, sample.scaleY, strength),
    )
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

function mix(from: number, to: number, strength: number): number {
  return from + (to - from) * strength
}
