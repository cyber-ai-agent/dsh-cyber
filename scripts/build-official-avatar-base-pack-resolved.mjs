import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  SOURCE_FILES,
  assertBuiltVrm,
  inferHumanoidBones,
  injectVrm1Extension,
  loadPinnedSource,
  markBaseAsCasualAvatar,
  mergeRiggedHair,
  writeGlb,
} from './build-official-avatar-base-pack.mjs'
import {
  OFFICE_OUTFIT_SOURCE,
  loadPinnedOfficeOutfit,
  mergeOfficeOutfit,
} from './official-avatar-office-outfit.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_ROOT = join(ROOT, 'marketplace', 'plugins', 'official-avatar-base-v1')
const CACHE_ROOT = join(ROOT, '.private', 'avatar-source-cache', 'official-avatar-base-v1')
const WEB_PACKAGE = pathToFileURL(join(ROOT, 'packages', 'web', 'package.json'))
const webRequire = createRequire(WEB_PACKAGE)
const SOURCE_REPOSITORY = 'fastrouter/experiments-costa-vista'
const SOURCE_COMMIT = '23e87108a281ac827e2ea23691aa7bf4b544146e'
const PACK_ID = 'official-avatar-base-v1'
const PACK_VERSION = '1.1.0'

export async function buildOfficialAvatarBasePackResolved(options = {}) {
  const outputRoot = resolve(options.outputRoot ?? OUTPUT_ROOT)
  const cacheRoot = resolve(options.cacheRoot ?? CACHE_ROOT)
  const fetchImpl = options.fetchImpl ?? fetch
  await mkdir(cacheRoot, { recursive: true })

  const baseBytes = await loadPinnedSource(SOURCE_FILES.base, cacheRoot, fetchImpl)
  let base = await normalizeSourceGlbWithProductionLoader(baseBytes)
  const casualMeshNames = markBaseAsCasualAvatar(base.document)
  const humanBones = inferHumanoidBones(base.document.nodes ?? [])
  injectVrm1Extension(base.document, humanBones)
  normalizeVrm1LicenseMetadata(base.document)
  base.document.extensions.VRMC_vrm.meta.version = PACK_VERSION

  const hairVariants = [SOURCE_FILES.hairLong, SOURCE_FILES.hairSidePart, SOURCE_FILES.hairTechCrop]
  const hairParts = []
  for (const variant of hairVariants) {
    const gltfBytes = await loadPinnedSource(variant.gltf, cacheRoot, fetchImpl)
    const binBytes = await loadPinnedSource(variant.bin, cacheRoot, fetchImpl)
    const hairDocument = JSON.parse(gltfBytes.toString('utf8'))
    base = mergeRiggedHair(base, hairDocument, binBytes, variant.nodeName)
    hairParts.push({ id: variant.recipeId, kind: 'hair', meshNames: [variant.nodeName] })
  }

  const officeSource = await loadPinnedOfficeOutfit(cacheRoot, fetchImpl)
  const office = await mergeOfficeOutfit(base, officeSource)
  base = { document: office.document, binary: office.binary }
  const formalMeshNames = [...casualMeshNames, ...office.meshNames]

  const vrmBytes = writeGlb(base.document, base.binary)
  assertBuiltVrm(vrmBytes)

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(join(outputRoot, 'models'), { recursive: true })
  await writeFile(join(outputRoot, 'models', 'neutral.vrm'), vrmBytes)

  const packManifest = {
    schemaVersion: 1,
    id: PACK_ID,
    version: PACK_VERSION,
    displayName: 'DSH Cyber · Quaternius CC0 Base V1.1',
    license: 'CC0-1.0',
    publisher: 'DSH Cyber (conversion) / Quaternius (original assets)',
    quality: 'production',
    bases: [{ baseModel: 'neutral-a', assetPath: 'models/neutral.vrm' }],
    parts: [
      ...hairParts,
      { id: 'casual', kind: 'outfit', meshNames: casualMeshNames },
      { id: 'professional', kind: 'outfit', meshNames: formalMeshNames },
      { id: 'analyst', kind: 'outfit', meshNames: formalMeshNames },
    ],
    materialSlots: [
      { id: 'hair', materialNames: ['DSH_Hair'] },
      { id: 'outfit', materialNames: ['DSH_Office_Outfit'] },
      { id: 'accent', materialNames: ['DSH_Office_Accent'] },
    ],
  }
  const packManifestBytes = Buffer.from(`${JSON.stringify(packManifest, null, 2)}\n`, 'utf8')
  await writeFile(join(outputRoot, 'avatar-base-pack.json'), packManifestBytes)

  const provenanceBytes = Buffer.from(provenanceText(), 'utf8')
  await writeFile(join(outputRoot, 'provenance.md'), provenanceBytes)

  const files = [
    { path: 'avatar-base-pack.json', sha256: sha256(packManifestBytes) },
    { path: 'models/neutral.vrm', sha256: sha256(vrmBytes) },
    { path: 'provenance.md', sha256: sha256(provenanceBytes) },
  ]
  const unsignedPackage = {
    schemaVersion: 1,
    id: PACK_ID,
    version: PACK_VERSION,
    kind: 'asset',
    displayName: 'Official Avatar Base · CC0 V1.1',
    summary: '本地共享的 CC0 Humanoid Base、真实动作、3 个发型和可复用的 professional / analyst 办公西装；未匹配身份继续保留 2.5D。',
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
    officeOutfitSourceCommit: OFFICE_OUTFIT_SOURCE.commit,
  }
}

