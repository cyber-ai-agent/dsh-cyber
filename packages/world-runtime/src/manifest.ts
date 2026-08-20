import type { WorldThemeAnchorManifest, WorldThemeManifestV1, WorldThemeSceneManifest } from '@dsh-cyber/contracts'

export interface ManifestValidationResult { valid: boolean; errors: string[] }

const RENDERERS = ['pixi-2d', 'pixi-2.5d', 'three-2.5d', 'three-3d'] as const
const FACINGS = ['north', 'east', 'south', 'west'] as const
const ACTIVITIES = ['idle', 'walking', 'thinking', 'working', 'talking', 'meeting', 'blocked', 'celebrating'] as const
const ACTIONS = ['focus', 'talk', 'assign-task', 'inspect', 'use-object', 'start-meeting', 'toggle-lights', 'fit-camera'] as const
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_ERRORS = 200
const MAX_SCENE_DIMENSION = 32_768
const MAX_NAV_CELLS = 1_000_000

export function validateWorldThemeManifest(value: unknown): ManifestValidationResult {
  const errors: string[] = []
  validateBudget(value, errors)
  const root = object(value, 'manifest', ['schemaVersion', 'id', 'version', 'templateId', 'displayName', 'renderer', 'terminology', 'assets', 'actorSets', 'scenes', 'activityMapping'], errors)
  if (root === undefined) return { valid: false, errors }
  if (root.schemaVersion !== 1) error(errors, 'schemaVersion must be 1')
  string(root.id, 'id', errors, ID)
  string(root.version, 'version', errors, SEMVER)
  string(root.templateId, 'templateId', errors, ID)
  string(root.displayName, 'displayName', errors, undefined, 160)
  enumeration(root.renderer, 'renderer', RENDERERS, errors)
  if (!record(root.terminology)) error(errors, 'terminology must be an object')
  else if (Object.keys(root.terminology).length > 128) error(errors, 'terminology exceeds 128 entries')

  const assets = array(root.assets, 'assets', 1, 128, errors)
  const assetIds = new Set<string>()
  assets.forEach((raw, index) => {
    const path = `assets[${index}]`
    const asset = object(raw, path, ['id', 'src', 'kind', 'preload', 'pixelArt'], errors)
    if (asset === undefined) return
    uniqueString(asset.id, `${path}.id`, assetIds, errors)
    const src = string(asset.src, `${path}.src`, errors, undefined, 512)
    if (src !== undefined && !safeAssetPath(src)) error(errors, `${path}.src is unsafe`)
    enumeration(asset.kind, `${path}.kind`, ['image', 'spritesheet'], errors)
    boolean(asset.preload, `${path}.preload`, errors)
    if (asset.pixelArt !== undefined) boolean(asset.pixelArt, `${path}.pixelArt`, errors)
  })

  const actorSets = array(root.actorSets, 'actorSets', 1, 64, errors)
  const actorSetIds = new Set<string>()
  actorSets.forEach((raw, index) => {
    const path = `actorSets[${index}]`
    const actor = object(raw, path, ['id', 'assetId', 'fallbackAssetId', 'frameWidth', 'frameHeight', 'framesPerActor', 'scale', 'footOffset', 'clips'], errors)
    if (actor === undefined) return
    uniqueString(actor.id, `${path}.id`, actorSetIds, errors)
    reference(actor.assetId, `${path}.assetId`, assetIds, errors)
    if (actor.fallbackAssetId !== undefined) reference(actor.fallbackAssetId, `${path}.fallbackAssetId`, assetIds, errors)
    integer(actor.frameWidth, `${path}.frameWidth`, 1, 8192, errors)
    integer(actor.frameHeight, `${path}.frameHeight`, 1, 8192, errors)
    if (actor.framesPerActor !== undefined) integer(actor.framesPerActor, `${path}.framesPerActor`, 1, 4096, errors)
    number(actor.scale, `${path}.scale`, 0.01, 64, errors)
    point(actor.footOffset, `${path}.footOffset`, -8192, 8192, errors)
    clips(actor.clips, `${path}.clips`, errors)
  })

  const scenes = array(root.scenes, 'scenes', 1, 16, errors)
  const sceneIds = new Set<string>()
  scenes.forEach((scene, index) => validateScene(scene, index, assetIds, sceneIds, errors))
  activityMapping(root.activityMapping, errors)
  return { valid: errors.length === 0, errors }
}

