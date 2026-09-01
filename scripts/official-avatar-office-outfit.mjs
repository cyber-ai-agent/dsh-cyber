import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_PACKAGE = pathToFileURL(join(ROOT, 'packages', 'web', 'package.json'))
const webRequire = createRequire(WEB_PACKAGE)
const { Matrix4, Quaternion, Vector3 } = webRequire('three')

export const OFFICE_OUTFIT_SOURCE = Object.freeze({
  repository: 'FloodZHubGit/break-the-silence-vr',
  commit: 'c86cee866df76efb1c09041e1e5ad89702ae0f3e',
  path: 'public/models/Business_Man.glb',
  gitBlobSha1: '3e97aa2cdfc272d88e30d325dfe90a97f90699b6',
  originalPackUrl: 'https://quaternius.com/packs/ultimatemodularcharacters.html',
  originalModelUrl: 'https://poly.pizza/m/JFrLIKqvCH',
})

const SOURCE_URL = `https://raw.githubusercontent.com/${OFFICE_OUTFIT_SOURCE.repository}/${OFFICE_OUTFIT_SOURCE.commit}/${OFFICE_OUTFIT_SOURCE.path}`
const SELECTED_NODES = Object.freeze([
  ['Suit_Legs', 'Outfit_Professional_Legs'],
  ['Suit_Feet', 'Outfit_Professional_Feet'],
  ['Suit_Body', 'Outfit_Professional_Body'],
])
const MATERIAL_NAMES = Object.freeze({
  Suit: 'DSH_Office_Outfit',
  Black: 'DSH_Office_Shoes',
  White: 'DSH_Office_Shirt',
  Tie: 'DSH_Office_Accent',
})

/**
 * Semantic joint mapping between Quaternius' older modular-character rig and
 * the Universal Animation Library rig used by the official Base VRM.
 *
 * Geometry is not forced onto the target bind matrices from the source. New
 * inverse-bind matrices are generated against the target skeleton, preserving
 * the source mesh's bind-pose shape while making target animation authoritative.
 */
export const OFFICE_OUTFIT_BONE_MAP = Object.freeze(buildBoneMap())

