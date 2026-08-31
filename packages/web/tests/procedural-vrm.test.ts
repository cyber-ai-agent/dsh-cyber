import { afterEach, describe, expect, it, vi } from 'vitest'

import { CharacterAvatarCreationProviderRegistry, localProceduralAvatarProvider } from '../src/features/world/avatar/avatar-creation-provider.js'
import { avatarRecipeForCharacter } from '../src/features/world/avatar/avatar-recipe.js'
import { LOCAL_IDENTITY_RECIPE_AVATAR_AUTHOR, LOCAL_IDENTITY_RECIPE_REFERENCE } from '../src/features/world/avatar/avatar-origin.js'
import { createIdentityProceduralVrm, createProceduralVrm } from '../src/features/world/avatar/procedural-vrm.js'

const REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
] as const
const originalWorker = globalThis.Worker

afterEach(() => {
  vi.useRealTimers()
  if (originalWorker === undefined) Reflect.deleteProperty(globalThis, 'Worker')
  else Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker })
  SilentWorker.instances.length = 0
  CapturingWorker.instances.length = 0
})

describe('procedural VRM creator', () => {
  it('creates a self-contained VRM 1.0 humanoid that the avatar service can validate', () => {
    const buffer = createProceduralVrm('测试角色', { style: 'professional', build: 'balanced', tone: 'neutral' })
    const document = readDocument(buffer)

    expect(buffer.byteLength).toBeGreaterThan(1_000)
    expect(buffer.byteLength).toBeLessThan(20 * 1024 * 1024)
    expect(document.asset).toMatchObject({ version: '2.0', generator: 'DSH Cyber 本机 3D 形象创建器' })
    expect(document.buffers).toEqual([{ byteLength: expect.any(Number) }])
    expect(document.meshes.length).toBeGreaterThan(0)
    expect(renderedTriangleCount(document)).toBeLessThan(5_000)
    expect(document.extensionsUsed).toContain('VRMC_vrm')
    expect(document.extensions.VRMC_vrm).toMatchObject({
      specVersion: '1.0',
      meta: { name: '测试角色 3D 形象', authors: ['DSH Cyber 本机创建器'] },
    })
    const humanBones = document.extensions.VRMC_vrm.humanoid.humanBones as Record<string, { node: number }>
    const requiredNodes = REQUIRED_BONES.map((name) => humanBones[name]?.node)
    expect(requiredNodes.every((node) => Number.isInteger(node) && node! >= 0 && node! < document.nodes.length)).toBe(true)
    expect(new Set(requiredNodes).size).toBe(REQUIRED_BONES.length)
  })

  it('encodes selected style, build and skin tone into different local assets', () => {
    const professional = readDocument(createProceduralVrm('角色', { style: 'professional', build: 'slender', tone: 'warm' }))
    const future = readDocument(createProceduralVrm('角色', { style: 'future', build: 'sturdy', tone: 'deep' }))

    expect(professional.materials[0].pbrMetallicRoughness.baseColorFactor).not.toEqual(future.materials[0].pbrMetallicRoughness.baseColorFactor)
    expect(professional.materials[1].pbrMetallicRoughness.baseColorFactor).not.toEqual(future.materials[1].pbrMetallicRoughness.baseColorFactor)
    expect(professional.nodes.find((node: any) => node.name === 'chestVisual')?.scale).not.toEqual(future.nodes.find((node: any) => node.name === 'chestVisual')?.scale)
  })

  it('turns the 2D identity seed into visibly distinct matching 3D drafts', () => {
    const violetRecipe = avatarRecipeForCharacter({ employeeId: 'violet', gender: 'female', fallbackAvatarIndex: 0 })
    const cyanRecipe = avatarRecipeForCharacter({ employeeId: 'cyan', gender: 'male', fallbackAvatarIndex: 5 })
    const violet = readDocument(createIdentityProceduralVrm('紫色角色', violetRecipe, { style: 'professional', build: 'slender', tone: 'warm' }))
    const cyan = readDocument(createIdentityProceduralVrm('青色角色', cyanRecipe, { style: 'future', build: 'sturdy', tone: 'deep' }))

    expect(violet.asset.generator).toBe('DSH Cyber 身份配方 3D 形象创建器')
    expect(violet.extensions.VRMC_vrm.meta.authors).toEqual([LOCAL_IDENTITY_RECIPE_AVATAR_AUTHOR])
    expect(violet.extensions.VRMC_vrm.meta.references).toContain(LOCAL_IDENTITY_RECIPE_REFERENCE)
    expect(violet.materials[1].pbrMetallicRoughness.baseColorFactor).not.toEqual(cyan.materials[1].pbrMetallicRoughness.baseColorFactor)
    expect(violet.materials[4].pbrMetallicRoughness.baseColorFactor).not.toEqual(cyan.materials[4].pbrMetallicRoughness.baseColorFactor)
    expect(violet.nodes.some((node: any) => node.name === 'hairLeftLayer')).toBe(true)
    expect(cyan.nodes.some((node: any) => node.name === 'hairLeftLayer')).toBe(false)
    expect(violet.nodes.find((node: any) => node.name === 'chestVisual')?.scale).not.toEqual(cyan.nodes.find((node: any) => node.name === 'chestVisual')?.scale)
  })

  it('adds recipe accessories as geometry rather than silently ignoring identity trim', () => {
    const document = readDocument(createIdentityProceduralVrm('眼镜角色', {
      schemaVersion: 1,
      baseModel: 'female-a',
      build: 'balanced',
      hair: 'bob',
      hairColor: '#334455',
      outfitColor: '#556677',
      accentColor: '#778899',
      accessoryIds: ['glasses', 'badge'],
    }, { style: 'professional', build: 'balanced', tone: 'neutral' }))

    expect(document.nodes.some((node: any) => node.name === 'glassesLeft')).toBe(true)
    expect(document.nodes.some((node: any) => node.name === 'identityBadge')).toBe(true)
  })

  it('keeps generation behind a provider contract and reports deterministic phases', async () => {
    const phases: string[] = []
    const result = await localProceduralAvatarProvider.create({
      displayName: '测试/角色',
      design: { style: 'casual', build: 'balanced', tone: 'warm' },
    }, { onPhase: (phase) => phases.push(phase) })

    expect(localProceduralAvatarProvider.source).toBe('local')
    expect(result).toMatchObject({ providerId: 'dsh.local-procedural-vrm-v1', source: 'local' })
    expect(result.file.name).toBe('测试-角色-本机创建.vrm')
    expect(result.file.type).toBe('model/gltf-binary')
    expect(result.file.size).toBeGreaterThan(1_000)
    expect(phases).toEqual(['generating', 'packaging'])
  })

  it('uses identity metadata when the provider is given a character recipe', async () => {
    const recipe = avatarRecipeForCharacter({ employeeId: 'employee-a', gender: 'female', fallbackAvatarIndex: 0 })
    const result = await localProceduralAvatarProvider.create({
      displayName: '身份角色',
      design: { style: 'professional', build: 'balanced', tone: 'warm' },
      identityRecipe: recipe,
    })
    const document = readDocument(await result.file.arrayBuffer())
    expect(document.extensions.VRMC_vrm.meta.authors).toEqual([LOCAL_IDENTITY_RECIPE_AVATAR_AUTHOR])
  })

  it('forwards the identity recipe through the Worker message', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: CapturingWorker })
    const recipe = avatarRecipeForCharacter({ employeeId: 'employee-worker', fallbackAvatarIndex: 3 })
    const creation = localProceduralAvatarProvider.create({
      displayName: 'Worker 角色',
      design: { style: 'casual', build: 'balanced', tone: 'neutral' },
      identityRecipe: recipe,
    })
    await Promise.resolve()
    const worker = CapturingWorker.instances[0]!
    expect(worker.lastMessage).toMatchObject({ displayName: 'Worker 角色', identityRecipe: recipe })
    worker.respondWith(new ArrayBuffer(1_024))
    await expect(creation).resolves.toMatchObject({ source: 'local' })
  })

  it('rejects duplicate provider registrations instead of silently replacing behavior', () => {
    const registry = new CharacterAvatarCreationProviderRegistry()
    registry.register(localProceduralAvatarProvider)
    expect(() => registry.register(localProceduralAvatarProvider)).toThrow(/Provider 重复注册/u)
    expect(registry.require(localProceduralAvatarProvider.id)).toBe(localProceduralAvatarProvider)
  })

  it('honors cancellation before starting local generation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(localProceduralAvatarProvider.create({
      displayName: '取消角色',
      design: { style: 'professional', build: 'balanced', tone: 'neutral' },
    }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('terminates an active Worker once and removes its abort listener', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: SilentWorker })
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const creation = localProceduralAvatarProvider.create({
      displayName: '中止角色',
      design: { style: 'future', build: 'balanced', tone: 'neutral' },
    }, { signal: controller.signal })

    controller.abort()

    await expect(creation).rejects.toMatchObject({ name: 'AbortError' })
    expect(SilentWorker.instances).toHaveLength(1)
    expect(SilentWorker.instances[0]!.terminateCount).toBe(1)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('terminates and rejects a Worker that exceeds the generation deadline', async () => {
    vi.useFakeTimers()
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: SilentWorker })
    const creation = localProceduralAvatarProvider.create({
      displayName: '超时角色',
      design: { style: 'professional', build: 'sturdy', tone: 'deep' },
    })
    const rejection = expect(creation).rejects.toThrow('3D 形象生成超时，请重试')

    await vi.advanceTimersByTimeAsync(20_000)

    await rejection
    expect(SilentWorker.instances).toHaveLength(1)
    expect(SilentWorker.instances[0]!.terminateCount).toBe(1)
  })
})

