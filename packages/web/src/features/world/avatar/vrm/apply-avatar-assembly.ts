import type { Material, Mesh, Object3D } from 'three'

import type { AvatarAssemblyPlan, AvatarBasePackManifest, AvatarMaterialSlotId } from '../avatar-base-pack.js'
import { materialNamesFor } from '../avatar-base-pack.js'

/**
 * Applies the cheap per-character layer to one already parsed Base VRM.
 *
 * Base VRM bytes are shared by cache key, but each actor is parsed into its own
 * humanoid instance, so mutating visibility and colour here cannot move another
 * employee's bones. Material cloning is still required: glTF loaders may share
 * one Material object among several meshes inside that actor and a slot change
 * must not accidentally recolour an unrelated named surface.
 */
export function applyAvatarAssembly(root: Object3D, pack: AvatarBasePackManifest, plan: AvatarAssemblyPlan): void {
  const managed = new Set(plan.managedMeshNames)
  const visible = new Set(plan.visibleMeshNames)
  const coloursByMaterial = materialColourMap(pack, plan)

  root.traverse((object) => {
    if (managed.has(object.name)) object.visible = visible.has(object.name)
    const mesh = object as Mesh
    if (mesh.isMesh !== true || mesh.material === undefined) return
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => materialWithColour(material, coloursByMaterial.get(material.name)))
      return
    }
    mesh.material = materialWithColour(mesh.material, coloursByMaterial.get(mesh.material.name))
  })
}

function materialColourMap(pack: AvatarBasePackManifest, plan: AvatarAssemblyPlan): Map<string, string> {
  const result = new Map<string, string>()
  for (const [slot, colour] of Object.entries(plan.materialColours) as Array<[AvatarMaterialSlotId, string | undefined]>) {
    if (colour === undefined) continue
    for (const name of materialNamesFor(pack, slot)) result.set(name, colour)
  }
  return result
}

function materialWithColour(material: Material, colour: string | undefined): Material {
  if (colour === undefined) return material
  const candidate = material as Material & { color?: { set(value: string): unknown } }
  if (candidate.color?.set === undefined) return material
  const clone = material.clone() as Material & { color?: { set(value: string): unknown } }
  clone.color?.set(colour)
  return clone
}