export function assertWorldThemeManifest(value: unknown): asserts value is WorldThemeManifestV1 {
  const result = validateWorldThemeManifest(value)
  if (!result.valid) throw new Error(`Invalid world theme manifest: ${result.errors.join('; ')}`)
}

export function getScene(manifest: WorldThemeManifestV1, sceneId?: string): WorldThemeSceneManifest {
  const scene = sceneId === undefined ? manifest.scenes[0] : manifest.scenes.find((candidate) => candidate.id === sceneId)
  if (scene === undefined) throw new Error(`Theme ${manifest.id} has no scene ${sceneId ?? 'default'}`)
  return scene
}

export function getAnchor(scene: WorldThemeSceneManifest, anchorId: string): WorldThemeAnchorManifest {
  const anchor = scene.anchors.find((candidate) => candidate.id === anchorId)
  if (anchor === undefined) throw new Error(`Scene ${scene.id} has no anchor ${anchorId}`)
  return anchor
}

function validateScene(raw: unknown, index: number, assetIds: Set<string>, sceneIds: Set<string>, errors: string[]): void {
  const path = `scenes[${index}]`
  const scene = object(raw, path, ['id', 'displayName', 'size', 'cameraBounds', 'safeArea', 'layers', 'anchors', 'navigation', 'interactables', 'growthSlots'], errors)
  if (scene === undefined) return
  uniqueString(scene.id, `${path}.id`, sceneIds, errors)
  string(scene.displayName, `${path}.displayName`, errors, undefined, 160)
  const size = object(scene.size, `${path}.size`, ['width', 'height'], errors)
  const width = size === undefined ? undefined : number(size.width, `${path}.size.width`, 1, MAX_SCENE_DIMENSION, errors)
  const height = size === undefined ? undefined : number(size.height, `${path}.size.height`, 1, MAX_SCENE_DIMENSION, errors)
  rect(scene.cameraBounds, `${path}.cameraBounds`, errors, width, height)
  rect(scene.safeArea, `${path}.safeArea`, errors, width, height)

  const layerIds = new Set<string>()
  array(scene.layers, `${path}.layers`, 0, 512, errors).forEach((rawLayer, layerIndex) => {
    const itemPath = `${path}.layers[${layerIndex}]`
    const layer = object(rawLayer, itemPath, ['id', 'assetId', 'source', 'destination', 'zIndex', 'alpha', 'occludesActors'], errors)
    if (layer === undefined) return
    uniqueString(layer.id, `${itemPath}.id`, layerIds, errors)
    reference(layer.assetId, `${itemPath}.assetId`, assetIds, errors)
    if (layer.source !== undefined) rect(layer.source, `${itemPath}.source`, errors)
    rect(layer.destination, `${itemPath}.destination`, errors, width, height)
    integer(layer.zIndex, `${itemPath}.zIndex`, -1_000_000, 1_000_000, errors)
    if (layer.alpha !== undefined) number(layer.alpha, `${itemPath}.alpha`, 0, 1, errors)
    if (layer.occludesActors !== undefined) boolean(layer.occludesActors, `${itemPath}.occludesActors`, errors)
  })

  const anchorIds = new Set<string>()
  array(scene.anchors, `${path}.anchors`, 1, 512, errors).forEach((rawAnchor, anchorIndex) => {
    const itemPath = `${path}.anchors[${anchorIndex}]`
    const anchor = object(rawAnchor, itemPath, ['id', 'position', 'facing', 'capacity', 'tags'], errors)
    if (anchor === undefined) return
    uniqueString(anchor.id, `${itemPath}.id`, anchorIds, errors)
    point(anchor.position, `${itemPath}.position`, 0, MAX_SCENE_DIMENSION, errors, width, height)
    enumeration(anchor.facing, `${itemPath}.facing`, FACINGS, errors)
    integer(anchor.capacity, `${itemPath}.capacity`, 1, 1024, errors)
    const tags = new Set<string>()
    array(anchor.tags, `${itemPath}.tags`, 0, 32, errors).forEach((tag, tagIndex) => uniqueString(tag, `${itemPath}.tags[${tagIndex}]`, tags, errors))
  })

  navigation(scene.navigation, `${path}.navigation`, width, height, errors)
  const interactableIds = new Set<string>()
  array(scene.interactables, `${path}.interactables`, 0, 256, errors).forEach((rawInteractable, interactableIndex) => {
    const itemPath = `${path}.interactables[${interactableIndex}]`
    const interactable = object(rawInteractable, itemPath, ['id', 'kind', 'displayName', 'bounds', 'approachAnchorIds', 'actions', 'zIndex'], errors)
    if (interactable === undefined) return
    uniqueString(interactable.id, `${itemPath}.id`, interactableIds, errors)
    string(interactable.kind, `${itemPath}.kind`, errors, ID)
    string(interactable.displayName, `${itemPath}.displayName`, errors, undefined, 160)
    rect(interactable.bounds, `${itemPath}.bounds`, errors, width, height)
    integer(interactable.zIndex, `${itemPath}.zIndex`, -1_000_000, 1_000_000, errors)
    const approaches = new Set<string>()
    array(interactable.approachAnchorIds, `${itemPath}.approachAnchorIds`, 1, 32, errors).forEach((id, approachIndex) => {
      const value = uniqueString(id, `${itemPath}.approachAnchorIds[${approachIndex}]`, approaches, errors)
      if (value !== undefined && !anchorIds.has(value)) error(errors, `interactable ${String(interactable.id)} references missing anchor ${value}`)
    })
    const actionIds = new Set<string>()
    array(interactable.actions, `${itemPath}.actions`, 1, 16, errors).forEach((rawAction, actionIndex) => {
      const actionPath = `${itemPath}.actions[${actionIndex}]`
      const action = object(rawAction, actionPath, ['id', 'label', 'requiredCapability'], errors)
      if (action === undefined) return
      const id = enumeration(action.id, `${actionPath}.id`, ACTIONS, errors)
      if (id !== undefined) duplicate(id, `${actionPath}.id`, actionIds, errors)
      string(action.label, `${actionPath}.label`, errors, undefined, 120)
      if (action.requiredCapability !== undefined) string(action.requiredCapability, `${actionPath}.requiredCapability`, errors, ID)
    })
  })

  const growthIds = new Set<string>()
  array(scene.growthSlots, `${path}.growthSlots`, 0, 256, errors).forEach((rawGrowth, growthIndex) => {
    const itemPath = `${path}.growthSlots[${growthIndex}]`
    const growth = object(rawGrowth, itemPath, ['id', 'category', 'position', 'zIndex'], errors)
    if (growth === undefined) return
    uniqueString(growth.id, `${itemPath}.id`, growthIds, errors)
    string(growth.category, `${itemPath}.category`, errors, ID)
    point(growth.position, `${itemPath}.position`, 0, MAX_SCENE_DIMENSION, errors, width, height)
    integer(growth.zIndex, `${itemPath}.zIndex`, -1_000_000, 1_000_000, errors)
  })
}

