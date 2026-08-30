import type { Object3D, Texture } from 'three'

export function disposeVrmScene(scene: Object3D): void {
  scene.traverse((object) => {
    const mesh = object as import('three').Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material === undefined ? [] : [mesh.material]
    for (const material of materials) {
      for (const value of Object.values(material)) if (isTexture(value)) value.dispose()
      material.dispose()
    }
  })
}

function isTexture(value: unknown): value is Texture {
  return value !== null && typeof value === 'object' && 'isTexture' in value && (value as Texture).isTexture
}
