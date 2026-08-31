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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_ROOT = join(ROOT, 'marketplace', 'plugins', 'official-avatar-base-v1')
const CACHE_ROOT = join(ROOT, '.private', 'avatar-source-cache', 'official-avatar-base-v1')
const WEB_PACKAGE = pathToFileURL(join(ROOT, 'packages', 'web', 'package.json'))
const webRequire = createRequire(WEB_PACKAGE)
const SOURCE_REPOSITORY = 'fastrouter/experiments-costa-vista'
const SOURCE_COMMIT = '23e87108a281ac827e2ea23691aa7bf4b544146e'
const PACK_ID = 'official-avatar-base-v1'
const PACK_VERSION = '1.0.0'

/**
 * Builds the official pack from the exact pinned CC0 source while delegating
 * source-GLB semantics to the same Three GLTFLoader used by the product.
 *
 * The source is Meshopt-compressed and contains authoring-time logical buffers
 * that are not useful to the final character. Rather than copying that transport
 * layout, the authoring pipeline asks GLTFLoader for every bufferView actually
 * referenced by accessors/images, which also performs Meshopt decoding. Those
 * resolved views are then packed into one conventional embedded GLB buffer.
 * The generated VRM therefore has no external buffer and no Meshopt dependency.
 */
export async function buildOfficialAvatarBasePackResolved(options = {}) {
  const outputRoot = resolve(options.outputRoot ?? OUTPUT_ROOT)
  const cacheRoot = resolve(options.cacheRoot ?? CACHE_ROOT)
  const fetchImpl = options.fetchImpl ?? fetch
  await mkdir(cacheRoot, { recursive: true })

  const baseBytes = await loadPinnedSource(SOURCE_FILES.base, cacheRoot, fetchImpl)
  let base = await normalizeSourceGlbWithProductionLoader(baseBytes)
  const outfitMeshNames = markBaseAsCasualAvatar(base.document)
  const humanBones = inferHumanoidBones(base.document.nodes ?? [])
  injectVrm1Extension(base.document, humanBones)
  normalizeVrm1LicenseMetadata(base.document)

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
  assertBuiltVrm(vrmBytes)

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(join(outputRoot, 'models'), { recursive: true })
  await writeFile(join(outputRoot, 'models', 'neutral.vrm'), vrmBytes)

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
    materialSlots: [{ id: 'hair', materialNames: ['DSH_Hair'] }],
  }
  const packManifestBytes = Buffer.from(`${JSON.stringify(packManifest, null, 2)}\n`, 'utf8')
  await writeFile(join(outputRoot, 'avatar-base-pack.json'), packManifestBytes)

  const provenanceBytes = Buffer.from(provenanceText(), 'utf8')
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

/**
 * VRM 1.0 reserves meta.licenseUrl for the VRM license schema itself. The
 * original asset license belongs in otherLicenseUrl/thirdPartyLicenses. Keeping
 * those two concepts separate is required by @pixiv/three-vrm's production
 * loader and preserves the CC0 provenance without abusing the VRM field.
 */
export function normalizeVrm1LicenseMetadata(document) {
  const meta = document?.extensions?.VRMC_vrm?.meta
  if (meta === undefined || meta === null || typeof meta !== 'object') {
    throw new Error('Generated VRM metadata is missing')
  }
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
  const add = (value) => {
    if (!Number.isInteger(value) || value < 0) return
    indexes.add(value)
  }

  for (const accessor of document.accessors ?? []) {
    add(accessor?.bufferView)
    add(accessor?.sparse?.indices?.bufferView)
    add(accessor?.sparse?.values?.bufferView)
  }
  for (const image of document.images ?? []) add(image?.bufferView)
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh?.primitives ?? []) {
      add(primitive?.extensions?.KHR_draco_mesh_compression?.bufferView)
    }
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
    if (Number.isInteger(accessor?.sparse?.indices?.bufferView)) {
      accessor.sparse.indices.bufferView = remap(accessor.sparse.indices.bufferView, `accessor ${accessorIndex} sparse indices`)
    }
    if (Number.isInteger(accessor?.sparse?.values?.bufferView)) {
      accessor.sparse.values.bufferView = remap(accessor.sparse.values.bufferView, `accessor ${accessorIndex} sparse values`)
    }
  }
  for (const [imageIndex, image] of (document.images ?? []).entries()) {
    if (Number.isInteger(image?.bufferView)) image.bufferView = remap(image.bufferView, `image ${imageIndex}`)
  }
  for (const [meshIndex, mesh] of (document.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (mesh?.primitives ?? []).entries()) {
      const draco = primitive?.extensions?.KHR_draco_mesh_compression
      if (Number.isInteger(draco?.bufferView)) {
        draco.bufferView = remap(draco.bufferView, `mesh ${meshIndex} primitive ${primitiveIndex} Draco`)
      }
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
  return `# Official Avatar Base · CC0 V1\n\n` +
    `This package is generated, not hand-edited. Run \`pnpm avatar:build-official\` to reproduce it.\n\n` +
    `## Original assets\n\n` +
    `- Quaternius, **Universal Base Characters**, CC0 1.0: https://quaternius.com/packs/universalbasecharacters.html\n` +
    `- Quaternius, **Universal Animation Library**, CC0 1.0: https://quaternius.com/packs/universalanimationlibrary.html\n\n` +
    `The deterministic transport mirror records those source families as Quaternius CC0 assets in its pinned ATTRIBUTION.md. ` +
    `Only those explicitly attributed files are consumed; project-authored/commercial-tool character files are excluded.\n\n` +
    `Pinned transport snapshot: https://github.com/${SOURCE_REPOSITORY}/commit/${SOURCE_COMMIT}\n\n` +
    `## DSH Cyber conversion\n\n` +
    `- Decodes the source Meshopt bufferViews through the production Three GLTFLoader, then emits one conventional self-contained GLB buffer.\n` +
    `- Adds VRM 1.0 Humanoid metadata without replacing the source rig.\n` +
    `- Rebinds three CC0 hairstyle skins to the same Base skeleton by exact bone name.\n` +
    `- Declares only long-layered, side-part and tech-crop hair mappings; unsupported hairstyles remain on the 2.5D identity fallback.\n` +
    `- Declares the source body only as casual. It is intentionally not labelled professional/analyst/engineer.\n\n` +
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
  console.log(`Pinned source commit: ${result.sourceCommit}`)
}

const executedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (executedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
