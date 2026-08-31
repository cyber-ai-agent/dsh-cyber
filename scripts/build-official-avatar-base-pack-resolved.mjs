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
 * The source is Meshopt-compressed. We keep that compression intact and rewrite
 * both ordinary bufferView locations and EXT_meshopt_compression locations into
 * one self-contained output buffer. The same decoder is enabled in VrmActor and
 * in the final production-loader verifier, so build-time and runtime capability
 * stay identical.
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
  const bufferViews = Array.isArray(document.bufferViews) ? document.bufferViews : []
  const referencedSet = new Set()
  for (const view of bufferViews) {
    referencedSet.add(Number.isInteger(view?.buffer) ? view.buffer : 0)
    const meshopt = view?.extensions?.EXT_meshopt_compression
    if (meshopt !== undefined) referencedSet.add(Number.isInteger(meshopt.buffer) ? meshopt.buffer : 0)
  }
  const referenced = [...referencedSet].sort((a, b) => a - b)
  if (referenced.length === 0) throw new Error('CC0 base does not reference any renderable buffer')

  const resolved = new Map()
  for (const bufferIndex of referenced) {
    const dependency = await parser.getDependency('buffer', bufferIndex)
    if (!(dependency instanceof ArrayBuffer)) throw new Error(`GLTFLoader did not resolve source buffer ${bufferIndex}`)
    resolved.set(bufferIndex, Buffer.from(dependency))
  }

  const offsets = new Map()
  const pieces = []
  let total = 0
  for (const bufferIndex of referenced) {
    const bytes = resolved.get(bufferIndex)
    const aligned = align4(total)
    if (aligned > total) pieces.push(Buffer.alloc(aligned - total))
    total = aligned
    offsets.set(bufferIndex, total)
    pieces.push(bytes)
    total += bytes.byteLength
  }
  const binary = Buffer.concat(pieces)

  for (const [viewIndex, view] of bufferViews.entries()) {
    rewriteRange(view, viewIndex, 'bufferView', resolved, offsets)
    const meshopt = view?.extensions?.EXT_meshopt_compression
    if (meshopt !== undefined) rewriteRange(meshopt, viewIndex, 'Meshopt bufferView', resolved, offsets)
  }

  document.buffers = [{ byteLength: binary.byteLength }]
  return { document, binary }
}

function rewriteRange(range, viewIndex, label, resolved, offsets) {
  const sourceBuffer = Number.isInteger(range?.buffer) ? range.buffer : 0
  const bytes = resolved.get(sourceBuffer)
  const baseOffset = offsets.get(sourceBuffer)
  if (bytes === undefined || baseOffset === undefined) throw new Error(`${label} ${viewIndex} references unresolved buffer ${sourceBuffer}`)
  const relativeOffset = range.byteOffset ?? 0
  const byteLength = range.byteLength
  if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0 || relativeOffset + byteLength > bytes.byteLength) {
    throw new Error(`${label} ${viewIndex} exceeds GLTFLoader-resolved buffer ${sourceBuffer}`)
  }
  range.buffer = 0
  range.byteOffset = baseOffset + relativeOffset
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
    `- Resolves the Meshopt-compressed source with the production Three GLTFLoader and keeps the compression self-contained.\n` +
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
