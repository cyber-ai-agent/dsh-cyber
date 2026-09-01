import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { describe, expect, it } from 'vitest'

import {
  assemblyPlanFor,
  type AvatarBasePackManifest,
} from '../src/features/world/avatar/avatar-base-pack.js'
import {
  avatarPackIdentityMatch,
  bestAvatarPackMatch,
  resolveCharacterAvatarRepresentation,
} from '../src/features/world/avatar/avatar-representation.js'
import { parseAvatarRecipe } from '../src/features/world/avatar/avatar-recipe.js'
import { applyAvatarAssembly } from '../src/features/world/avatar/vrm/apply-avatar-assembly.js'

const OFFICE_PACK: AvatarBasePackManifest = {
  schemaVersion: 1,
  id: 'official-avatar-base-v1',
  version: '1.1.0',
  displayName: 'Official Avatar Base · CC0 V1.1',
  license: 'CC0-1.0',
  publisher: 'DSH Cyber',
  quality: 'production',
  bases: [{ baseModel: 'neutral-a', assetUrl: '/api/worlds/test/avatar-base-packs/official-avatar-base-v1/1.1.0/assets/models/neutral.vrm' }],
  parts: [
    { id: 'long-layered', kind: 'hair', meshNames: ['Hair_Long'] },
    { id: 'side-part', kind: 'hair', meshNames: ['Hair_SidePart'] },
    { id: 'tech-crop', kind: 'hair', meshNames: ['Hair_TechCrop'] },
    { id: 'casual', kind: 'outfit', meshNames: ['Outfit_Casual_0'] },
    {
      id: 'professional',
      kind: 'outfit',
      meshNames: ['Outfit_Casual_0', 'Outfit_Professional_Legs', 'Outfit_Professional_Feet', 'Outfit_Professional_Body'],
    },
    {
      id: 'analyst',
      kind: 'outfit',
      meshNames: ['Outfit_Casual_0', 'Outfit_Professional_Legs', 'Outfit_Professional_Feet', 'Outfit_Professional_Body'],
    },
  ],
  materialSlots: [
    { id: 'hair', materialNames: ['DSH_Hair'] },
    { id: 'outfit', materialNames: ['DSH_Office_Outfit'] },
    { id: 'accent', materialNames: ['DSH_Office_Accent'] },
  ],
}

const PROFESSIONAL = parseAvatarRecipe({
  baseModel: 'neutral-a',
  hair: 'long-layered',
  hairColor: '#7c3aed',
  skinTone: '#d9a67f',
  outfit: 'professional',
  outfitColor: '#4338ca',
  accentColor: '#c4b5fd',
})

describe('official office outfit identity coverage', () => {
  it('makes neutral professional and analyst identities eligible without inventing engineer coverage', () => {
    const professional = avatarPackIdentityMatch(OFFICE_PACK, PROFESSIONAL)
    expect(professional.eligible).toBe(true)
    expect(professional.criticalMissing).toEqual([])
    expect(professional.plan.visibleMeshNames).toEqual(expect.arrayContaining([
      'Hair_Long',
      'Outfit_Casual_0',
      'Outfit_Professional_Legs',
      'Outfit_Professional_Feet',
      'Outfit_Professional_Body',
    ]))

    const analyst = avatarPackIdentityMatch(OFFICE_PACK, parseAvatarRecipe({ ...PROFESSIONAL, outfit: 'analyst' }))
    expect(analyst.eligible).toBe(true)
    expect(analyst.criticalMissing).toEqual([])

    const engineer = avatarPackIdentityMatch(OFFICE_PACK, parseAvatarRecipe({ ...PROFESSIONAL, outfit: 'engineer' }))
    expect(engineer.eligible).toBe(false)
    expect(engineer.criticalMissing).toEqual(['outfit:engineer'])
  })

  it('still refuses unsupported hair and explicit gendered bases instead of showing a better-looking stranger', () => {
    const unsupportedHair = avatarPackIdentityMatch(OFFICE_PACK, parseAvatarRecipe({ ...PROFESSIONAL, hair: 'bob' }))
    expect(unsupportedHair.eligible).toBe(false)
    expect(unsupportedHair.criticalMissing).toEqual(['hair:bob'])

    expect(bestAvatarPackMatch(parseAvatarRecipe({ ...PROFESSIONAL, baseModel: 'male-a' }), [OFFICE_PACK])).toBeUndefined()
    expect(bestAvatarPackMatch(parseAvatarRecipe({ ...PROFESSIONAL, baseModel: 'female-a' }), [OFFICE_PACK])).toBeUndefined()

    expect(resolveCharacterAvatarRepresentation({
      employeeId: 'male-manager',
      role: 'manager',
      gender: 'male',
      fallbackAvatarIndex: 0,
    }, [OFFICE_PACK])).toBeUndefined()
  })

  it('keeps the Base identity visible under formal clothing and only recolours managed suit materials', () => {
    const professionalRoot = sceneFixture()
    const plan = assemblyPlanFor(OFFICE_PACK, PROFESSIONAL)
    applyAvatarAssembly(professionalRoot.root, OFFICE_PACK, plan)

    expect(professionalRoot.base.visible).toBe(true)
    expect(professionalRoot.legs.visible).toBe(true)
    expect(professionalRoot.feet.visible).toBe(true)
    expect(professionalRoot.body.visible).toBe(true)
    expect(professionalRoot.hair.visible).toBe(true)
    expect((professionalRoot.body.material as MeshStandardMaterial).color.getHexString()).toBe('4338ca')
    expect((professionalRoot.tie.material as MeshStandardMaterial).color.getHexString()).toBe('c4b5fd')
    expect((professionalRoot.base.material as MeshStandardMaterial).color.getHexString()).toBe('ffffff')
    disposeScene(professionalRoot.root)

    const casualRoot = sceneFixture()
    applyAvatarAssembly(casualRoot.root, OFFICE_PACK, assemblyPlanFor(OFFICE_PACK, parseAvatarRecipe({
      ...PROFESSIONAL,
      outfit: 'casual',
    })))
    expect(casualRoot.base.visible).toBe(true)
    expect(casualRoot.legs.visible).toBe(false)
    expect(casualRoot.feet.visible).toBe(false)
    expect(casualRoot.body.visible).toBe(false)
    disposeScene(casualRoot.root)
  })
})

function sceneFixture() {
  const root = new Group()
  const base = mesh('Outfit_Casual_0', 'BaseIdentity')
  const legs = mesh('Outfit_Professional_Legs', 'DSH_Office_Outfit')
  const feet = mesh('Outfit_Professional_Feet', 'DSH_Office_Shoes')
  const body = mesh('Outfit_Professional_Body', 'DSH_Office_Outfit')
  const tie = mesh('ProfessionalTieSurface', 'DSH_Office_Accent')
  body.add(tie)
  const hair = mesh('Hair_Long', 'DSH_Hair')
  const otherHair = mesh('Hair_SidePart', 'DSH_Hair')
  root.add(base, legs, feet, body, hair, otherHair)
  return { root, base, legs, feet, body, tie, hair }
}

function mesh(name: string, materialName: string): Mesh {
  const material = new MeshStandardMaterial()
  material.name = materialName
  const result = new Mesh(new BoxGeometry(1, 1, 1), material)
  result.name = name
  return result
}

function disposeScene(root: Group): void {
  root.traverse((object) => {
    const candidate = object as Mesh
    candidate.geometry?.dispose()
    const materials = Array.isArray(candidate.material) ? candidate.material : candidate.material === undefined ? [] : [candidate.material]
    for (const material of materials) material.dispose()
  })
}