export async function loadPinnedOfficeOutfit(cacheRoot, fetchImpl = fetch) {
  const cachePath = join(cacheRoot, `business-man-${OFFICE_OUTFIT_SOURCE.gitBlobSha1}.glb`)
  try {
    const cached = await readFile(cachePath)
    verifyGitBlob(cached)
    return cached
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const response = await fetchImpl(SOURCE_URL)
  if (!response.ok) throw new Error(`Office outfit source download failed: ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  verifyGitBlob(body)
  await writeFile(cachePath, body)
  return body
}

export async function mergeOfficeOutfit(base, sourceBytes) {
  const source = parseSimpleGlb(sourceBytes)
  const document = structuredClone(base.document)
  let binary = Buffer.from(base.binary)

  if ((source.document.extensionsUsed ?? []).length !== 0 || (source.document.extensionsRequired ?? []).length !== 0) {
    throw new Error('Office outfit transport must remain a conventional extension-free GLB')
  }
  if ((source.document.images ?? []).length !== 0 || (source.document.textures ?? []).length !== 0) {
    throw new Error('Office outfit transport unexpectedly gained texture dependencies')
  }

  const baseNameToIndex = new Map((document.nodes ?? []).map((node, index) => [node?.name, index]).filter(([name]) => typeof name === 'string'))
  for (const targetName of Object.values(OFFICE_OUTFIT_BONE_MAP)) {
    if (!baseNameToIndex.has(targetName)) throw new Error(`Official Base is missing office-outfit target bone: ${targetName}`)
  }

  const sourceNodeIndexes = new Map((source.document.nodes ?? []).map((node, index) => [node?.name, index]).filter(([name]) => typeof name === 'string'))
  const selected = SELECTED_NODES.map(([sourceName, targetName]) => {
    const nodeIndex = sourceNodeIndexes.get(sourceName)
    if (nodeIndex === undefined) throw new Error(`Office outfit source is missing modular node: ${sourceName}`)
    const node = source.document.nodes[nodeIndex]
    if (!Number.isInteger(node?.mesh) || !Number.isInteger(node?.skin)) throw new Error(`Office outfit node is not skinned: ${sourceName}`)
    return { sourceName, targetName, nodeIndex, node }
  })
  if (sourceNodeIndexes.has('Suit_Head') === false) throw new Error('Office outfit source no longer exposes a separable head module')

  const targetWorld = worldMatrices(document)
  const sourceWorld = worldMatrices(source.document)
  const accessorIds = new Set()
  const materialIds = new Set()
  const selectedMeshPrimitives = new Map()

  for (const item of selected) {
    const mesh = source.document.meshes?.[item.node.mesh]
    if (mesh === undefined) throw new Error(`Office outfit source mesh is missing: ${item.sourceName}`)
    const primitives = (mesh.primitives ?? []).filter((primitive) => source.document.materials?.[primitive.material]?.name !== 'Skin')
    if (primitives.length === 0) throw new Error(`Office outfit module lost all clothing primitives: ${item.sourceName}`)
    selectedMeshPrimitives.set(item.node.mesh, primitives)
    for (const primitive of primitives) {
      if (Number.isInteger(primitive.indices)) accessorIds.add(primitive.indices)
      for (const value of Object.values(primitive.attributes ?? {})) if (Number.isInteger(value)) accessorIds.add(value)
      for (const target of primitive.targets ?? []) for (const value of Object.values(target ?? {})) if (Number.isInteger(value)) accessorIds.add(value)
      if (Number.isInteger(primitive.material)) materialIds.add(primitive.material)
    }
  }

  const sourceBufferViewIds = new Set()
  for (const accessorId of accessorIds) {
    const accessor = source.document.accessors?.[accessorId]
    if (accessor === undefined) throw new Error(`Office outfit accessor is missing: ${accessorId}`)
    if (Number.isInteger(accessor.bufferView)) sourceBufferViewIds.add(accessor.bufferView)
    if (Number.isInteger(accessor.sparse?.indices?.bufferView)) sourceBufferViewIds.add(accessor.sparse.indices.bufferView)
    if (Number.isInteger(accessor.sparse?.values?.bufferView)) sourceBufferViewIds.add(accessor.sparse.values.bufferView)
  }

  document.bufferViews ??= []
  document.accessors ??= []
  document.materials ??= []
  document.meshes ??= []
  document.skins ??= []
  document.nodes ??= []
  document.scenes ??= [{ nodes: [] }]
  const sceneIndex = Number.isInteger(document.scene) ? document.scene : 0
  document.scenes[sceneIndex] ??= { nodes: [] }
  document.scenes[sceneIndex].nodes ??= []

  const bufferViewMap = new Map()
  for (const oldIndex of [...sourceBufferViewIds].sort((a, b) => a - b)) {
    const view = source.document.bufferViews?.[oldIndex]
    if (view === undefined || view.buffer !== 0) throw new Error(`Office outfit bufferView is unsupported: ${oldIndex}`)
    const start = view.byteOffset ?? 0
    const bytes = source.binary.subarray(start, start + view.byteLength)
    const appended = appendAligned(binary, bytes)
    binary = appended.binary
    const next = structuredClone(view)
    next.buffer = 0
    next.byteOffset = appended.offset
    const nextIndex = document.bufferViews.length
    document.bufferViews.push(next)
    bufferViewMap.set(oldIndex, nextIndex)
  }

  const accessorMap = new Map()
  for (const oldIndex of [...accessorIds].sort((a, b) => a - b)) {
    const accessor = structuredClone(source.document.accessors[oldIndex])
    if (Number.isInteger(accessor.bufferView)) accessor.bufferView = requiredMap(bufferViewMap, accessor.bufferView, 'bufferView')
    if (Number.isInteger(accessor.sparse?.indices?.bufferView)) accessor.sparse.indices.bufferView = requiredMap(bufferViewMap, accessor.sparse.indices.bufferView, 'sparse indices bufferView')
    if (Number.isInteger(accessor.sparse?.values?.bufferView)) accessor.sparse.values.bufferView = requiredMap(bufferViewMap, accessor.sparse.values.bufferView, 'sparse values bufferView')
    const nextIndex = document.accessors.length
    document.accessors.push(accessor)
    accessorMap.set(oldIndex, nextIndex)
  }

  const materialMap = new Map()
  for (const oldIndex of [...materialIds].sort((a, b) => a - b)) {
    const material = structuredClone(source.document.materials?.[oldIndex])
    if (material === undefined) throw new Error(`Office outfit material is missing: ${oldIndex}`)
    const sourceName = material.name
    const managedName = MATERIAL_NAMES[sourceName]
    if (managedName === undefined) throw new Error(`Office outfit primitive uses undeclared material: ${sourceName}`)
    material.name = managedName
    const nextIndex = document.materials.length
    document.materials.push(material)
    materialMap.set(oldIndex, nextIndex)
  }

  const meshMap = new Map()
  for (const item of selected) {
    if (meshMap.has(item.node.mesh)) continue
    const sourceMesh = source.document.meshes[item.node.mesh]
    const primitives = selectedMeshPrimitives.get(item.node.mesh)
    const mesh = {
      ...structuredClone(sourceMesh),
      primitives: primitives.map((primitive) => remapPrimitive(primitive, accessorMap, materialMap)),
    }
    const nextIndex = document.meshes.length
    document.meshes.push(mesh)
    meshMap.set(item.node.mesh, nextIndex)
  }

  const skinMap = new Map()
  for (const item of selected) {
    if (skinMap.has(item.node.skin)) continue
    const sourceSkin = source.document.skins?.[item.node.skin]
    if (sourceSkin === undefined) throw new Error(`Office outfit source skin is missing: ${item.node.skin}`)
    const targetJoints = (sourceSkin.joints ?? []).map((sourceJointIndex) => {
      const sourceName = source.document.nodes?.[sourceJointIndex]?.name
      const targetName = OFFICE_OUTFIT_BONE_MAP[sourceName]
      if (targetName === undefined) throw new Error(`Office outfit joint has no semantic target: ${sourceName}`)
      const targetIndex = baseNameToIndex.get(targetName)
      if (targetIndex === undefined) throw new Error(`Office outfit target joint is missing: ${targetName}`)
      return targetIndex
    })
    const meshWorld = sourceWorld[item.nodeIndex]
    const inverseBindBytes = matrixBytes(targetJoints.map((targetIndex) => {
      const jointWorld = targetWorld[targetIndex]
      return jointWorld.clone().invert().multiply(meshWorld)
    }))
    const appended = appendAligned(binary, inverseBindBytes)
    binary = appended.binary
    const viewIndex = document.bufferViews.length
    document.bufferViews.push({ buffer: 0, byteOffset: appended.offset, byteLength: inverseBindBytes.byteLength })
    const accessorIndex = document.accessors.length
    document.accessors.push({ bufferView: viewIndex, componentType: 5126, count: targetJoints.length, type: 'MAT4' })
    const sourceSkeletonName = source.document.nodes?.[sourceSkin.skeleton]?.name
    const targetSkeletonName = OFFICE_OUTFIT_BONE_MAP[sourceSkeletonName]
    const targetSkeleton = targetSkeletonName === undefined ? undefined : baseNameToIndex.get(targetSkeletonName)
    if (targetSkeleton === undefined) throw new Error(`Office outfit skin skeleton is unmapped: ${sourceSkeletonName}`)
    const nextIndex = document.skins.length
    document.skins.push({ joints: targetJoints, skeleton: targetSkeleton, inverseBindMatrices: accessorIndex })
    skinMap.set(item.node.skin, nextIndex)
  }

  const meshNames = []
  for (const item of selected) {
    const world = sourceWorld[item.nodeIndex]
    const position = new Vector3()
    const rotation = new Quaternion()
    const scale = new Vector3()
    world.decompose(position, rotation, scale)
    const node = {
      name: item.targetName,
      mesh: requiredMap(meshMap, item.node.mesh, 'mesh'),
      skin: requiredMap(skinMap, item.node.skin, 'skin'),
      translation: position.toArray(),
      rotation: rotation.toArray(),
      scale: scale.toArray(),
    }
    const nodeIndex = document.nodes.length
    document.nodes.push(node)
    document.scenes[sceneIndex].nodes.push(nodeIndex)
    meshNames.push(item.targetName)
  }

  // The source skeleton and Suit_Head are intentionally not copied. The current
  // Base body stays underneath the clothing, preserving the employee's head,
  // hands, hair and 2D-seeded identity while the suit supplies outer clothing.
  document.buffers = [{ byteLength: binary.byteLength }]
  return { document, binary, meshNames }
}

function buildBoneMap() {
  const map = {
    Root: 'Armature',
    Body: 'root',
    Hips: 'pelvis',
    Abdomen: 'spine_01',
    Torso: 'spine_02',
    Chest: 'spine_03',
    Neck: 'neck_01',
    Head: 'Head',
    'Shoulder.L': 'clavicle_l',
    'UpperArm.L': 'upperarm_l',
    'LowerArm.L': 'lowerarm_l',
    'Wrist.L': 'hand_l',
    'Shoulder.R': 'clavicle_r',
    'UpperArm.R': 'upperarm_r',
    'LowerArm.R': 'lowerarm_r',
    'Wrist.R': 'hand_r',
    'UpperLeg.L': 'thigh_l',
    'LowerLeg.L': 'calf_l',
    'Foot.L': 'foot_l',
    'PT.L': 'ball_l',
    'UpperLeg.R': 'thigh_r',
    'LowerLeg.R': 'calf_r',
    'Foot.R': 'foot_r',
    'PT.R': 'ball_r',
  }
  for (const [source, target] of [['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Pinky', 'pinky']]) {
    for (const side of ['L', 'R']) {
      const suffix = side.toLowerCase()
      for (let segment = 1; segment <= 4; segment += 1) {
        map[`${source}${segment}.${side}`] = `${target}_0${segment}${segment === 4 ? '_leaf' : ''}_${suffix}`
      }
    }
  }
  for (const side of ['L', 'R']) {
    const suffix = side.toLowerCase()
    for (let segment = 1; segment <= 3; segment += 1) map[`Thumb${segment}.${side}`] = `thumb_0${segment}_${suffix}`
  }
  return map
}

function parseSimpleGlb(body) {
  const buffer = Buffer.from(body)
  if (buffer.byteLength < 20 || buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.byteLength) {
    throw new Error('Office outfit source is not a valid GLB 2.0')
  }
  let cursor = 12
  let document
  let binary
  while (cursor + 8 <= buffer.byteLength) {
    const byteLength = buffer.readUInt32LE(cursor)
    const type = buffer.readUInt32LE(cursor + 4)
    const start = cursor + 8
    const end = start + byteLength
    if (end > buffer.byteLength) throw new Error('Office outfit GLB chunk exceeds file bounds')
    if (type === 0x4e4f534a) document = JSON.parse(buffer.subarray(start, end).toString('utf8').trim())
    else if (type === 0x004e4942) binary = Buffer.from(buffer.subarray(start, end))
    cursor = end
  }
  if (document === undefined || binary === undefined || (document.buffers ?? []).length !== 1 || typeof document.buffers?.[0]?.uri === 'string') {
    throw new Error('Office outfit source must be a self-contained single-buffer GLB')
  }
  return { document, binary }
}

function verifyGitBlob(body) {
  const digest = createHash('sha1').update(Buffer.from(`blob ${body.byteLength}\0`)).update(body).digest('hex')
  if (digest !== OFFICE_OUTFIT_SOURCE.gitBlobSha1) throw new Error(`Office outfit source blob mismatch: ${digest}`)
}

function parentIndexes(document) {
  const parents = Array.from({ length: document.nodes?.length ?? 0 }, () => undefined)
  for (const [parentIndex, node] of (document.nodes ?? []).entries()) {
    for (const childIndex of node?.children ?? []) {
      if (parents[childIndex] !== undefined) throw new Error(`Node ${childIndex} has multiple parents`)
      parents[childIndex] = parentIndex
    }
  }
  return parents
}

function worldMatrices(document) {
  const length = document.nodes?.length ?? 0
  const parents = parentIndexes(document)
  const cache = new Array(length)
  const resolveWorld = (index) => {
    if (cache[index] !== undefined) return cache[index]
    const node = document.nodes[index] ?? {}
    const local = localMatrix(node)
    const parent = parents[index]
    const world = parent === undefined ? local : resolveWorld(parent).clone().multiply(local)
    cache[index] = world
    return world
  }
  return Array.from({ length }, (_unused, index) => resolveWorld(index))
}

function localMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return new Matrix4().fromArray(node.matrix)
  const translation = Array.isArray(node.translation) ? node.translation : [0, 0, 0]
  const rotation = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1]
  const scale = Array.isArray(node.scale) ? node.scale : [1, 1, 1]
  return new Matrix4().compose(
    new Vector3().fromArray(translation),
    new Quaternion().fromArray(rotation),
    new Vector3().fromArray(scale),
  )
}

function remapPrimitive(source, accessorMap, materialMap) {
  const primitive = structuredClone(source)
  if (Number.isInteger(primitive.indices)) primitive.indices = requiredMap(accessorMap, primitive.indices, 'indices accessor')
  primitive.attributes = Object.fromEntries(Object.entries(primitive.attributes ?? {}).map(([key, value]) => [key, requiredMap(accessorMap, value, `${key} accessor`)]))
  if (Array.isArray(primitive.targets)) primitive.targets = primitive.targets.map((target) => Object.fromEntries(Object.entries(target ?? {}).map(([key, value]) => [key, requiredMap(accessorMap, value, `${key} target accessor`)])))
  if (Number.isInteger(primitive.material)) primitive.material = requiredMap(materialMap, primitive.material, 'material')
  return primitive
}

function appendAligned(binary, bytes) {
  const offset = align4(binary.byteLength)
  const padding = offset - binary.byteLength
  return { offset, binary: Buffer.concat([binary, Buffer.alloc(padding), Buffer.from(bytes)]) }
}

function matrixBytes(matrices) {
  const output = Buffer.alloc(matrices.length * 16 * 4)
  let offset = 0
  for (const matrix of matrices) {
    for (const value of matrix.elements) {
      output.writeFloatLE(value, offset)
      offset += 4
    }
  }
  return output
}

function requiredMap(map, key, label) {
  const value = map.get(key)
  if (value === undefined) throw new Error(`Office outfit ${label} was not remapped: ${key}`)
  return value
}

function align4(value) { return Math.ceil(value / 4) * 4 }