function navigation(raw: unknown, path: string, sceneWidth: number | undefined, sceneHeight: number | undefined, errors: string[]): void {
  const value = object(raw, path, ['origin', 'cellSize', 'columns', 'rows', 'blocked'], errors)
  if (value === undefined) return
  const origin = point(value.origin, `${path}.origin`, -MAX_SCENE_DIMENSION, MAX_SCENE_DIMENSION, errors)
  const cellSize = number(value.cellSize, `${path}.cellSize`, 1, 4096, errors)
  const columns = integer(value.columns, `${path}.columns`, 1, 4096, errors)
  const rows = integer(value.rows, `${path}.rows`, 1, 4096, errors)
  if (columns !== undefined && rows !== undefined && columns * rows > MAX_NAV_CELLS) error(errors, `${path} exceeds ${MAX_NAV_CELLS} navigation cells`)
  if (origin !== undefined && cellSize !== undefined && columns !== undefined && sceneWidth !== undefined && (origin.x < -cellSize || origin.x + columns * cellSize > sceneWidth + cellSize)) error(errors, `${path} horizontal grid exceeds scene bounds`)
  if (origin !== undefined && cellSize !== undefined && rows !== undefined && sceneHeight !== undefined && (origin.y < -cellSize || origin.y + rows * cellSize > sceneHeight + cellSize)) error(errors, `${path} vertical grid exceeds scene bounds`)
  const seen = new Set<string>()
  array(value.blocked, `${path}.blocked`, 0, 250_000, errors).forEach((rawCell, index) => {
    const cell = string(rawCell, `${path}.blocked[${index}]`, errors, undefined, 32)
    if (cell === undefined) return
    duplicate(cell, `${path}.blocked[${index}]`, seen, errors)
    const match = /^(0|[1-9]\d*),(0|[1-9]\d*)$/.exec(cell)
    if (match === null) return error(errors, `${path}.blocked[${index}] must be column,row`)
    if ((columns !== undefined && Number(match[1]) >= columns) || (rows !== undefined && Number(match[2]) >= rows)) error(errors, `${path}.blocked[${index}] is outside navigation dimensions`)
  })
}