export function normalizeVrm1LicenseMetadata(document) {
  const meta = document?.extensions?.VRMC_vrm?.meta
  if (meta === undefined || meta === null || typeof meta !== 'object') throw new Error('Generated VRM metadata is missing')
  meta.licenseUrl = 'https://vrm.dev/licenses/1.0/'
  meta.otherLicenseUrl = 'https://creativecommons.org/publicdomain/zero/1.0/'
}

export async function normalizeSourceGlbWithProductionLoader(body) {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import(pathToFileURL(webRequire.resolve('three/addons/loaders/GLTFLoader.js')).href),
    import(pathToFileURL(webRequire.resolve('three/addons/libs/meshopt_decoder.module.js')).href),
  ])
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  const source = Buffer.from(body)
  const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
  const gltf = await loader.parseAsync(arrayBuffer, '')
  const parser = gltf.parser
  const document = structuredClone(parser.json)
  const sourceBufferViews = Array.isArray(document.bufferViews) ? document.bufferViews : []
  const referenced = collectReferencedBufferViews(document)
  if (referenced.length === 0) throw new Error('CC0 base does not reference any renderable bufferView')

  const viewIndexMap = new Map()
  const normalizedViews = []
  const pieces = []
  let total = 0
  for (const sourceIndex of referenced) {
    const dependency = await parser.getDependency('bufferView', sourceIndex)
    if (!(dependency instanceof ArrayBuffer)) throw new Error(`GLTFLoader did not resolve source bufferView ${sourceIndex}`)
    const bytes = Buffer.from(dependency)
    const sourceView = sourceBufferViews[sourceIndex]
    if (sourceView === undefined) throw new Error(`Source references missing bufferView ${sourceIndex}`)
    const aligned = align4(total)
    if (aligned > total) pieces.push(Buffer.alloc(aligned - total))
    total = aligned
    const nextView = structuredClone(sourceView)
    nextView.buffer = 0
    nextView.byteOffset = total
    nextView.byteLength = bytes.byteLength
    removeMeshoptExtension(nextView)
    viewIndexMap.set(sourceIndex, normalizedViews.length)
    normalizedViews.push(nextView)
    pieces.push(bytes)
    total += bytes.byteLength
  }

  remapBufferViewReferences(document, viewIndexMap)
  const binary = Buffer.concat(pieces)
  document.bufferViews = normalizedViews
  document.buffers = [{ byteLength: binary.byteLength }]
  document.extensionsUsed = withoutExtension(document.extensionsUsed, 'EXT_meshopt_compression')
  document.extensionsRequired = withoutExtension(document.extensionsRequired, 'EXT_meshopt_compression')
  if (document.extensionsUsed?.length === 0) delete document.extensionsUsed
  if (document.extensionsRequired?.length === 0) delete document.extensionsRequired
  return { document, binary }
}

function collectReferencedBufferViews(document) {
  const indexes = new Set()
  const add = (value) => { if (Number.isInteger(value) && value >= 0) indexes.add(value) }
  for (const accessor of document.accessors ?? []) {
    add(accessor?.bufferView)
    add(accessor?.sparse?.indices?.bufferView)
    add(accessor?.sparse?.values?.bufferView)
  }
  for (const image of document.images ?? []) add(image?.bufferView)
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh?.primitives ?? []) add(primitive?.extensions?.KHR_draco_mesh_compression?.bufferView)
  }
  return [...indexes].sort((left, right) => left - right)
}

