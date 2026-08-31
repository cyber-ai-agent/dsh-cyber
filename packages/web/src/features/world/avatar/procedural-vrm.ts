import {
  parseAvatarRecipe,
  type AvatarBaseModel,
  type AvatarBuild,
  type AvatarRecipe,
} from './avatar-recipe.js'
import {
  LOCAL_IDENTITY_RECIPE_AVATAR_AUTHOR,
  LOCAL_IDENTITY_RECIPE_REFERENCE,
  LOCAL_PROCEDURAL_AVATAR_AUTHOR,
} from './avatar-origin.js'

export type ProceduralAvatarStyle = 'professional' | 'casual' | 'future'
export type ProceduralAvatarBuild = AvatarBuild
export type ProceduralAvatarTone = 'warm' | 'neutral' | 'deep'

export interface ProceduralAvatarDesign {
  style: ProceduralAvatarStyle
  build: ProceduralAvatarBuild
  tone: ProceduralAvatarTone
}

interface GeometryData {
  positions: number[]
  normals: number[]
  indices: number[]
}

interface GeometryReference {
  position: number
  normal: number
  indices: number
}

interface GltfNode {
  name: string
  children?: number[]
  mesh?: number
  translation?: number[]
  rotation?: number[]
  scale?: number[]
}

interface BuildMetrics {
  shoulder: number
  torso: number
  hips: number
  limb: number
}

const BUILD_METRICS: Record<AvatarBuild, BuildMetrics> = {
  slender: { shoulder: 0.92, torso: 0.88, hips: 0.9, limb: 0.86 },
  balanced: { shoulder: 1, torso: 1, hips: 1, limb: 1 },
  sturdy: { shoulder: 1.1, torso: 1.12, hips: 1.08, limb: 1.14 },
}

const BASE_METRICS: Record<AvatarBaseModel, BuildMetrics> = {
  'male-a': { shoulder: 1.08, torso: 1.04, hips: 0.96, limb: 1.02 },
  'female-a': { shoulder: 0.96, torso: 0.98, hips: 1.07, limb: 0.96 },
  'neutral-a': { shoulder: 1, torso: 1, hips: 1, limb: 1 },
  'robot-a': { shoulder: 1.08, torso: 1.08, hips: 1.02, limb: 1.06 },
}

const STYLE_DEFAULTS: Record<ProceduralAvatarStyle, { hair: string; hairColor: string; outfitColor: string; accentColor: string }> = {
  professional: { hair: 'side-part', hairColor: '#111827', outfitColor: '#1e3a5f', accentColor: '#22b8cf' },
  casual: { hair: 'soft-volume', hairColor: '#552b16', outfitColor: '#1c573f', accentColor: '#d97706' },
  future: { hair: 'tech-crop', hairColor: '#6b7280', outfitColor: '#352b67', accentColor: '#43c5dd' },
}

const TONE_COLOURS: Record<ProceduralAvatarTone, string> = {
  warm: '#d7a17d',
  neutral: '#b97f60',
  deep: '#70462f',
}

/**
 * Legacy generic draft path. It intentionally remains generic so the 3D world
 * can keep preferring a recognisable 2D portrait over an unrelated local mesh.
 */
export function createProceduralVrm(name: string, design: ProceduralAvatarDesign): ArrayBuffer {
  const style = STYLE_DEFAULTS[design.style]
  return createRecipeVrm(name, parseAvatarRecipe({
    baseModel: 'neutral-a',
    build: design.build,
    hair: style.hair,
    hairColor: style.hairColor,
    skinTone: TONE_COLOURS[design.tone],
    outfit: design.style,
    outfitColor: style.outfitColor,
    accentColor: style.accentColor,
  }), false)
}

/**
 * The matching local path. Identity fields survive while the user's creator
 * choices adjust body, skin and outfit family. This lets the inexpensive local
 * generator participate in the real character pipeline instead of producing a
 * disconnected demo model.
 */
export function createIdentityProceduralVrm(
  name: string,
  identityRecipe: AvatarRecipe,
  design: ProceduralAvatarDesign,
): ArrayBuffer {
  return createRecipeVrm(name, applyProceduralDesignToRecipe(identityRecipe, design), true)
}

