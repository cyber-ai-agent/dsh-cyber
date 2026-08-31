import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Reproducible authoring pipeline for the first official Avatar Base Pack.
 *
 * Important product boundary:
 * - runtime never downloads these files;
 * - this command downloads one pinned CC0 source set, verifies the exact Git
 *   blobs, converts/assembles it, and writes a normal local Marketplace package;
 * - only variants we can honestly map to an existing AvatarRecipe are declared.
 *
 * Source provenance is intentionally independent of the downstream mirror. The
 * original works are Quaternius CC0 assets; the pinned GitHub mirror is merely
 * a deterministic transport for the already-public standard files.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_ROOT = join(ROOT, 'marketplace', 'plugins', 'official-avatar-base-v1')
const CACHE_ROOT = join(ROOT, '.private', 'avatar-source-cache', 'official-avatar-base-v1')
const SOURCE_REPOSITORY = 'fastrouter/experiments-costa-vista'
const SOURCE_COMMIT = '23e87108a66876917951904e0fc85488fd581d0c'
const SOURCE_BASE = `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${SOURCE_COMMIT}/public/assets`

export const SOURCE_FILES = {
  base: {
    path: 'characters.glb',
    gitBlobSha1: '32a957a273245823155991191a632fc3633fc51c',
  },
  hairLong: {
    gltf: { path: 'toon/hair/Hair_Long.gltf', gitBlobSha1: 'b7d6ed3a49804437b9111dd4fd31ac0ef816679e' },
    bin: { path: 'toon/hair/Hair_Long.bin', gitBlobSha1: '6dd35d5741fac2f743bec96d3efc909da7c865f0' },
    recipeId: 'long-layered',
    nodeName: 'Hair_Long',
  },
  hairSidePart: {
    gltf: { path: 'toon/hair/Hair_SimpleParted.gltf', gitBlobSha1: 'dd838dfaa02acb1bbf8f2ce99028a1f8e594696e' },
    bin: { path: 'toon/hair/Hair_SimpleParted.bin', gitBlobSha1: '7acd44b83de1d7533c0c6f2b27c2633887c9137e' },
    recipeId: 'side-part',
    nodeName: 'Hair_SidePart',
  },
  hairTechCrop: {
    gltf: { path: 'toon/hair/Hair_Buzzed.gltf', gitBlobSha1: '09c045b529d89b50625d8676c60fccf3122a3372' },
    bin: { path: 'toon/hair/Hair_Buzzed.bin', gitBlobSha1: '9d617b82901bb41fdbfc47f1ecdd69876c6aef93' },
    recipeId: 'tech-crop',
    nodeName: 'Hair_TechCrop',
  },
}

const HUMANOID_NODE_ALIASES = {
  hips: ['pelvis', 'Hips', 'mixamorig:Hips'],
  spine: ['spine_01', 'Spine', 'mixamorig:Spine'],
  chest: ['spine_02', 'Spine1', 'mixamorig:Spine1'],
  upperChest: ['spine_03', 'Spine2', 'mixamorig:Spine2'],
  neck: ['neck_01', 'Neck', 'mixamorig:Neck'],
  head: ['Head', 'head', 'mixamorig:Head'],
  leftUpperArm: ['upperarm_l', 'LeftArm', 'mixamorig:LeftArm'],
  leftLowerArm: ['lowerarm_l', 'LeftForeArm', 'mixamorig:LeftForeArm'],
  leftHand: ['hand_l', 'LeftHand', 'mixamorig:LeftHand'],
  rightUpperArm: ['upperarm_r', 'RightArm', 'mixamorig:RightArm'],
  rightLowerArm: ['lowerarm_r', 'RightForeArm', 'mixamorig:RightForeArm'],
  rightHand: ['hand_r', 'RightHand', 'mixamorig:RightHand'],
  leftUpperLeg: ['thigh_l', 'LeftUpLeg', 'mixamorig:LeftUpLeg'],
  leftLowerLeg: ['calf_l', 'LeftLeg', 'mixamorig:LeftLeg'],
  leftFoot: ['foot_l', 'LeftFoot', 'mixamorig:LeftFoot'],
  leftToes: ['ball_l', 'LeftToeBase', 'mixamorig:LeftToeBase'],
  rightUpperLeg: ['thigh_r', 'RightUpLeg', 'mixamorig:RightUpLeg'],
  rightLowerLeg: ['calf_r', 'RightLeg', 'mixamorig:RightLeg'],
  rightFoot: ['foot_r', 'RightFoot', 'mixamorig:RightFoot'],
  rightToes: ['ball_r', 'RightToeBase', 'mixamorig:RightToeBase'],
}