function remapBufferViewReferences(document, indexMap) {
  const remap = (value, label) => {
    if (!Number.isInteger(value)) return value
    const mapped = indexMap.get(value)
    if (mapped === undefined) throw new Error(`${label} references unresolved bufferView ${value}`)
    return mapped
  }
  for (const [accessorIndex, accessor] of (document.accessors ?? []).entries()) {
    if (Number.isInteger(accessor?.bufferView)) accessor.bufferView = remap(accessor.bufferView, `accessor ${accessorIndex}`)
    if (Number.isInteger(accessor?.sparse?.indices?.bufferView)) accessor.sparse.indices.bufferView = remap(accessor.sparse.indices.bufferView, `accessor ${accessorIndex} sparse indices`)
    if (Number.isInteger(accessor?.sparse?.values?.bufferView)) accessor.sparse.values.bufferView = remap(accessor.sparse.values.bufferView, `accessor ${accessorIndex} sparse values`)
  }
  for (const [imageIndex, image] of (document.images ?? []).entries()) {
    if (Number.isInteger(image?.bufferView)) image.bufferView = remap(image.bufferView, `image ${imageIndex}`)
  }
  for (const [meshIndex, mesh] of (document.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (mesh?.primitives ?? []).entries()) {
      const draco = primitive?.extensions?.KHR_draco_mesh_compression
      if (Number.isInteger(draco?.bufferView)) draco.bufferView = remap(draco.bufferView, `mesh ${meshIndex} primitive ${primitiveIndex} Draco`)
    }
  }
}

function removeMeshoptExtension(bufferView) {
  if (bufferView?.extensions?.EXT_meshopt_compression === undefined) return
  const extensions = { ...bufferView.extensions }
  delete extensions.EXT_meshopt_compression
  if (Object.keys(extensions).length === 0) delete bufferView.extensions
  else bufferView.extensions = extensions
}
function withoutExtension(values, extension) {
  if (!Array.isArray(values)) return undefined
  return [...new Set(values.filter((value) => value !== extension))]
}

function provenanceText() {
  return `# Official Avatar Base · CC0 V1.1\n\n` +
    `This package is generated, not hand-edited. Run \`pnpm avatar:build-official\` to reproduce it.\n\n` +
    `## Original assets\n\n` +
    `- Quaternius, **Universal Base Characters**, CC0 1.0: https://quaternius.com/packs/universalbasecharacters.html\n` +
    `- Quaternius, **Universal Animation Library**, CC0 1.0: https://quaternius.com/packs/universalanimationlibrary.html\n` +
    `- Quaternius, **Ultimate Modular Men Pack**, CC0 1.0: ${OFFICE_OUTFIT_SOURCE.originalPackUrl}\n` +
    `- Quaternius, **Business Man** model listing, Public Domain / CC0: ${OFFICE_OUTFIT_SOURCE.originalModelUrl}\n\n` +
    `The Base/animation deterministic transport mirror records those source families as Quaternius CC0 assets in its pinned ATTRIBUTION.md. ` +
    `Only those explicitly attributed files are consumed; project-authored/commercial-tool character files are excluded.\n\n` +
    `Pinned Base transport snapshot: https://github.com/${SOURCE_REPOSITORY}/commit/${SOURCE_COMMIT}\n` +
    `Pinned Business Man transport: https://github.com/${OFFICE_OUTFIT_SOURCE.repository}/blob/${OFFICE_OUTFIT_SOURCE.commit}/${OFFICE_OUTFIT_SOURCE.path}\n` +
    `Pinned Business Man Git blob: ${OFFICE_OUTFIT_SOURCE.gitBlobSha1}\n\n` +
    `## DSH Cyber conversion\n\n` +
    `- Decodes the Base Meshopt bufferViews through the production Three GLTFLoader, then emits one conventional self-contained GLB buffer.\n` +
    `- Adds VRM 1.0 Humanoid metadata without replacing the source Base rig.\n` +
    `- Rebinds three CC0 hairstyle skins to the same Base skeleton by exact bone name.\n` +
    `- Declares only long-layered, side-part and tech-crop hair mappings; unsupported hairstyles remain on the 2.5D identity fallback.\n` +
    `- Imports only Business Man Suit_Legs, Suit_Feet and the clothing primitives of Suit_Body; Suit_Head and the source Skin primitive are deliberately excluded so an employee keeps the existing Base head, hands and hairstyle.\n` +
    `- Rebinds the older modular-character suit rig semantically onto the Base skeleton and regenerates inverse-bind matrices against that target rig; source game skeleton nodes are not copied.\n` +
    `- The same honest formal suit is exposed as professional and analyst. Engineer/future outfits are intentionally not claimed until a matching CC0 mesh is available.\n\n` +
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
  const result = await buildOfficialAvatarBasePackResolved()
  console.log(`Built ${result.packageManifest.id}@${result.packageManifest.version}`)
  console.log(`Output: ${result.outputRoot}`)
  console.log(`VRM: ${(result.vrmBytes / 1024 / 1024).toFixed(2)} MiB`)
  console.log(`Pinned Base source commit: ${result.sourceCommit}`)
  console.log(`Pinned office-outfit source commit: ${result.officeOutfitSourceCommit}`)
}

const executedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (executedDirectly) main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1 })