export function applyProceduralDesignToRecipe(recipe: AvatarRecipe, design: ProceduralAvatarDesign): AvatarRecipe {
  const style = STYLE_DEFAULTS[design.style]
  return parseAvatarRecipe({
    ...recipe,
    build: design.build,
    skinTone: TONE_COLOURS[design.tone],
    outfit: design.style,
    hair: recipe.hair ?? style.hair,
    hairColor: recipe.hairColor ?? style.hairColor,
    outfitColor: recipe.outfitColor ?? style.outfitColor,
    accentColor: recipe.accentColor ?? style.accentColor,
  })
}

function createRecipeVrm(name: string, recipe: AvatarRecipe, identityMatched: boolean): ArrayBuffer {
  const binary: number[] = []
  const bufferViews: Array<Record<string, unknown>> = []
  const accessors: Array<Record<string, unknown>> = []

  const appendBytes = (bytes: Uint8Array, target: number): number => {
    while (binary.length % 4 !== 0) binary.push(0)
    const byteOffset = binary.length
    for (const byte of bytes) binary.push(byte)
    const index = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, target })
    return index
  }

  const addGeometry = (geometry: GeometryData): GeometryReference => {
    const positionView = appendBytes(floatBytes(geometry.positions), 34962)
    const normalView = appendBytes(floatBytes(geometry.normals), 34962)
    const indexView = appendBytes(indexBytes(geometry.indices), 34963)
    const bounds = positionBounds(geometry.positions)
    const position = accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: geometry.positions.length / 3,
      type: 'VEC3',
      min: bounds.min,
      max: bounds.max,
    }) - 1
    const normal = accessors.push({
      bufferView: normalView,
      componentType: 5126,
      count: geometry.normals.length / 3,
      type: 'VEC3',
    }) - 1
    const indices = accessors.push({
      bufferView: indexView,
      componentType: 5123,
      count: geometry.indices.length,
      type: 'SCALAR',
      min: [Math.min(...geometry.indices)],
      max: [Math.max(...geometry.indices)],
    }) - 1
    return { position, normal, indices }
  }

  const box = addGeometry(boxGeometry())
  const cylinder = addGeometry(cylinderGeometry(14))
  const sphere = addGeometry(sphereGeometry(16, 10))
  const build = multiplyMetrics(BUILD_METRICS[recipe.build ?? 'balanced'], BASE_METRICS[recipe.baseModel])
  const outfitColour = colourFactor(recipe.outfitColor, '#1e3a5f')
  const accentColour = colourFactor(recipe.accentColor, '#22b8cf')
  const hairColour = colourFactor(recipe.hairColor, '#111827')
  const skinColour = colourFactor(recipe.skinTone, '#b97f60')
  const materials = [
    material('肤色', skinColour, 0.82, recipe.baseModel === 'robot-a' ? 0.2 : 0),
    material('服装', outfitColour, 0.72, recipe.baseModel === 'robot-a' ? 0.24 : 0.05),
    material('装饰', accentColour, 0.48, 0.16),
    material('下装', darken(outfitColour, 0.52), 0.78, 0.04),
    material('头发', hairColour, 0.76, 0.02),
    material('深色细节', [0.018, 0.024, 0.035, 1], 0.68, 0.06),
  ]
  const meshes: Array<Record<string, unknown>> = []
  const mesh = (meshName: string, geometry: GeometryReference, materialIndex: number): number => meshes.push({
    name: meshName,
    primitives: [{
      attributes: { POSITION: geometry.position, NORMAL: geometry.normal },
      indices: geometry.indices,
      material: materialIndex,
      mode: 4,
    }],
  }) - 1

  const skinSphere = mesh('皮肤球体', sphere, 0)
  const skinCylinder = mesh('皮肤肢体', cylinder, 0)
  const outfitBox = mesh('服装主体', box, 1)
  const outfitCylinder = mesh('服装肢体', cylinder, 1)
  const outfitSphere = mesh('服装关节', sphere, 1)
  const accentBox = mesh('服装装饰', box, 2)
  const trouserCylinder = mesh('下装肢体', cylinder, 3)
  const hairSphere = mesh('头发球体', sphere, 4)
  const hairBox = mesh('头发片层', box, 4)
  const detailSphere = mesh('面部细节', sphere, 5)
  const detailBox = mesh('鞋与细节', box, 5)

  const nodes: GltfNode[] = []
  const addNode = (node: GltfNode, parent?: number): number => {
    const index = nodes.push(node) - 1
    if (parent !== undefined) {
      const parentNode = nodes[parent]!
      parentNode.children = [...(parentNode.children ?? []), index]
    }
    return index
  }
  const addVisual = (parent: number, nodeName: string, meshIndex: number, scale: number[], translation?: number[]): number => addNode({
    name: nodeName,
    mesh: meshIndex,
    scale,
    ...(translation === undefined ? {} : { translation }),
  }, parent)

  const root = addNode({ name: 'DSH_Cyber_Avatar' })
  const hips = addNode({ name: 'hips', translation: [0, 1.02, 0] }, root)
  addVisual(hips, 'hipsVisual', outfitBox, [0.38 * build.hips, 0.16, 0.25])
  const spine = addNode({ name: 'spine', translation: [0, 0.16, 0] }, hips)
  addVisual(spine, 'spineVisual', outfitBox, [0.42 * build.torso, 0.24, 0.24])
  const chest = addNode({ name: 'chest', translation: [0, 0.25, 0] }, spine)
  addVisual(chest, 'chestVisual', outfitBox, [0.5 * build.shoulder, 0.28, 0.25])
  const upperChest = addNode({ name: 'upperChest', translation: [0, 0.2, 0] }, chest)
  const neck = addNode({ name: 'neck', translation: [0, 0.16, 0] }, upperChest)
  addVisual(neck, 'neckVisual', skinCylinder, [0.075, 0.1, 0.075])
  const head = addNode({ name: 'head', translation: [0, 0.12, 0] }, neck)
  addVisual(head, 'headVisual', recipe.baseModel === 'robot-a' ? detailBox : skinSphere, recipe.baseModel === 'robot-a' ? [0.31, 0.36, 0.28] : [0.18, 0.22, 0.18])
  addHair(nodes, addNode, head, recipe.hair ?? 'side-part', hairSphere, hairBox)
  addNode({ name: 'leftEye', mesh: detailSphere, translation: [-0.068, 0.03, 0.17], scale: [0.022, 0.031, 0.016] }, head)
  addNode({ name: 'rightEye', mesh: detailSphere, translation: [0.068, 0.03, 0.17], scale: [0.022, 0.031, 0.016] }, head)
  addNode({ name: 'mouth', mesh: detailBox, translation: [0, -0.06, 0.173], scale: [0.055, 0.011, 0.01] }, head)
  addOutfitDetail(addNode, chest, recipe.outfit ?? 'professional', accentBox)
  addAccessories(addNode, head, chest, recipe.accessoryIds ?? [], detailBox, accentBox)

  const leftUpperLeg = addNode({ name: 'leftUpperLeg', translation: [-0.16 * build.hips, -0.06, 0] }, hips)
  addVisual(leftUpperLeg, 'leftUpperLegVisual', trouserCylinder, [0.105 * build.limb, 0.47, 0.105 * build.limb])
  const leftLowerLeg = addNode({ name: 'leftLowerLeg', translation: [0, -0.47, 0] }, leftUpperLeg)
  addVisual(leftLowerLeg, 'leftLowerLegVisual', trouserCylinder, [0.09 * build.limb, 0.43, 0.09 * build.limb])
  const leftFoot = addNode({ name: 'leftFoot', translation: [0, -0.43, 0] }, leftLowerLeg)
  addVisual(leftFoot, 'leftFootVisual', detailBox, [0.18 * build.limb, 0.1, 0.31], [0, -0.02, 0.08])
  addNode({ name: 'leftToes', translation: [0, 0, 0.15] }, leftFoot)

  const rightUpperLeg = addNode({ name: 'rightUpperLeg', translation: [0.16 * build.hips, -0.06, 0] }, hips)
  addVisual(rightUpperLeg, 'rightUpperLegVisual', trouserCylinder, [0.105 * build.limb, 0.47, 0.105 * build.limb])
  const rightLowerLeg = addNode({ name: 'rightLowerLeg', translation: [0, -0.47, 0] }, rightUpperLeg)
  addVisual(rightLowerLeg, 'rightLowerLegVisual', trouserCylinder, [0.09 * build.limb, 0.43, 0.09 * build.limb])
  const rightFoot = addNode({ name: 'rightFoot', translation: [0, -0.43, 0] }, rightLowerLeg)
  addVisual(rightFoot, 'rightFootVisual', detailBox, [0.18 * build.limb, 0.1, 0.31], [0, -0.02, 0.08])
  addNode({ name: 'rightToes', translation: [0, 0, 0.15] }, rightFoot)

  const leftUpperArm = addNode({ name: 'leftUpperArm', translation: [-0.285 * build.shoulder, 0.12, 0], rotation: [0, 0, -0.05, 0.9987] }, upperChest)
  addVisual(leftUpperArm, 'leftShoulderVisual', outfitSphere, [0.105 * build.limb, 0.105 * build.limb, 0.105 * build.limb])
  addVisual(leftUpperArm, 'leftUpperArmVisual', outfitCylinder, [0.085 * build.limb, 0.38, 0.085 * build.limb])
  const leftLowerArm = addNode({ name: 'leftLowerArm', translation: [0, -0.38, 0] }, leftUpperArm)
  addVisual(leftLowerArm, 'leftLowerArmVisual', skinCylinder, [0.072 * build.limb, 0.34, 0.072 * build.limb])
  const leftHand = addNode({ name: 'leftHand', translation: [0, -0.34, 0] }, leftLowerArm)
  addVisual(leftHand, 'leftHandVisual', skinSphere, [0.065 * build.limb, 0.085, 0.06 * build.limb], [0, -0.015, 0])

  const rightUpperArm = addNode({ name: 'rightUpperArm', translation: [0.285 * build.shoulder, 0.12, 0], rotation: [0, 0, 0.05, 0.9987] }, upperChest)
  addVisual(rightUpperArm, 'rightShoulderVisual', outfitSphere, [0.105 * build.limb, 0.105 * build.limb, 0.105 * build.limb])
  addVisual(rightUpperArm, 'rightUpperArmVisual', outfitCylinder, [0.085 * build.limb, 0.38, 0.085 * build.limb])
  const rightLowerArm = addNode({ name: 'rightLowerArm', translation: [0, -0.38, 0] }, rightUpperArm)
  addVisual(rightLowerArm, 'rightLowerArmVisual', skinCylinder, [0.072 * build.limb, 0.34, 0.072 * build.limb])
  const rightHand = addNode({ name: 'rightHand', translation: [0, -0.34, 0] }, rightLowerArm)
  addVisual(rightHand, 'rightHandVisual', skinSphere, [0.065 * build.limb, 0.085, 0.06 * build.limb], [0, -0.015, 0])

  const boneNames = [
    'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
    'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightUpperArm', 'rightLowerArm', 'rightHand',
  ] as const
  const nodeIndex = new Map(nodes.map((node, index) => [node.name, index]))
  const humanBones = Object.fromEntries(boneNames.map((boneName) => [boneName, { node: nodeIndex.get(boneName)! }]))
  const safeName = name.trim().slice(0, 80) || '本地角色'
  const author = identityMatched ? LOCAL_IDENTITY_RECIPE_AVATAR_AUTHOR : LOCAL_PROCEDURAL_AVATAR_AUTHOR
  const document = {
    asset: { version: '2.0', generator: identityMatched ? 'DSH Cyber 身份配方 3D 形象创建器' : 'DSH Cyber 本机 3D 形象创建器' },
    scene: 0,
    scenes: [{ name: `${safeName} 3D 形象`, nodes: [root] }],
    nodes,
    meshes,
    materials,
    buffers: [{ byteLength: binary.length }],
    bufferViews,
    accessors,
    extensionsUsed: ['VRMC_vrm'],
    extensions: {
      VRMC_vrm: {
        specVersion: '1.0',
        meta: {
          name: `${safeName} 3D 形象`,
          version: '1',
          authors: [author],
          copyrightInformation: '由用户在本机创建',
          contactInformation: '',
          references: identityMatched ? [LOCAL_IDENTITY_RECIPE_REFERENCE] : [],
          thirdPartyLicenses: '',
          avatarPermission: 'onlyAuthor',
          allowExcessivelyViolentUsage: false,
          allowExcessivelySexualUsage: false,
          commercialUsage: 'personalNonProfit',
          allowPoliticalOrReligiousUsage: false,
          allowAntisocialOrHateUsage: false,
          creditNotation: 'unnecessary',
          allowRedistribution: false,
          modification: 'allowModification',
          licenseUrl: 'https://vrm.dev/licenses/1.0/',
        },
        humanoid: { humanBones },
        expressions: { preset: {}, custom: {} },
      },
    },
  }
  return encodeGlb(document, new Uint8Array(binary))
}

