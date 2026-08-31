import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { describe, expect, it } from 'vitest'

import {
  AvatarBasePackRegistry,
  assemblyPlanFor,
  parseAvatarBasePackManifest,
  type AvatarBasePackManifest,
} from '../src/features/world/avatar/avatar-base-pack.js'
import { parseAvatarRecipe } from '../src/features/world/avatar/avatar-recipe.js'
import { applyAvatarAssembly } from '../src/features/world/avatar/vrm/apply-avatar-assembly.js'

const PACK: AvatarBasePackManifest = {
  schemaVersion: 1,
  id: 'dsh-studio-human-v1',
  version: '1.2.0',
  displayName: 'DSH Studio Human',
  license: 'DSH-Asset-1.0',
  publisher: 'DSH Cyber',
  quality: 'production',
  bases: [
    { baseModel: 'neutral-a', assetUrl: '/assets/avatar-packs/studio/neutral.vrm' },
    { baseModel: 'female-a', assetUrl: '/assets/avatar-packs/studio/female.vrm', cacheKey: 'studio:female' },
  ],
  parts: [
    { id: 'long-layered', kind: 'hair', meshNames: ['Hair_Long'] },
    { id: 'bob', kind: 'hair', meshNames: ['Hair_Bob'] },
    { id: 'professional', kind: 'outfit', meshNames: ['Outfit_Professional'] },
    { id: 'engineer', kind: 'outfit', meshNames: ['Outfit_Engineer'] },
    { id: 'glasses', kind: 'accessory', meshNames: ['Accessory_Glasses'] },
  ],
  materialSlots: [
    { id: 'skin', materialNames: ['AvatarSkin'] },
    { id: 'hair', materialNames: ['AvatarHair'] },
    { id: 'outfit', materialNames: ['AvatarOutfit'] },
    { id: 'accent', materialNames: ['AvatarAccent'] },
  ],
}

describe('Avatar Base Pack contract', () => {
  it('turns a recipe into a shared base download plus cheap identity variants', () => {
    const plan = assemblyPlanFor(PACK, parseAvatarRecipe({
      baseModel: 'female-a',
      hair: 'bob',
      hairColor: '#112233',
      skinTone: '#d9a67f',
      outfit: 'engineer',
      outfitColor: '#334455',
      accentColor: '#66ccff',
      accessoryIds: ['glasses'],
    }))

    expect(plan).toMatchObject({
      source: 'base-pack',
      packId: 'dsh-studio-human-v1',
      packVersion: '1.2.0',
      baseModel: 'female-a',
      assetUrl: '/assets/avatar-packs/studio/female.vrm',
      cacheKey: 'studio:female',
      materialColours: { skin: '#d9a67f', hair: '#112233', outfit: '#334455', accent: '#66ccff' },
    })
    expect(plan.visibleMeshNames).toEqual(['Hair_Bob', 'Outfit_Engineer', 'Accessory_Glasses'])
    expect(plan.managedMeshNames).toContain('Hair_Long')
  })

  it('lets employees share heavy base bytes while keeping different recipes', () => {
    const left = assemblyPlanFor(PACK, parseAvatarRecipe({ baseModel: 'neutral-a', hair: 'long-layered', outfit: 'professional' }))
    const right = assemblyPlanFor(PACK, parseAvatarRecipe({ baseModel: 'neutral-a', hair: 'bob', outfit: 'engineer' }))
    expect(left.cacheKey).toBe(right.cacheKey)
    expect(left.visibleMeshNames).not.toEqual(right.visibleMeshNames)
  })

  it('resolves only production packs automatically and keeps preview packs opt-in', () => {
    const registry = new AvatarBasePackRegistry()
    registry.register({ ...PACK, id: 'preview', version: '9.0.0', quality: 'preview' })
    registry.register(PACK)
    const plan = registry.resolve(parseAvatarRecipe({ baseModel: 'neutral-a', hair: 'bob' }))
    expect(plan?.packId).toBe(PACK.id)
  })

  it('selects the newest compatible production version inside a preferred pack', () => {
    const registry = new AvatarBasePackRegistry()
    registry.register({ ...PACK, version: '1.1.0' })
    registry.register(PACK)
    const plan = registry.resolve(parseAvatarRecipe({ baseModel: 'female-a' }), PACK.id)
    expect(plan?.packVersion).toBe('1.2.0')
  })

  it('rejects remote schemes that could turn profile data into executable or exfiltrating URLs', () => {
    expect(() => parseAvatarBasePackManifest({
      ...PACK,
      bases: [{ baseModel: 'neutral-a', assetUrl: 'javascript:alert(1)' }],
    })).toThrow(/站内绝对路径或 HTTPS/u)
    expect(() => parseAvatarBasePackManifest({
      ...PACK,
      bases: [{ baseModel: 'neutral-a', assetUrl: '//evil.example/model.vrm' }],
    })).toThrow(/站内绝对路径或 HTTPS/u)
  })

  it('applies named mesh variants and material slots without touching unrelated surfaces', () => {
    const root = new Group()
    const hairLong = mesh('Hair_Long', 'AvatarHair')
    const hairBob = mesh('Hair_Bob', 'AvatarHair')
    const outfitPro = mesh('Outfit_Professional', 'AvatarOutfit')
    const outfitEngineer = mesh('Outfit_Engineer', 'AvatarOutfit')
    const glasses = mesh('Accessory_Glasses', 'AvatarAccent')
    const unrelated = mesh('FaceDetails', 'UnmanagedMaterial')
    root.add(hairLong, hairBob, outfitPro, outfitEngineer, glasses, unrelated)

    const plan = assemblyPlanFor(PACK, parseAvatarRecipe({
      baseModel: 'neutral-a', hair: 'bob', hairColor: '#123456', outfit: 'engineer', outfitColor: '#654321', accessoryIds: ['glasses'], accentColor: '#abcdef',
    }))
    applyAvatarAssembly(root, PACK, plan)

    expect(hairLong.visible).toBe(false)
    expect(outfitPro.visible).toBe(false)
    expect(hairBob.visible).toBe(true)
    expect(outfitEngineer.visible).toBe(true)
    expect(glasses.visible).toBe(true)
    expect(unrelated.visible).toBe(true)
    expect((hairBob.material as MeshStandardMaterial).color.getHexString()).toBe('123456')
    expect((outfitEngineer.material as MeshStandardMaterial).color.getHexString()).toBe('654321')
    expect((glasses.material as MeshStandardMaterial).color.getHexString()).toBe('abcdef')
    expect((unrelated.material as MeshStandardMaterial).color.getHexString()).toBe('ffffff')

    root.traverse((object) => {
      const candidate = object as Mesh
      candidate.geometry?.dispose()
      const materials = Array.isArray(candidate.material) ? candidate.material : candidate.material === undefined ? [] : [candidate.material]
      for (const material of materials) material.dispose()
    })
  })
})

function mesh(name: string, materialName: string): Mesh {
  const material = new MeshStandardMaterial()
  material.name = materialName
  const result = new Mesh(new BoxGeometry(1, 1, 1), material)
  result.name = name
  return result
}
