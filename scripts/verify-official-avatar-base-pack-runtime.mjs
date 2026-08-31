import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VRM_PATH = resolve(ROOT, 'marketplace', 'plugins', 'official-avatar-base-v1', 'models', 'neutral.vrm')
const WEB_PACKAGE = pathToFileURL(join(ROOT, 'packages', 'web', 'package.json'))
const webRequire = createRequire(WEB_PACKAGE)
const REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'rightUpperArm',
  'leftUpperLeg', 'rightUpperLeg',
]
const REQUIRED_VARIANT_NODES = ['Hair_Long', 'Hair_SidePart', 'Hair_TechCrop']

async function main() {
  // Resolve from @dsh-cyber/web, where production actually declares these
  // dependencies. The decoder is deliberately the same Three addon VrmActor
  // enables at runtime, so a CI pass proves the shipped compressed transport.
  const [{ VRMLoaderPlugin }, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import(pathToFileURL(webRequire.resolve('@pixiv/three-vrm')).href),
    import(pathToFileURL(webRequire.resolve('three/addons/loaders/GLTFLoader.js')).href),
    import(pathToFileURL(webRequire.resolve('three/addons/libs/meshopt_decoder.module.js')).href),
  ])

  const body = await readFile(VRM_PATH)
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  const gltf = await loader.parseAsync(arrayBuffer, '')
  const vrm = gltf.userData.vrm
  if (vrm === undefined) throw new Error('Generated official avatar did not produce a VRM runtime object')

  for (const bone of REQUIRED_BONES) {
    if (vrm.humanoid.getNormalizedBoneNode(bone) === null) {
      throw new Error(`Generated official avatar is missing normalized VRM bone: ${bone}`)
    }
  }

  const names = new Set()
  vrm.scene.traverse((object) => {
    if (object.name) names.add(object.name)
  })
  for (const name of REQUIRED_VARIANT_NODES) {
    if (!names.has(name)) throw new Error(`Generated official avatar is missing managed variant node: ${name}`)
  }
  if (![...names].some((name) => name.startsWith('Outfit_Casual_'))) {
    throw new Error('Generated official avatar is missing the managed casual Base mesh')
  }

  const animations = gltf.animations.map((clip) => clip.name).filter(Boolean)
  console.log(`Production VRM loader accepted ${VRM_PATH}`)
  console.log(`Scene objects: ${names.size}`)
  console.log(`Embedded animation clips: ${animations.length}`)
  if (animations.length > 0) console.log(`Animation names: ${animations.slice(0, 24).join(', ')}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