const PACK_ID = 'official-avatar-base-v1'
const PACK_VERSION = '1.0.0'

export async function buildOfficialAvatarBasePack(options = {}) {
  const outputRoot = resolve(options.outputRoot ?? OUTPUT_ROOT)
  const cacheRoot = resolve(options.cacheRoot ?? CACHE_ROOT)
  const fetchImpl = options.fetchImpl ?? fetch
  await mkdir(cacheRoot, { recursive: true })

  const baseBytes = await loadPinnedSource(SOURCE_FILES.base, cacheRoot, fetchImpl)
  let base = parseGlb(baseBytes)
  const outfitMeshNames = markBaseAsCasualAvatar(base.document)
  const humanBones = inferHumanoidBones(base.document.nodes ?? [])
  injectVrm1Extension(base.document, humanBones)

  const hairVariants = [SOURCE_FILES.hairLong, SOURCE_FILES.hairSidePart, SOURCE_FILES.hairTechCrop]
  const hairParts = []
  for (const variant of hairVariants) {
    const gltfBytes = await loadPinnedSource(variant.gltf, cacheRoot, fetchImpl)
    const binBytes = await loadPinnedSource(variant.bin, cacheRoot, fetchImpl)
    const hairDocument = JSON.parse(gltfBytes.toString('utf8'))
    base = mergeRiggedHair(base, hairDocument, binBytes, variant.nodeName)
    hairParts.push({ id: variant.recipeId, kind: 'hair', meshNames: [variant.nodeName] })
  }

  const vrmBytes = writeGlb(base.document, base.binary)
  // Validate the output with the same product assumptions without importing
  // TypeScript server code into the standalone authoring command.
  assertBuiltVrm(vrmBytes)

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(join(outputRoot, 'models'), { recursive: true })
  const vrmPath = join(outputRoot, 'models', 'neutral.vrm')
  await writeFile(vrmPath, vrmBytes)

  const packManifest = {
    schemaVersion: 1,
    id: PACK_ID,
    version: PACK_VERSION,
    displayName: 'DSH Cyber · Quaternius CC0 Base V1',
    license: 'CC0-1.0',
    publisher: 'DSH Cyber (conversion) / Quaternius (original assets)',
    quality: 'production',
    bases: [{ baseModel: 'neutral-a', assetPath: 'models/neutral.vrm' }],
    parts: [
      ...hairParts,
      { id: 'casual', kind: 'outfit', meshNames: outfitMeshNames },
    ],
    // Hair is the only material slot this conversion can prove and control
    // without recolouring skin/eyes/clothing that share source materials.
    materialSlots: [{ id: 'hair', materialNames: ['DSH_Hair'] }],
  }
  const packManifestBytes = Buffer.from(`${JSON.stringify(packManifest, null, 2)}\n`, 'utf8')
  await writeFile(join(outputRoot, 'avatar-base-pack.json'), packManifestBytes)

  const provenance = provenanceText()
  const provenanceBytes = Buffer.from(provenance, 'utf8')
  await writeFile(join(outputRoot, 'PROVENANCE.md'), provenanceBytes)

  const files = [
    { path: 'avatar-base-pack.json', sha256: sha256(packManifestBytes) },
    { path: 'models/neutral.vrm', sha256: sha256(vrmBytes) },
    { path: 'PROVENANCE.md', sha256: sha256(provenanceBytes) },
  ]
  const unsignedPackage = {
    schemaVersion: 1,
    id: PACK_ID,
    version: PACK_VERSION,
    kind: 'asset',
    displayName: 'Official Avatar Base · CC0 V1',
    summary: '本地共享的 CC0 Humanoid Base + 3 个严格匹配的发型变体；未匹配角色继续保留 2.5D 身份。',
    license: 'CC0-1.0',
    publisher: 'DSH Cyber',
    capabilities: ['avatar:base-pack'],
    dataEgress: [],
    files,
    certification: { authority: 'DSH Cyber', level: 'official' },
  }
  const packageManifest = {
    ...unsignedPackage,
    certification: {
      ...unsignedPackage.certification,
      contentSha256: sha256(Buffer.from(stableSerialize(unsignedPackage), 'utf8')),
    },
  }
  await writeFile(join(outputRoot, 'dsh-cyber.package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8')

  return {
    outputRoot,
    packageManifest,
    packManifest,
    vrmBytes: vrmBytes.byteLength,
    sourceCommit: SOURCE_COMMIT,
  }
}

export async function loadPinnedSource(source, cacheRoot, fetchImpl = fetch) {
  const cachePath = join(cacheRoot, source.gitBlobSha1)
  try {
    const cached = await readFile(cachePath)
    assertGitBlob(cached, source.gitBlobSha1, source.path)
    return cached
  } catch (cause) {
    if (cause?.code !== 'ENOENT' && !String(cause?.message ?? '').includes('source blob mismatch')) throw cause
  }

  const response = await fetchImpl(`${SOURCE_BASE}/${source.path}`, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Avatar source download failed ${response.status}: ${source.path}`)
  const body = Buffer.from(await response.arrayBuffer())
  assertGitBlob(body, source.gitBlobSha1, source.path)
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, body)
  return body
}

export function assertGitBlob(body, expected, label) {
  const header = Buffer.from(`blob ${body.byteLength}\0`, 'utf8')
  const actual = createHash('sha1').update(header).update(body).digest('hex')
  if (actual !== expected) throw new Error(`Avatar source blob mismatch: ${label}; expected ${expected}, got ${actual}`)
}

export function parseGlb(body) {
  const buffer = Buffer.from(body)
  if (buffer.byteLength < 20 || buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.byteLength) {
    throw new Error('Source avatar is not GLB 2.0')
  }
  let cursor = 12
  let document
  let binary = Buffer.alloc(0)
  while (cursor + 8 <= buffer.byteLength) {
    const length = buffer.readUInt32LE(cursor)
    const type = buffer.readUInt32LE(cursor + 4)
    const start = cursor + 8
    const end = start + length
    if (end > buffer.byteLength) throw new Error('Source avatar GLB chunk exceeds file')
    if (type === 0x4e4f534a) document = JSON.parse(buffer.subarray(start, end).toString('utf8').trim())
    else if (type === 0x004e4942) binary = Buffer.from(buffer.subarray(start, end))
    cursor = end
  }
  if (document === undefined) throw new Error('Source avatar GLB has no JSON chunk')
  if (!Array.isArray(document.buffers) || document.buffers.length !== 1) throw new Error('Official avatar builder requires one-buffer GLB source')
  return { document, binary }
}

export function writeGlb(documentValue, binaryValue) {
  const document = structuredClone(documentValue)
  const binary = Buffer.from(binaryValue)
  document.buffers = [{ byteLength: binary.byteLength }]
  const jsonRaw = Buffer.from(JSON.stringify(document), 'utf8')
  const jsonLength = align4(jsonRaw.byteLength)
  const binaryLength = align4(binary.byteLength)
  const total = 12 + 8 + jsonLength + 8 + binaryLength
  const output = Buffer.alloc(total)
  output.writeUInt32LE(0x46546c67, 0)
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(total, 8)
  output.writeUInt32LE(jsonLength, 12)
  output.writeUInt32LE(0x4e4f534a, 16)
  output.fill(0x20, 20, 20 + jsonLength)
  jsonRaw.copy(output, 20)
  const binHeader = 20 + jsonLength
  output.writeUInt32LE(binaryLength, binHeader)
  output.writeUInt32LE(0x004e4942, binHeader + 4)
  binary.copy(output, binHeader + 8)
  return output
}

export function inferHumanoidBones(nodes) {
  const byName = new Map()
  nodes.forEach((node, index) => {
    if (typeof node?.name === 'string' && !byName.has(node.name)) byName.set(node.name, index)
  })
  const humanBones = {}
  for (const [bone, aliases] of Object.entries(HUMANOID_NODE_ALIASES)) {
    const node = aliases.map((name) => byName.get(name)).find((index) => Number.isInteger(index))
    if (node !== undefined) humanBones[bone] = { node }
  }
  for (const required of ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg']) {
    if (humanBones[required] === undefined) throw new Error(`CC0 base is missing required Humanoid bone: ${required}`)
  }
  return humanBones
}

export function injectVrm1Extension(document, humanBones) {
  document.asset = { ...(document.asset ?? {}), version: '2.0', generator: `${document.asset?.generator ?? 'glTF'} + DSH Cyber CC0 VRM converter` }
  document.extensionsUsed = [...new Set([...(document.extensionsUsed ?? []), 'VRMC_vrm'])]
  document.extensions = {
    ...(document.extensions ?? {}),
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name: 'DSH Cyber CC0 Avatar Base V1',
        version: PACK_VERSION,
        authors: ['Quaternius', 'DSH Cyber conversion'],
        copyrightInformation: 'Original assets dedicated to the public domain under CC0 1.0',
        contactInformation: '',
        references: [
          'https://quaternius.com/packs/universalbasecharacters.html',
          `https://github.com/${SOURCE_REPOSITORY}/commit/${SOURCE_COMMIT}`,
        ],
        thirdPartyLicenses: 'CC0-1.0',
        avatarPermission: 'everyone',
        allowExcessivelyViolentUsage: true,
        allowExcessivelySexualUsage: false,
        commercialUsage: 'corporation',
        allowPoliticalOrReligiousUsage: true,
        allowAntisocialOrHateUsage: false,
        creditNotation: 'unnecessary',
        allowRedistribution: true,
        modification: 'allowModificationRedistribution',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      },
      humanoid: { humanBones },
      expressions: { preset: {}, custom: {} },
    },
  }
}

