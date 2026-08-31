import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Group, Object3D } from 'three'
import { describe, expect, it } from 'vitest'

import { DEFAULT_MOTION_LIBRARY, DSH_BASIC_MOTION_PACK } from '../src/features/world/avatar/motion/MotionLibrary.js'
import { declaredMotionSources, loadMotionClips, motionShareCount } from '../src/features/world/avatar/motion/load-motion-clips.js'
import { VrmAnimationController } from '../src/features/world/avatar/vrm/VrmAnimationController.js'

describe('bundled motion pack contract', () => {
  it('declares the authored humanoid V2 motions with an explicit redistributable license', () => {
    expect(DSH_BASIC_MOTION_PACK.version).toBe('2.0.0')
    expect(DSH_BASIC_MOTION_PACK.license).toBe('MIT')
    expect(DSH_BASIC_MOTION_PACK.source).toBe('DSH Cyber')
    expect(DSH_BASIC_MOTION_PACK.format).toBe('humanoid-gltf')
    expect(DSH_BASIC_MOTION_PACK.assets.map((asset) => asset.name)).toEqual([
      'idle', 'walk', 'talk', 'listen', 'thinking', 'typing', 'present', 'hold', 'failed',
    ])
    expect(DSH_BASIC_MOTION_PACK.assets.every((asset) => asset.license === 'MIT' && asset.url.startsWith('/assets/motions/'))).toBe(true)
  })

  it('connects every runtime gesture to a distinct appropriate named clip', () => {
    const sources = declaredMotionSources(DEFAULT_MOTION_LIBRARY)
    expect(sources).toHaveLength(7)
    expect(sources.map((source) => source.animationName)).toEqual(['idle', 'walk', 'listen', 'talk', 'present', 'hold', 'failed'])
    expect(sources.every((source) => source.url === '/assets/motions/dsh-basic.gltf')).toBe(true)
  })

  it('ships a parseable multi-bone glTF animation document instead of a root bob', () => {
    const path = motionPath()
    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      asset?: { version?: string; generator?: string }
      nodes?: Array<{ name?: string }>
      animations?: Array<{ name?: string; channels?: unknown[] }>
    }
    expect(document.asset).toMatchObject({ version: '2.0', generator: 'DSH Cyber Humanoid Motion Pack v2' })
    expect(document.animations?.map((animation) => animation.name)).toEqual([
      'idle', 'walk', 'talk', 'listen', 'thinking', 'typing', 'present', 'hold', 'failed',
    ])
    expect(document.nodes?.filter((node) => node.name?.startsWith('dsh-bone-')).length).toBeGreaterThanOrEqual(15)
    expect(document.animations?.find((animation) => animation.name === 'walk')?.channels?.length).toBeGreaterThanOrEqual(8)
  })

  it('loads the bundled clips through Three GLTFLoader', async () => {
    const source = readFileSync(motionPath())
    const bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const document = await new GLTFLoader().parseAsync(bytes, '/assets/motions/')
    expect(document.animations.map((animation) => animation.name)).toEqual([
      'idle', 'walk', 'talk', 'listen', 'thinking', 'typing', 'present', 'hold', 'failed',
    ])
    expect(document.animations.find((animation) => animation.name === 'walk')?.tracks.length).toBeGreaterThanOrEqual(8)
  })

  it('retargets semantic source bones onto the target VRM normalized bone UUIDs', async () => {
    const source = readFileSync(motionPath(), 'utf8')
    const target = targetVrm()
    const result = await loadMotionClips(target.vrm, [{
      gesture: 'walk',
      url: `data:model/gltf+json,${encodeURIComponent(source)}`,
      animationName: 'walk',
    }])
    try {
      expect(result.failures).toEqual([])
      expect(result.clips).toHaveLength(1)
      const tracks = result.clips[0]!.clip.tracks
      expect(tracks.length).toBeGreaterThanOrEqual(8)
      expect(tracks.every((track) => !track.name.includes('dsh-bone-'))).toBe(true)
      expect(tracks.some((track) => track.name.startsWith(target.nodes.leftUpperLeg.uuid))).toBe(true)
      expect(tracks.some((track) => track.name.startsWith(target.nodes.rightUpperLeg.uuid))).toBe(true)
      expect(tracks.some((track) => track.name.startsWith(target.nodes.leftUpperArm.uuid))).toBe(true)
    } finally {
      result.release()
    }
  })

  it('binds a retargeted walk clip in AnimationMixer and actually rotates the target leg', async () => {
    const source = readFileSync(motionPath(), 'utf8')
    const target = targetVrm()
    const root = new Group()
    for (const node of Object.values(target.nodes)) root.add(node)
    const result = await loadMotionClips(target.vrm, [{
      gesture: 'walk',
      url: `data:model/gltf+json,${encodeURIComponent(source)}`,
      animationName: 'walk',
    }])
    const controller = new VrmAnimationController(root)
    try {
      const clip = result.clips[0]?.clip
      expect(clip).toBeDefined()
      controller.register('walk', clip!)
      controller.setGesture('walk')
      controller.update(0.25)
      expect(Math.abs(target.nodes.leftUpperLeg.quaternion.x)).toBeGreaterThan(0.01)
      expect(Math.abs(target.nodes.rightUpperLeg.quaternion.x)).toBeGreaterThan(0.01)
    } finally {
      controller.dispose()
      result.release()
    }
  })

  it('shares one downloaded motion file across actors and releases it at zero users', async () => {
    const source = readFileSync(motionPath(), 'utf8')
    const url = `data:model/gltf+json,${encodeURIComponent(source)}`
    const first = loadMotionClips(targetVrm().vrm, [{ gesture: 'breathe', url, animationName: 'idle' }])
    const second = loadMotionClips(targetVrm().vrm, [{ gesture: 'listen', url, animationName: 'listen' }])
    const [left, right] = await Promise.all([first, second])
    expect(motionShareCount(url)).toBe(2)
    left.release()
    expect(motionShareCount(url)).toBe(1)
    right.release()
    expect(motionShareCount(url)).toBe(0)
  })
})

function motionPath(): string {
  return join(process.cwd(), 'packages', 'web', 'public', 'assets', 'motions', 'dsh-basic.gltf')
}

function targetVrm() {
  const names = [
    'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
    'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ] as const
  const nodes = Object.fromEntries(names.map((name) => [name, new Object3D()])) as Record<(typeof names)[number], Object3D>
  return {
    nodes,
    vrm: {
      humanoid: {
        getNormalizedBoneNode(name: string) {
          return nodes[name as keyof typeof nodes] ?? null
        },
      },
    },
  }
}
