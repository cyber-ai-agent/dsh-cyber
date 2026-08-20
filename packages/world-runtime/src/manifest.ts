import type {
  WorldThemeAnchorManifest,
  WorldThemeManifestV1,
  WorldThemeSceneManifest,
} from '@dsh-cyber/contracts'

export interface ManifestValidationResult {
  valid: boolean
  errors: string[]
}

export function validateWorldThemeManifest(value: unknown): ManifestValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { valid: false, errors: ['manifest must be an object'] }
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (value.renderer !== 'pixi-v8') errors.push('renderer must be pixi-v8')
  requireText(value, 'id', errors)
  requireText(value, 'version', errors)
  requireText(value, 'templateId', errors)
  requireText(value, 'displayName', errors)

  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    errors.push('assets must contain at least one asset')
  }
  if (!Array.isArray(value.actorSets) || value.actorSets.length === 0) {
    errors.push('actorSets must contain at least one actor set')
  }
  if (!Array.isArray(value.scenes) || value.scenes.length === 0) {
    errors.push('scenes must contain at least one scene')
  } else {
    for (const [index, scene] of value.scenes.entries()) {
      validateScene(scene, index, errors)
    }
  }

  const assetIds = new Set(
    Array.isArray(value.assets)
      ? value.assets.filter(isRecord).map((asset) => String(asset.id ?? ''))
      : [],
  )
  if (Array.isArray(value.scenes)) {
    for (const scene of value.scenes.filter(isRecord)) {
      if (!Array.isArray(scene.layers)) continue
      for (const layer of scene.layers.filter(isRecord)) {
        if (!assetIds.has(String(layer.assetId ?? ''))) {
          errors.push(`scene ${String(scene.id ?? '?')} layer ${String(layer.id ?? '?')} references missing asset`)
        }
      }
    }
  }
  if (Array.isArray(value.actorSets)) {
    for (const actorSet of value.actorSets.filter(isRecord)) {
      if (!assetIds.has(String(actorSet.assetId ?? ''))) {
        errors.push(`actor set ${String(actorSet.id ?? '?')} references missing asset`)
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

export function assertWorldThemeManifest(value: unknown): asserts value is WorldThemeManifestV1 {
  const result = validateWorldThemeManifest(value)
  if (!result.valid) throw new Error(`Invalid world theme manifest: ${result.errors.join('; ')}`)
}

export function getScene(
  manifest: WorldThemeManifestV1,
  sceneId?: string,
): WorldThemeSceneManifest {
  const scene = sceneId === undefined
    ? manifest.scenes[0]
    : manifest.scenes.find((candidate) => candidate.id === sceneId)
  if (scene === undefined) throw new Error(`Theme ${manifest.id} has no scene ${sceneId ?? 'default'}`)
  return scene
}

export function getAnchor(
  scene: WorldThemeSceneManifest,
  anchorId: string,
): WorldThemeAnchorManifest {
  const anchor = scene.anchors.find((candidate) => candidate.id === anchorId)
  if (anchor === undefined) throw new Error(`Scene ${scene.id} has no anchor ${anchorId}`)
  return anchor
}

function validateScene(value: unknown, index: number, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`scenes[${index}] must be an object`)
    return
  }
  requireText(value, 'id', errors, `scenes[${index}].`)
  const anchors = Array.isArray(value.anchors) ? value.anchors.filter(isRecord) : []
  const anchorIds = new Set(anchors.map((anchor) => String(anchor.id ?? '')))
  if (anchors.length === 0) errors.push(`scenes[${index}].anchors must not be empty`)
  if (!Array.isArray(value.interactables)) {
    errors.push(`scenes[${index}].interactables must be an array`)
  } else {
    for (const interactable of value.interactables.filter(isRecord)) {
      const ids = Array.isArray(interactable.approachAnchorIds)
        ? interactable.approachAnchorIds.map(String)
        : []
      for (const id of ids) {
        if (!anchorIds.has(id)) {
          errors.push(`interactable ${String(interactable.id ?? '?')} references missing anchor ${id}`)
        }
      }
    }
  }
  if (!isRecord(value.navigation)) errors.push(`scenes[${index}].navigation must be an object`)
}

function requireText(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  prefix = '',
): void {
  if (typeof record[key] !== 'string' || record[key] === '') errors.push(`${prefix}${key} must be text`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
