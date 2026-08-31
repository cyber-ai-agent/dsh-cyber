import { describe, expect, it } from 'vitest'

import { CharacterAvatarCreationProviderRegistry, localProceduralAvatarProvider } from '../src/features/world/avatar/avatar-creation-provider.js'
import { createProceduralVrm } from '../src/features/world/avatar/procedural-vrm.js'

const REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
] as const

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
    expect(professional.nodes.find((node) => node.name === 'chestVisual')?.scale).not.toEqual(future.nodes.find((node) => node.name === 'chestVisual')?.scale)
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
})

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