function addHair(
  _nodes: GltfNode[],
  addNode: (node: GltfNode, parent?: number) => number,
  head: number,
  style: string,
  sphere: number,
  box: number,
): void {
  const cap = (scale: number[], translation: number[] = [0, 0.115, -0.012]) => addNode({ name: 'hair', mesh: sphere, translation, scale }, head)
  switch (style) {
    case 'bob':
      cap([0.19, 0.12, 0.19])
      addNode({ name: 'hairBack', mesh: sphere, translation: [0, -0.055, -0.055], scale: [0.19, 0.2, 0.16] }, head)
      break
    case 'long-layered':
      cap([0.2, 0.12, 0.2])
      addNode({ name: 'hairLeftLayer', mesh: box, translation: [-0.15, -0.2, -0.06], scale: [0.08, 0.3, 0.08] }, head)
      addNode({ name: 'hairRightLayer', mesh: box, translation: [0.15, -0.2, -0.06], scale: [0.08, 0.3, 0.08] }, head)
      break
    case 'ponytail':
      cap([0.19, 0.11, 0.19])
      addNode({ name: 'hairPonytail', mesh: sphere, translation: [0, -0.08, -0.2], scale: [0.09, 0.2, 0.09] }, head)
      break
    case 'soft-volume':
      cap([0.205, 0.145, 0.2], [0, 0.13, -0.018])
      break
    case 'tech-crop':
      cap([0.185, 0.075, 0.185], [0, 0.14, -0.018])
      break
    case 'side-part':
    default:
      cap([0.19, 0.105, 0.19])
      addNode({ name: 'hairSidePart', mesh: sphere, translation: [-0.075, 0.09, 0.02], scale: [0.115, 0.09, 0.17] }, head)
      break
  }
}

