import { describe, expect, it } from 'vitest'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'

import { interactiveVrmFixture } from '../../../e2e/vrm-test-fixture.js'
import { VrmBlinkController } from '../src/features/world/avatar/vrm/VrmBlinkController.js'
import { VrmExpressionController } from '../src/features/world/avatar/vrm/VrmExpressionController.js'
import { VrmLookAtController } from '../src/features/world/avatar/vrm/VrmLookAtController.js'
import { VrmMotionController } from '../src/features/world/avatar/vrm/VrmMotionController.js'
import { disposeVrmScene } from '../src/features/world/avatar/vrm/VrmResourceManager.js'
import { VrmSpeechController } from '../src/features/world/avatar/vrm/VrmSpeechController.js'

describe('VRM runtime asset contract', () => {
  it('loads the accepted VRM 1 fixture and drives its runtime controllers', async () => {
    Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis })
    const source = interactiveVrmFixture()
    const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await new Promise<Awaited<ReturnType<typeof loader.parseAsync>>>((resolve, reject) => loader.parse(buffer, '', resolve, reject))
    const vrm = gltf.userData.vrm as import('@pixiv/three-vrm').VRM | undefined
    expect(vrm).toBeDefined()
    expect(vrm?.humanoid?.getNormalizedBoneNode('head')).toBeDefined()

    const motion = new VrmMotionController(vrm!)
    const expression = new VrmExpressionController(vrm!)
    const lookAt = new VrmLookAtController(vrm!)
    const blink = new VrmBlinkController(vrm!)
    const speech = new VrmSpeechController(vrm!)
    motion.setGesture('explain')
    motion.update(1_000, 1 / 30, true)
    expression.update('speaking', 1 / 30)
    lookAt.update('speaking', 1_000, 1 / 30, true)
    blink.update(10_000, true)
    speech.update(1_000, true)
    vrm!.update(1 / 30)

    expect(vrm!.scene.position.y).not.toBeNaN()
    expression.dispose()
    disposeVrmScene(vrm!.scene)
  })
})