export function markBaseAsCasualAvatar(document) {
  const nodes = document.nodes ?? []
  const names = []
  let ordinal = 0
  for (const node of nodes) {
    if (!Number.isInteger(node?.mesh)) continue
    // Base scene meshes are kept together as one honest `casual` silhouette.
    // We do not call this professional/analyst until real office clothing is
    // authored. Hair added later is the only additional managed geometry.
    const name = `Outfit_Casual_${ordinal++}`
    node.name = name
    names.push(name)
  }
  if (names.length === 0) throw new Error('CC0 base does not contain a renderable character mesh')
  return names
}

export function mergeRiggedHair(baseValue, hairDocumentValue, hairBinaryValue, variantNodeName) {
  const document = structuredClone(baseValue.document)
  const hair = structuredClone(hairDocumentValue)
  let binary = Buffer.from(baseValue.binary)
  const hairBinary = Buffer.from(hairBinaryValue)
  if (!Array.isArray(hair.buffers) || hair.buffers.length !== 1) throw new Error(`${variantNodeName} requires one buffer`)
  if ((hair.images ?? []).length > 0 || (hair.textures ?? []).length > 0) throw new Error(`${variantNodeName} unexpectedly contains external texture data`)

  const sourceNodes = hair.nodes ?? []
  const targetNodes = document.nodes ?? (document.nodes = [])
  const targetByName = new Map()
  targetNodes.forEach((node, index) => {
    if (typeof node?.name === 'string' && !targetByName.has(node.name)) targetByName.set(node.name, index)
  })

  const alignedOffset = align4(binary.byteLength)
  if (alignedOffset !== binary.byteLength) binary = Buffer.concat([binary, Buffer.alloc(alignedOffset - binary.byteLength)])
  const binaryOffset = binary.byteLength
  binary = Buffer.concat([binary, hairBinary])

  const baseBufferViewCount = (document.bufferViews ??= []).length
  for (const source of hair.bufferViews ?? []) {
    document.bufferViews.push({
      ...source,
      buffer: 0,
      byteOffset: binaryOffset + (source.byteOffset ?? 0),
    })
  }

  const baseAccessorCount = (document.accessors ??= []).length
  for (const source of hair.accessors ?? []) {
    const accessor = structuredClone(source)
    if (Number.isInteger(accessor.bufferView)) accessor.bufferView += baseBufferViewCount
    if (accessor.sparse !== undefined) {
      if (Number.isInteger(accessor.sparse.indices?.bufferView)) accessor.sparse.indices.bufferView += baseBufferViewCount
      if (Number.isInteger(accessor.sparse.values?.bufferView)) accessor.sparse.values.bufferView += baseBufferViewCount
    }
    document.accessors.push(accessor)
  }

  const baseMaterialCount = (document.materials ??= []).length
  for (const source of hair.materials ?? []) document.materials.push({ ...source, name: 'DSH_Hair' })

  const baseMeshCount = (document.meshes ??= []).length
  for (const source of hair.meshes ?? []) {
    const mesh = structuredClone(source)
    for (const primitive of mesh.primitives ?? []) {
      if (Number.isInteger(primitive.indices)) primitive.indices += baseAccessorCount
      if (Number.isInteger(primitive.material)) primitive.material += baseMaterialCount
      for (const [key, value] of Object.entries(primitive.attributes ?? {})) {
        if (Number.isInteger(value)) primitive.attributes[key] = value + baseAccessorCount
      }
      for (const target of primitive.targets ?? []) {
        for (const [key, value] of Object.entries(target)) if (Number.isInteger(value)) target[key] = value + baseAccessorCount
      }
    }
    document.meshes.push(mesh)
  }

  const baseSkinCount = (document.skins ??= []).length
  const skinIndexMap = new Map()
  for (const [sourceSkinIndex, sourceSkin] of (hair.skins ?? []).entries()) {
    const skin = structuredClone(sourceSkin)
    skin.joints = (sourceSkin.joints ?? []).map((sourceJoint) => {
      const name = sourceNodes[sourceJoint]?.name
      const target = typeof name === 'string' ? targetByName.get(name) : undefined
      if (!Number.isInteger(target)) throw new Error(`${variantNodeName} joint cannot rebind to Base skeleton: ${String(name)}`)
      return target
    })
    if (Number.isInteger(sourceSkin.inverseBindMatrices)) skin.inverseBindMatrices = sourceSkin.inverseBindMatrices + baseAccessorCount
    if (Number.isInteger(sourceSkin.skeleton)) {
      const name = sourceNodes[sourceSkin.skeleton]?.name
      const target = typeof name === 'string' ? targetByName.get(name) : undefined
      if (!Number.isInteger(target)) throw new Error(`${variantNodeName} skeleton root cannot rebind: ${String(name)}`)
      skin.skeleton = target
    }
    const targetSkinIndex = document.skins.push(skin) - 1
    skinIndexMap.set(sourceSkinIndex, targetSkinIndex)
  }

  const meshNodes = (hair.nodes ?? []).filter((node) => Number.isInteger(node?.mesh))
  if (meshNodes.length === 0) throw new Error(`${variantNodeName} has no skinned mesh node`)
  const createdNodes = []
  meshNodes.forEach((sourceNode, index) => {
    const node = {
      name: index === 0 ? variantNodeName : `${variantNodeName}_${index}`,
      mesh: sourceNode.mesh + baseMeshCount,
      ...(Number.isInteger(sourceNode.skin) ? { skin: skinIndexMap.get(sourceNode.skin) } : {}),
      ...(sourceNode.translation === undefined ? {} : { translation: sourceNode.translation }),
      ...(sourceNode.rotation === undefined ? {} : { rotation: sourceNode.rotation }),
      ...(sourceNode.scale === undefined ? {} : { scale: sourceNode.scale }),
      ...(sourceNode.weights === undefined ? {} : { weights: sourceNode.weights }),
    }
    if (node.skin === undefined) throw new Error(`${variantNodeName} mesh is not skinned`)
    createdNodes.push(document.nodes.push(node) - 1)
  })
  const sceneIndex = Number.isInteger(document.scene) ? document.scene : 0
  document.scenes ??= [{ nodes: [] }]
  document.scenes[sceneIndex] ??= { nodes: [] }
  document.scenes[sceneIndex].nodes ??= []
  document.scenes[sceneIndex].nodes.push(...createdNodes)
  document.buffers = [{ byteLength: binary.byteLength }]
  return { document, binary }
}