function addOutfitDetail(
  addNode: (node: GltfNode, parent?: number) => number,
  chest: number,
  outfit: string,
  accentBox: number,
): void {
  if (outfit === 'future' || outfit === 'engineer') {
    addNode({ name: 'chestTechPanel', mesh: accentBox, translation: [0, 0.02, 0.255], scale: [0.24, 0.075, 0.018] }, chest)
    addNode({ name: 'chestTechLine', mesh: accentBox, translation: [0, -0.085, 0.257], scale: [0.13, 0.025, 0.018] }, chest)
    return
  }
  if (outfit === 'casual') {
    addNode({ name: 'chestCasualStripe', mesh: accentBox, translation: [0, 0.015, 0.255], scale: [0.31, 0.055, 0.018] }, chest)
    return
  }
  if (outfit === 'analyst') {
    addNode({ name: 'chestAnalystBadge', mesh: accentBox, translation: [0.15, 0.08, 0.257], scale: [0.055, 0.075, 0.018] }, chest)
    addNode({ name: 'chestAnalystLine', mesh: accentBox, translation: [0, -0.06, 0.257], scale: [0.22, 0.025, 0.018] }, chest)
    return
  }
  addNode({ name: 'chestProfessionalAccent', mesh: accentBox, translation: [0, 0.02, 0.255], scale: [0.075, 0.17, 0.018] }, chest)
}