function clips(raw: unknown, path: string, errors: string[]): void {
  const value = object(raw, path, ACTIVITIES, errors)
  if (value === undefined) return
  let frameCount = 0
  ACTIVITIES.forEach((activity) => {
    if (!(activity in value)) return error(errors, `${path}.${activity} is required`)
    const clip = object(value[activity], `${path}.${activity}`, FACINGS, errors)
    if (clip === undefined) return
    FACINGS.forEach((facing) => {
      if (clip[facing] === undefined) return
      const frames = array(clip[facing], `${path}.${activity}.${facing}`, 1, 256, errors)
      frameCount += frames.length
      frames.forEach((frame, index) => integer(frame, `${path}.${activity}.${facing}[${index}]`, 0, 65535, errors))
    })
  })
  if (frameCount > 4096) error(errors, `${path} exceeds 4096 frames`)
}

function activityMapping(raw: unknown, errors: string[]): void {
  if (!record(raw)) return error(errors, 'activityMapping must be an object')
  const entries = Object.entries(raw)
  if (entries.length > 256) error(errors, 'activityMapping exceeds 256 entries')
  entries.slice(0, 256).forEach(([key, value]) => {
    string(key, `activityMapping.${key}`, errors, undefined, 160)
    enumeration(value, `activityMapping.${key}`, ACTIVITIES, errors)
  })
}

function validateBudget(raw: unknown, errors: string[]): void {
  let nodes = 0
  let bytes = 0
  const visit = (value: unknown, depth: number): void => {
    nodes += 1
    if (nodes > 100_000 || errors.length >= MAX_ERRORS) return
    if (depth > 24) return error(errors, 'manifest exceeds maximum JSON depth 24')
    if (typeof value === 'string') bytes += new TextEncoder().encode(value).byteLength
    if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1))
    else if (record(value)) Object.entries(value).forEach(([key, item]) => {
      bytes += new TextEncoder().encode(key).byteLength
      visit(item, depth + 1)
    })
  }
  visit(raw, 0)
  if (nodes > 100_000) error(errors, 'manifest exceeds 100000 JSON nodes')
  if (bytes > 1_000_000) error(errors, 'manifest exceeds 1000000 UTF-8 string bytes')
}

function object(raw: unknown, path: string, keys: readonly string[], errors: string[]): Record<string, unknown> | undefined {
  if (!record(raw)) { error(errors, `${path} must be an object`); return undefined }
  const allowed = new Set(keys)
  Object.keys(raw).forEach((key) => { if (!allowed.has(key)) error(errors, `${path}.${key} is not allowed`) })
  return raw
}

function array(raw: unknown, path: string, min: number, max: number, errors: string[]): unknown[] {
  if (!Array.isArray(raw)) { error(errors, `${path} must be an array`); return [] }
  if (raw.length < min) error(errors, `${path} must contain at least ${min} item(s)`)
  if (raw.length > max) error(errors, `${path} exceeds ${max} items`)
  return raw.slice(0, max)
}

