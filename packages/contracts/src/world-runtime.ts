import type { EmployeeStatus, IsoTimestamp, JsonObject, WorldCharacterRole } from './index.js'

export const WORLD_RUNTIME_CONTRACT_VERSION = 1 as const

export type RendererKind = 'pixi-2d' | 'pixi-2.5d' | 'three-2.5d' | 'three-3d'

export type WorldFacing = 'north' | 'east' | 'south' | 'west'

export type WorldActivityKind =
  | 'idle'
  | 'walking'
  | 'thinking'
  | 'working'
  | 'talking'
  | 'meeting'
  | 'blocked'
  | 'celebrating'

export type WorldEntityKind = 'agent' | 'object' | 'decoration' | 'milestone'

export interface WorldPoint {
  x: number
  y: number
}

export interface WorldRect extends WorldPoint {
  width: number
  height: number
}

export interface WorldRuntimeEntityState {
  id: string
  kind: WorldEntityKind
  sceneId: string
  sourceId?: string
  displayName: string
  role?: string
  anchorId?: string
  targetAnchorId?: string
  position: WorldPoint
  targetPosition?: WorldPoint
  footOffset: WorldPoint
  facing: WorldFacing
  activity: WorldActivityKind
  activityLabel: string
  status?: EmployeeStatus
  /** Compact world-scoped authority projection used by renderers for badges. */
  authorityRole?: WorldCharacterRole
  activityRef?: string
  targetEntityId?: string
  route: WorldPoint[]
  visualState: JsonObject
  updatedAt: IsoTimestamp
}

export interface WorldRuntimeObjectState {
  id: string
  sceneId: string
  kind: string
  displayName: string
  anchorId: string
  state: 'idle' | 'active' | 'warning' | 'complete'
  activityLabel: string
  visualState: JsonObject
  updatedAt: IsoTimestamp
}

export interface WorldRuntimeClockState {
  now: IsoTimestamp
  timezone: string
  lightsOn: boolean
}

export interface WorldRuntimeSnapshot {
  contractVersion: typeof WORLD_RUNTIME_CONTRACT_VERSION
  workspaceId: string
  worldId: string
  templateId: string
  themeId: string
  sceneId: string
  sequence: number
  generatedAt: IsoTimestamp
  clock: WorldRuntimeClockState
  entities: WorldRuntimeEntityState[]
  objects: WorldRuntimeObjectState[]
  growthSlots: Record<string, string[]>
}

export type WorldCueKind =
  | 'entity.spawned'
  | 'entity.route'
  | 'entity.activity'
  | 'entity.focus'
  | 'entity.speech'
  | 'object.state'
  | 'meeting.gather'
  | 'meeting.disperse'
  | 'growth.unlocked'
  | 'scene.lights'

export interface WorldCue {
  id: string
  worldId: string
  sequence: number
  kind: WorldCueKind
  entityId?: string
  objectId?: string
  payload: JsonObject
  createdAt: IsoTimestamp
}

export type WorldRuntimeStreamEventKind =
  | 'runtime'
  | 'domain'
  /** A pending decision was created, decided, consumed or expired. */
  | 'world-decision'
  | 'world-state'
  | 'world-cue'
  | 'heartbeat'
  | 'recovery-required'

export interface WorldRuntimeStreamEnvelope {
  contractVersion: typeof WORLD_RUNTIME_CONTRACT_VERSION
  id: string
  worldId: string
  sequence: number
  kind: WorldRuntimeStreamEventKind
  payload: JsonObject
  createdAt: IsoTimestamp
}

export type WorldInteractionAction =
  | 'focus'
  | 'talk'
  | 'assign-task'
  | 'inspect'
  | 'use-object'
  | 'start-meeting'
  | 'toggle-lights'
  | 'fit-camera'

export interface WorldInteractionRequest {
  action: WorldInteractionAction
  actorId: string
  entityId?: string
  objectId?: string
  participantIds?: string[]
  prompt?: string
  metadata?: JsonObject
}

export interface WorldInteractionResult {
  accepted: boolean
  eventId: string
  status: 'pending' | 'completed'
  snapshot: WorldRuntimeSnapshot
  cues: WorldCue[]
}

