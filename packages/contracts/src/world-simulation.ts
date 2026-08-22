import type { EmployeeStatus, IsoTimestamp, JsonObject } from './index.js'
import type {
  WorldFacing,
  WorldPoint,
  WorldRect,
  WorldThemeNavigationManifest,
} from './world-runtime.js'

export const WORLD_SIMULATION_CONTRACT_VERSION = 1 as const

export type WorldZoneKind =
  | 'administration'
  | 'engineering'
  | 'research'
  | 'operations'
  | 'meeting'
  | 'rest'
  | 'public'
  | 'custom'

export type WorldSlotKind =
  | 'home'
  | 'work'
  | 'approach'
  | 'seat'
  | 'operate'
  | 'conversation'
  | 'waiting'
  | 'rest'

export interface WorldZoneDefinition {
  id: string
  sceneId: string
  kind: WorldZoneKind
  displayName: string
  bounds: WorldRect
  tags: string[]
  capacity: number
}

export interface WorldSlotDefinition {
  id: string
  sceneId: string
  zoneId: string
  facilityId?: string
  anchorId: string
  kind: WorldSlotKind
  position: WorldPoint
  facing: WorldFacing
  posture: 'stand' | 'sit'
  capacity: number
  exclusive: boolean
  tags: string[]
}

export interface WorldFacilityDefinition {
  id: string
  sceneId: string
  zoneId: string
  kind: string
  displayName: string
  capabilities: string[]
  slotIds: string[]
  metadata: JsonObject
}

export interface CompiledWorldSemantics {
  contractVersion: typeof WORLD_SIMULATION_CONTRACT_VERSION
  themeId: string
  sceneId: string
  navigation?: WorldThemeNavigationManifest
  zones: WorldZoneDefinition[]
  facilities: WorldFacilityDefinition[]
  slots: WorldSlotDefinition[]
}

export interface CharacterBehaviorProfile {
  id: string
  roleTags: string[]
  preferredZoneTags: string[]
  preferredFacilityCapabilities: string[]
  allowedZoneTags: string[]
  homeSlotTags: string[]
  ambientBehaviors: string[]
  socialPolicy: {
    canInitiateConversation: boolean
    cooldownSeconds: number
    maxDailyConversations: number
  }
}

export type CharacterPhysicalState =
  | 'at-home'
  | 'navigating'
  | 'positioning'
  | 'thinking'
  | 'speaking'
  | 'listening'
  | 'working'
  | 'using-object'
  | 'meeting'
  | 'waiting'
  | 'blocked'

export interface CharacterPresence {
  worldId: string
  characterId: string
  sceneId: string
  zoneId: string
  homeSlotId: string
  currentSlotId: string
  reservedSlotId?: string
  facing: WorldFacing
  physicalState: CharacterPhysicalState
  status?: EmployeeStatus
  activePlanId?: string
  activeSessionId?: string
  updatedAt: IsoTimestamp
}

export type WorldSlotReservationStatus = 'reserved' | 'occupied'

export interface WorldSlotReservation {
  id: string
  worldId: string
  slotId: string
  characterId: string
  planId: string
  status: WorldSlotReservationStatus
  priority: number
  reservedAt: IsoTimestamp
  expiresAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type CharacterActionSource =
  | 'user'
  | 'task'
  | 'conversation'
  | 'role-routine'
  | 'ambient'
  | 'system'

export type CharacterActionPlanStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type CharacterActionStepKind =
  | 'reserve-slot'
  | 'navigate-to-slot'
  | 'face-entity'
  | 'face-object'
  | 'set-pose'
  | 'play-activity'
  | 'use-object'
  | 'speak'
  | 'listen'
  | 'wait'
  | 'release-slot'
  | 'return-home'

export type CharacterActionStepStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'failed'

export interface CharacterActionStep {
  id: string
  planId: string
  sequence: number
  kind: CharacterActionStepKind
  payload: JsonObject
  status: CharacterActionStepStatus
  startedAt?: IsoTimestamp
  dueAt?: IsoTimestamp
  completedAt?: IsoTimestamp
}

export interface CharacterActionPlan {
  id: string
  worldId: string
  characterId: string
  source: CharacterActionSource
  reason: string
  priority: number
  interruptible: boolean
  status: CharacterActionPlanStatus
  steps: CharacterActionStep[]
  causationId?: string
  correlationId?: string
  createdAt: IsoTimestamp
  startedAt?: IsoTimestamp
  completedAt?: IsoTimestamp
}

export type SharedWorldEpisodeKind =
  | 'conversation'
  | 'collaboration'
  | 'conflict'
  | 'handoff'
  | 'celebration'

export interface SharedWorldEpisode {
  id: string
  worldId: string
  participantIds: string[]
  sessionId?: string
  taskId?: string
  kind: SharedWorldEpisodeKind
  title: string
  summary: string
  outcome: string
  sourceEventIds: string[]
  sourceMessageIds: string[]
  importance: number
  occurredAt: IsoTimestamp
  createdAt: IsoTimestamp
}