function string(raw: unknown, path: string, errors: string[], pattern?: RegExp, max = 256): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > max || (pattern !== undefined && !pattern.test(raw))) {
    error(errors, `${path} must be valid non-empty text`)
    return undefined
  }
  return raw
}

function uniqueString(raw: unknown, path: string, seen: Set<string>, errors: string[], max = 256): string | undefined {
  const value = string(raw, path, errors, ID, max)
  if (value !== undefined) duplicate(value, path, seen, errors)
  return value
}

function duplicate(value: string, path: string, seen: Set<string>, errors: string[]): void {
  if (seen.has(value)) error(errors, `${path} duplicates ${value}`)
  seen.add(value)
}

function reference(raw: unknown, path: string, ids: Set<string>, errors: string[]): void {
  const value = string(raw, path, errors, ID)
  if (value !== undefined && !ids.has(value)) error(errors, `${path} references missing asset ${value}`)
}

function enumeration(raw: unknown, path: string, values: readonly string[], errors: string[]): string | undefined {
  if (typeof raw !== 'string' || !values.includes(raw)) { error(errors, `${path} has an invalid enum value`); return undefined }
  return raw
}

function number(raw: unknown, path: string, min: number, max: number, errors: string[]): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) { error(errors, `${path} must be a finite number between ${min} and ${max}`); return undefined }
  return raw
}

function integer(raw: unknown, path: string, min: number, max: number, errors: string[]): number | undefined {
  const value = number(raw, path, min, max, errors)
  if (value !== undefined && !Number.isSafeInteger(value)) { error(errors, `${path} must be a safe integer`); return undefined }
  return value
}

function boolean(raw: unknown, path: string, errors: string[]): void {
  if (typeof raw !== 'boolean') error(errors, `${path} must be boolean`)
}

function point(raw: unknown, path: string, min: number, max: number, errors: string[], sceneWidth?: number, sceneHeight?: number): { x: number; y: number } | undefined {
  const value = object(raw, path, ['x', 'y'], errors)
  if (value === undefined) return undefined
  const x = number(value.x, `${path}.x`, min, max, errors)
  const y = number(value.y, `${path}.y`, min, max, errors)
  if (x === undefined || y === undefined) return undefined
  if (sceneWidth !== undefined && x > sceneWidth) error(errors, `${path}.x exceeds scene width`)
  if (sceneHeight !== undefined && y > sceneHeight) error(errors, `${path}.y exceeds scene height`)
  return { x, y }
}

function rect(raw: unknown, path: string, errors: string[], sceneWidth?: number, sceneHeight?: number): void {
  const value = object(raw, path, ['x', 'y', 'width', 'height'], errors)
  if (value === undefined) return
  const x = number(value.x, `${path}.x`, -MAX_SCENE_DIMENSION, MAX_SCENE_DIMENSION, errors)
  const y = number(value.y, `${path}.y`, -MAX_SCENE_DIMENSION, MAX_SCENE_DIMENSION, errors)
  const width = number(value.width, `${path}.width`, 0.001, MAX_SCENE_DIMENSION, errors)
  const height = number(value.height, `${path}.height`, 0.001, MAX_SCENE_DIMENSION, errors)
  if (x !== undefined && width !== undefined && sceneWidth !== undefined && (x < 0 || x + width > sceneWidth)) error(errors, `${path} exceeds scene width`)
  if (y !== undefined && height !== undefined && sceneHeight !== undefined && (y < 0 || y + height > sceneHeight)) error(errors, `${path} exceeds scene height`)
}

function safeAssetPath(value: string): boolean {
  const path = value.startsWith('/assets/') ? value.slice(1) : value
  return path !== '' && !path.includes('\\') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !/[?#\u0000-\u001f]/.test(path) && !/^[a-z][a-z0-9+.-]*:/i.test(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function error(errors: string[], message: string): void { if (errors.length < MAX_ERRORS) errors.push(message) }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