export interface WorldRendererCallbacks {
  onEntitySelect(entityId: string): void
  onObjectSelect(objectId: string): void
  onEntityContext?(entityId: string, position: WorldPoint): void
  onObjectContext?(objectId: string, position: WorldPoint): void
  onReady?(metrics: { initializationMs: number; assetBytesEstimate: number }): void
}

export interface WorldRenderer<Host = unknown> {
  readonly kind: RendererKind
  mount(host: Host, manifest: WorldThemeManifestV1, snapshot: WorldRuntimeSnapshot): Promise<void>
  updateSnapshot(snapshot: WorldRuntimeSnapshot): void
  applyCues(cues: WorldCue[]): void
  selectEntity(entityId?: string): void
  selectObject(objectId?: string): void
  focusEntity(entityId: string): void
  fitScene(): void
  zoomBy(delta: number): void
  getZoom(): number
  destroy(): void
}

export type WorldRendererFactory<Host = unknown> = (
  callbacks: WorldRendererCallbacks,
) => WorldRenderer<Host>

export interface RendererRegistry<Host = unknown> {
  register(kind: RendererKind, factory: WorldRendererFactory<Host>): void
  supports(kind: RendererKind): boolean
  create(kind: RendererKind, callbacks: WorldRendererCallbacks): WorldRenderer<Host>
}

export interface WorldZoomCommand {
  id: string
  delta: 0.1 | -0.1
}

export interface WorldThemeAssetManifest {
  id: string
  src: string
  kind: 'image' | 'spritesheet'
  preload: boolean
  pixelArt?: boolean
}

export interface WorldThemeLayerManifest {
  id: string
  assetId: string
  source?: WorldRect
  destination: WorldRect
  zIndex: number
  alpha?: number
  occludesActors?: boolean
}

export interface WorldThemeAnchorManifest {
  id: string
  position: WorldPoint
  facing: WorldFacing
  capacity: number
  tags: string[]
}

export interface WorldThemeNavigationManifest {
  origin: WorldPoint
  cellSize: number
  columns: number
  rows: number
  blocked: string[]
}

export interface WorldThemeActionManifest {
  id: WorldInteractionAction
  label: string
  requiredCapability?: string
}

export interface WorldThemeInteractableManifest {
  id: string
  kind: string
  displayName: string
  bounds: WorldRect
  approachAnchorIds: string[]
  actions: WorldThemeActionManifest[]
  zIndex: number
}

export interface WorldThemeActorSetManifest {
  id: string
  assetId: string
  fallbackAssetId?: string
  frameWidth: number
  frameHeight: number
  framesPerActor?: number
  scale: number
  footOffset: WorldPoint
  clips: Record<WorldActivityKind, Partial<Record<WorldFacing, number[]>>>
}

export interface WorldThemeGrowthSlotManifest {
  id: string
  category: string
  position: WorldPoint
  zIndex: number
}

export interface WorldThemeSceneManifest {
  id: string
  displayName: string
  size: { width: number; height: number }
  cameraBounds: WorldRect
  safeArea: WorldRect
  layers: WorldThemeLayerManifest[]
  anchors: WorldThemeAnchorManifest[]
  navigation: WorldThemeNavigationManifest
  interactables: WorldThemeInteractableManifest[]
  growthSlots: WorldThemeGrowthSlotManifest[]
}

export interface WorldThemeManifestV1 {
  schemaVersion: 1
  id: string
  version: string
  templateId: string
  displayName: string
  renderer: RendererKind
  terminology: JsonObject
  assets: WorldThemeAssetManifest[]
  actorSets: WorldThemeActorSetManifest[]
  scenes: WorldThemeSceneManifest[]
  activityMapping: Partial<Record<string, WorldActivityKind>>
}

export interface WorldThemeIdentity {
  packageId: string
  packageVersion: string
  themeId: string
  themeVersion: string
  contentDigest: string
}

export interface WorldThemeBinding extends WorldThemeIdentity {
  worldId: string
  status: 'active' | 'disabled'
  manifest: WorldThemeManifestV1
  updatedAt: IsoTimestamp
}

export interface WorldThemeOption {
  themeId: string
  version: string
  displayName: string
  templateId: string
  source: 'built-in' | 'installed'
  active: boolean
  packageId?: string
  packageVersion?: string
  contentDigest: string
}
