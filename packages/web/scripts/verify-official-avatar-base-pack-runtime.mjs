import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const VRM_PATH = resolve(ROOT, 'marketplace', 'plugins', 'official-avatar-base-v1', 'models', 'neutral.vrm')
const REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'rightUpperArm',
  'leftUpperLeg', 'rightUpperLeg',
]
const REQUIRED_VARIANT_NODES = ['Hair_Long', 'Hair_SidePart', 'Hair_TechCrop']
const REQUIRED_OFFICE_NODES = ['Outfit_Professional_Legs', 'Outfit_Professional_Feet', 'Outfit_Professional_Body']
const REQUIRED_OFFICE_MATERIALS = ['DSH_Office_Outfit', 'DSH_Office_Accent']
const REQUIRED_EMBEDDED_MOTIONS = ['Idle_Loop', 'Walk_Loop', 'Idle_Talking_Loop', 'Interact']
const FORBIDDEN_SOURCE_BONES = new Set(['Root', 'Body', 'Hips', 'Abdomen', 'Torso', 'Chest', 'UpperArm.L', 'UpperArm.R'])

async function main() {
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
  const materials = new Set()
  const objects = new Map()
  vrm.scene.traverse((object) => {
    if (object.name) {
      names.add(object.name)
      objects.set(object.name, object)
    }
    if ('material' in object) {
      const list = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of list) if (material?.name) materials.add(material.name)
    }
  })
  for (const name of REQUIRED_VARIANT_NODES) {
    if (!names.has(name)) throw new Error(`Generated official avatar is missing managed variant node: ${name}`)
  }
  if (![...names].some((name) => name.startsWith('Outfit_Casual_'))) {
    throw new Error('Generated official avatar is missing the managed casual Base mesh')
  }
  if (names.has('Suit_Head')) throw new Error('Generated official avatar accidentally imported the source identity head')
  for (const name of REQUIRED_OFFICE_NODES) {
    const object = objects.get(name)
    if (object === undefined || object.isSkinnedMesh !== true) {
      throw new Error(`Generated official avatar is missing skinned office outfit node: ${name}`)
    }
    for (const bone of object.skeleton.bones) {
      if (FORBIDDEN_SOURCE_BONES.has(bone.name)) {
        throw new Error(`Office outfit still depends on copied source skeleton bone: ${bone.name}`)
      }
    }
  }
  for (const material of REQUIRED_OFFICE_MATERIALS) {
    if (!materials.has(material)) throw new Error(`Generated official avatar is missing managed office material: ${material}`)
  }

  const animationByName = new Map(gltf.animations.filter((clip) => clip.name).map((clip) => [clip.name, clip]))
  for (const name of REQUIRED_EMBEDDED_MOTIONS) {
    const clip = animationByName.get(name)
    if (clip === undefined || clip.tracks.length === 0) {
      throw new Error(`Generated official avatar is missing required embedded motion: ${name}`)
    }
  }
  const animations = [...animationByName.keys()]
  console.log(`Production Web VRM loader accepted ${VRM_PATH}`)
  console.log(`Scene objects: ${names.size}`)
  console.log(`Managed office nodes: ${REQUIRED_OFFICE_NODES.join(', ')}`)
  console.log(`Managed office materials: ${REQUIRED_OFFICE_MATERIALS.join(', ')}`)
  console.log(`Embedded animation clips: ${animations.length}`)
  if (animations.length > 0) console.log(`Animation names: ${animations.join(', ')}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