function addAccessories(
  addNode: (node: GltfNode, parent?: number) => number,
  head: number,
  chest: number,
  accessoryIds: readonly string[],
  detailBox: number,
  accentBox: number,
): void {
  if (accessoryIds.includes('glasses')) {
    addNode({ name: 'glassesLeft', mesh: detailBox, translation: [-0.068, 0.035, 0.184], scale: [0.065, 0.045, 0.008] }, head)
    addNode({ name: 'glassesRight', mesh: detailBox, translation: [0.068, 0.035, 0.184], scale: [0.065, 0.045, 0.008] }, head)
    addNode({ name: 'glassesBridge', mesh: detailBox, translation: [0, 0.035, 0.185], scale: [0.035, 0.008, 0.008] }, head)
  }
  if (accessoryIds.includes('badge')) {
    addNode({ name: 'identityBadge', mesh: accentBox, translation: [0.16, 0.085, 0.259], scale: [0.05, 0.065, 0.018] }, chest)
  }
}

function multiplyMetrics(left: BuildMetrics, right: BuildMetrics): BuildMetrics {
  return {
    shoulder: left.shoulder * right.shoulder,
    torso: left.torso * right.torso,
    hips: left.hips * right.hips,
    limb: left.limb * right.limb,
  }
}

function colourFactor(value: string | undefined, fallback: string): number[] {
  const source = /^#[0-9a-f]{6}$/iu.test(value ?? '') ? value! : fallback
  return [
    Number.parseInt(source.slice(1, 3), 16) / 255,
    Number.parseInt(source.slice(3, 5), 16) / 255,
    Number.parseInt(source.slice(5, 7), 16) / 255,
    1,
  ]
}

function darken(colour: number[], factor: number): number[] {
  return [colour[0]! * factor, colour[1]! * factor, colour[2]! * factor, colour[3] ?? 1]
}