export function assertBuiltVrm(body) {
  const { document } = parseGlb(body)
  if (document.extensions?.VRMC_vrm?.specVersion !== '1.0') throw new Error('Built avatar is not VRM 1.0')
  const bones = document.extensions.VRMC_vrm.humanoid?.humanBones ?? {}
  for (const bone of ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg']) {
    if (!Number.isInteger(bones[bone]?.node)) throw new Error(`Built avatar is missing ${bone}`)
  }
  for (const image of document.images ?? []) {
    if (typeof image.uri === 'string' && !image.uri.startsWith('data:')) throw new Error('Built avatar contains an external image')
  }
  for (const buffer of document.buffers ?? []) {
    if (typeof buffer.uri === 'string' && !buffer.uri.startsWith('data:')) throw new Error('Built avatar contains an external buffer')
  }
}

function provenanceText() {
  return `# Official Avatar Base · CC0 V1\n\n` +
    `This package is generated, not hand-edited. Run \`pnpm avatar:build-official\` to reproduce it.\n\n` +
    `## Original assets\n\n` +
    `- Quaternius, **Universal Base Characters**, CC0 1.0: https://quaternius.com/packs/universalbasecharacters.html\n` +
    `- Quaternius, **Universal Animation Library**, CC0 1.0: https://quaternius.com/packs/universalanimationlibrary.html\n\n` +
    `The deterministic transport mirror documents those two source families as Quaternius CC0 assets in its ATTRIBUTION.md. ` +
    `Only the mirror files explicitly covered by that attribution are consumed; project-authored/commercial-tool character files are excluded.\n\n` +
    `Pinned mirror repository: https://github.com/${SOURCE_REPOSITORY}/commit/${SOURCE_COMMIT}\n\n` +
    `## DSH Cyber conversion\n\n` +
    `- Adds VRM 1.0 Humanoid metadata without replacing the source rig.\n` +
    `- Rebinds three CC0 hairstyle skins to the same 65-bone Base skeleton by exact bone name.\n` +
    `- Declares only long-layered, side-part and tech-crop hair mappings; unsupported hairstyles remain on the 2.5D identity fallback.\n` +
    `- Declares the source body only as casual. It is intentionally not labelled professional/analyst.\n\n` +
    `License for original source assets and this generated package: CC0-1.0.\n`
}

function sha256(body) { return createHash('sha256').update(body).digest('hex') }
function align4(value) { return Math.ceil(value / 4) * 4 }
function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
}

async function main() {
  const result = await buildOfficialAvatarBasePack()
  console.log(`Built ${result.packageManifest.id}@${result.packageManifest.version}`)
  console.log(`Output: ${result.outputRoot}`)
  console.log(`VRM: ${(result.vrmBytes / 1024 / 1024).toFixed(2)} MiB`)
  console.log(`Pinned source commit: ${result.sourceCommit}`)
}

const executedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (executedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
