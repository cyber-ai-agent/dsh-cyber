import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_MOTION_LIBRARY, DSH_BASIC_MOTION_PACK } from '../src/features/world/avatar/motion/MotionLibrary.js'
import { declaredMotionSources, loadMotionClips } from '../src/features/world/avatar/motion/load-motion-clips.js'

describe('bundled motion pack contract', () => {
  it('declares all baseline motions with an explicit redistributable license', () => {
    expect(DSH_BASIC_MOTION_PACK.license).toBe('MIT')
    expect(DSH_BASIC_MOTION_PACK.source).toBe('DSH Cyber')
    expect(DSH_BASIC_MOTION_PACK.assets.map((asset) => asset.name)).toEqual(['idle', 'walk', 'talk', 'listen', 'thinking', 'typing'])
    expect(DSH_BASIC_MOTION_PACK.assets.every((asset) => asset.license === 'MIT' && asset.url.startsWith('/assets/motions/'))).toBe(true)
  })

  it('connects every runtime gesture to a named clip', () => {
    const sources = declaredMotionSources(DEFAULT_MOTION_LIBRARY)
    expect(sources).toHaveLength(7)
    expect(sources.map((source) => source.animationName)).toEqual(['idle', 'walk', 'listen', 'talk', 'talk', 'typing', 'thinking'])
    expect(sources.every((source) => source.url === '/assets/motions/dsh-basic.gltf')).toBe(true)
  })

  it('ships a parseable glTF animation document instead of a placeholder URL', () => {
    const path = join(process.cwd(), 'packages', 'web', 'public', 'assets', 'motions', 'dsh-basic.gltf')
    const document = JSON.parse(readFileSync(path, 'utf8')) as { asset?: { version?: string }; animations?: Array<{ name?: string }> }
    expect(document.asset?.version).toBe('2.0')
    expect(document.animations?.map((animation) => animation.name)).toEqual(['idle', 'walk', 'talk', 'listen', 'thinking', 'typing'])
  })

  it('loads the bundled clips through Three GLTFLoader', async () => {
    const path = join(process.cwd(), 'packages', 'web', 'public', 'assets', 'motions', 'dsh-basic.gltf')
    const source = readFileSync(path)
    const bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const document = await new GLTFLoader().parseAsync(bytes, '/assets/motions/')
    expect(document.animations.map((animation) => animation.name)).toEqual(['idle', 'walk', 'talk', 'listen', 'thinking', 'typing'])
  })

  it('retargets a bundled self-authored clip through the motion loader', async () => {
    const path = join(process.cwd(), 'packages', 'web', 'public', 'assets', 'motions', 'dsh-basic.gltf')
    const source = readFileSync(path, 'utf8')
    const result = await loadMotionClips({}, [{ gesture: 'breathe', url: `data:model/gltf+json,${encodeURIComponent(source)}`, animationName: 'idle' }])
    expect(result.failures).toEqual([])
    expect(result.clips).toHaveLength(1)
    expect(result.clips[0]?.clip.name).toBe('idle')
    expect(result.clips[0]?.clip.tracks[0]?.name.startsWith('.')).toBe(true)
  })
})