function material(name: string, baseColorFactor: number[], roughnessFactor: number, metallicFactor: number): Record<string, unknown> {
  return {
    name,
    pbrMetallicRoughness: { baseColorFactor, roughnessFactor, metallicFactor },
    doubleSided: false,
  }
}

function floatBytes(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer)
}

function indexBytes(values: number[]): Uint8Array {
  return new Uint8Array(new Uint16Array(values).buffer)
}

function positionBounds(values: number[]): { min: number[]; max: number[] } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (let index = 0; index < values.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = values[index + axis]!
      min[axis] = Math.min(min[axis]!, value)
      max[axis] = Math.max(max[axis]!, value)
    }
  }
  return { min, max }
}

function boxGeometry(): GeometryData {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const faces = [
    { normal: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { normal: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { normal: [1, 0, 0], corners: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { normal: [-1, 0, 0], corners: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, 1, 0], corners: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, -1, 0], corners: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  ]
  for (const face of faces) {
    const offset = positions.length / 3
    for (const corner of face.corners) {
      positions.push(...corner)
      normals.push(...face.normal)
    }
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
  }
  return { positions, normals, indices }
}

function cylinderGeometry(segments: number): GeometryData {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (let segment = 0; segment <= segments; segment += 1) {
    const angle = segment / segments * Math.PI * 2
    const x = Math.cos(angle) * 0.5
    const z = Math.sin(angle) * 0.5
    positions.push(x, 0, z, x, -1, z)
    normals.push(Math.cos(angle), 0, Math.sin(angle), Math.cos(angle), 0, Math.sin(angle))
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const top = segment * 2
    indices.push(top, top + 1, top + 2, top + 2, top + 1, top + 3)
  }
  const topCenter = positions.length / 3
  positions.push(0, 0, 0)
  normals.push(0, 1, 0)
  const topRing = positions.length / 3
  for (let segment = 0; segment < segments; segment += 1) {
    const angle = segment / segments * Math.PI * 2
    positions.push(Math.cos(angle) * 0.5, 0, Math.sin(angle) * 0.5)
    normals.push(0, 1, 0)
  }
  const bottomCenter = positions.length / 3
  positions.push(0, -1, 0)
  normals.push(0, -1, 0)
  const bottomRing = positions.length / 3
  for (let segment = 0; segment < segments; segment += 1) {
    const angle = segment / segments * Math.PI * 2
    positions.push(Math.cos(angle) * 0.5, -1, Math.sin(angle) * 0.5)
    normals.push(0, -1, 0)
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments
    indices.push(topCenter, topRing + next, topRing + segment)
    indices.push(bottomCenter, bottomRing + segment, bottomRing + next)
  }
  return { positions, normals, indices }
}

function sphereGeometry(segments: number, rings: number): GeometryData {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (let ring = 0; ring <= rings; ring += 1) {
    const vertical = ring / rings * Math.PI
    const y = Math.cos(vertical)
    const radius = Math.sin(vertical)
    for (let segment = 0; segment <= segments; segment += 1) {
      const horizontal = segment / segments * Math.PI * 2
      const x = radius * Math.cos(horizontal)
      const z = radius * Math.sin(horizontal)
      positions.push(x, y, z)
      normals.push(x, y, z)
    }
  }
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const current = ring * (segments + 1) + segment
      const next = current + segments + 1
      indices.push(current, next, current + 1, current + 1, next, next + 1)
    }
  }
  return { positions, normals, indices }
}

function encodeGlb(document: Record<string, unknown>, binary: Uint8Array): ArrayBuffer {
  const encoder = new TextEncoder()
  const json = encoder.encode(JSON.stringify(document))
  const jsonLength = alignFour(json.byteLength)
  const binaryLength = alignFour(binary.byteLength)
  const totalLength = 12 + 8 + jsonLength + 8 + binaryLength
  const output = new ArrayBuffer(totalLength)
  const view = new DataView(output)
  const bytes = new Uint8Array(output)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  bytes.fill(0x20, 20, 20 + jsonLength)
  bytes.set(json, 20)
  const binaryHeader = 20 + jsonLength
  view.setUint32(binaryHeader, binaryLength, true)
  view.setUint32(binaryHeader + 4, 0x004e4942, true)
  bytes.set(binary, binaryHeader + 8)
  return output
}

function alignFour(value: number): number {
  return Math.ceil(value / 4) * 4
}