class SilentWorker {
  static readonly instances: SilentWorker[] = []
  onerror: ((event: ErrorEvent) => unknown) | null = null
  onmessage: ((event: MessageEvent) => unknown) | null = null
  terminateCount = 0

  constructor(_url: string | URL, _options?: WorkerOptions) {
    SilentWorker.instances.push(this)
  }

  postMessage(_message: unknown): void {}

  terminate(): void {
    this.terminateCount += 1
  }
}

class CapturingWorker {
  static readonly instances: CapturingWorker[] = []
  onerror: ((event: ErrorEvent) => unknown) | null = null
  onmessage: ((event: MessageEvent<any>) => unknown) | null = null
  lastMessage: any

  constructor(_url: string | URL, _options?: WorkerOptions) {
    CapturingWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.lastMessage = message
  }

  respondWith(buffer: ArrayBuffer): void {
    this.onmessage?.({ data: { requestId: this.lastMessage.requestId, ok: true, buffer } } as MessageEvent)
  }

  terminate(): void {}
}

function readDocument(buffer: ArrayBuffer): any {
  const view = new DataView(buffer)
  expect(view.getUint32(0, true)).toBe(0x46546c67)
  expect(view.getUint32(4, true)).toBe(2)
  expect(view.getUint32(8, true)).toBe(buffer.byteLength)
  const jsonLength = view.getUint32(12, true)
  expect(view.getUint32(16, true)).toBe(0x4e4f534a)
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)).trim())
}

function renderedTriangleCount(document: any): number {
  return document.nodes.reduce((total: number, node: { mesh?: number }) => {
    if (node.mesh === undefined) return total
    const mesh = document.meshes[node.mesh]
    return total + mesh.primitives.reduce((meshTotal: number, primitive: { indices: number }) => meshTotal + document.accessors[primitive.indices].count / 3, 0)
  }, 0)
}
