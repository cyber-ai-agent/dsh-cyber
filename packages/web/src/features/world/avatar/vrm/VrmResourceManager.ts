import type { BufferGeometry, Material, Object3D, Texture } from 'three'

export function disposeVrmScene(scene: Object3D): void {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  scene.traverse((object) => {
    const mesh = object as import('three').Mesh
    if (mesh.geometry !== undefined) geometries.add(mesh.geometry)
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : mesh.material === undefined ? [] : [mesh.material]
    for (const material of meshMaterials) {
      materials.add(material)
      for (const value of Object.values(material)) if (isTexture(value)) textures.add(value)
    }
  })
  for (const texture of textures) texture.dispose()
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}

function isTexture(value: unknown): value is Texture {
  return value !== null && typeof value === 'object' && 'isTexture' in value && (value as Texture).isTexture
}
