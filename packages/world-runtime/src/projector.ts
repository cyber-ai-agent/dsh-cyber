import type {
  DomainEvent,
  EmployeeInstance,
  EmployeeMilestone,
  JsonObject,
  JsonValue,
  JsonValue,
  JsonValue,
  World,
  WorldActivityKind,
  WorldCue,
  WorldFacing,
  WorldPoint,
  WorldRuntimeEntityState,
  WorldRuntimeObjectState,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
} from '@dsh-cyber/contracts'
import type {
  CharacterPresence,
  CompiledWorldSemantics,
  WorldSlotDefinition,
} from '@dsh-cyber/contracts/world-simulation'
import {
  assignCharacterHomeSlots,
  compileWorldSemantics,
  directWorldEvent,
  rankSlots,
  resolveCharacterBehavior,
} from '@dsh-cyber/world-simulation'

import { findPath } from './navigation.js'
import { getScene } from './manifest.js'

export interface ProjectWorldRuntimeInput {
  workspaceId: string
  world: World
  employees: EmployeeInstance[]
  events: DomainEvent[]
  milestones?: EmployeeMilestone[]
  manifest: WorldThemeManifestV1
  presences?: CharacterPresence[]
  semantics?: CompiledWorldSemantics
  previous?: WorldRuntimeSnapshot
  now?: string
}

export interface ProjectWorldRuntimeResult {
  snapshot: WorldRuntimeSnapshot
  cues: WorldCue[]
}

export function projectWorldRuntime(input: ProjectWorldRuntimeInput): ProjectWorldRuntimeResult {
  const scene = getScene(input.manifest, input.previous?.sceneId)
  const semantics = input.semantics ?? compileWorldSemantics(input.manifest, scene.id)
  const now = input.now ?? new Date().toISOString()
  const entities = new Map<string, WorldRuntimeEntityState>()
  for (const entity of input.previous?.entities ?? []) entities.set(entity.id, cloneEntity(entity))

  const presenceByCharacter = new Map((input.presences ?? []).map((presence) => [presence.characterId, presence]))
  const retainedHomes = new Map<string, string>()
  for (const employee of input.employees) {
    const persisted = presenceByCharacter.get(employee.id)?.homeSlotId
    const projected = entities.get(employee.id)?.visualState['homeSlotId']
    if (persisted !== undefined) retainedHomes.set(employee.id, persisted)
    else if (typeof projected === 'string') retainedHomes.set(employee.id, projected)
  }
  const homeSlots = assignCharacterHomeSlots(input.employees, semantics, retainedHomes)

  for (const employee of input.employees) {
    if (employee.status === 'archived') continue
    const homeSlot = homeSlots.get(employee.id)
    const presence = presenceByCharacter.get(employee.id)
    const existing = entities.get(employee.id)
    if (existing !== undefined) {
      existing.displayName = employee.displayName
      existing.role = employee.role
      existing.status = employee.status
      existing.updatedAt = employee.updatedAt
      if (homeSlot !== undefined) {
        existing.visualState = {
          ...existing.visualState,
          homeSlotId: homeSlot.id,
          zoneId: stringVisual(existing.visualState, 'zoneId') ?? homeSlot.zoneId,
          currentSlotId: stringVisual(existing.visualState, 'currentSlotId') ?? homeSlot.id,
          physicalState: stringVisual(existing.visualState, 'physicalState') ?? 'at-home',
        }
      }
      continue
    }
    const currentSlot = presence === undefined
      ? homeSlot
      : semantics.slots.find((slot) => slot.id === presence.currentSlotId) ?? homeSlot
    if (currentSlot === undefined) continue
    entities.set(employee.id, createEmployeeEntity(employee, scene.id, currentSlot, homeSlot ?? currentSlot, presence))
  }

  const activeEmployeeIds = new Set(input.employees
    .filter((employee) => employee.status !== 'archived')
    .map((employee) => employee.id))
  for (const [entityId, entity] of entities) {
    if (entity.kind === 'agent' && !activeEmployeeIds.has(entityId)) entities.delete(entityId)
  }

  const employeeById = new Map(input.employees.map((employee) => [employee.id, employee]))
  const cues: WorldCue[] = []
  const appliedAfter = input.previous?.sequence ?? 0
  const orderedEvents = [...input.events]
    .filter((event) => event.sequence > appliedAfter)
    .sort((left, right) => left.sequence - right.sequence)
  for (const event of orderedEvents) {
    applyEvent(event, entities, employeeById, input.manifest, semantics, cues, now)
  }

  const growthSlots: Record<string, string[]> = { ...(input.previous?.growthSlots ?? {}) }
  for (const milestone of input.milestones ?? []) {
    const bucket = growthSlots[milestone.category] ?? []
    if (!bucket.includes(milestone.id)) growthSlots[milestone.category] = [...bucket, milestone.id]
  }

  const objects: WorldRuntimeObjectState[] = scene.interactables.map((interactable) => {
    const previous = input.previous?.objects.find((object) => object.id === interactable.id)
    return previous ?? {
      id: interactable.id,
      sceneId: scene.id,
      kind: interactable.kind,
      displayName: interactable.displayName,
      anchorId: interactable.approachAnchorIds[0] ?? 'spawn',
      state: 'idle',
      activityLabel: '可交互',
      visualState: {},
      updatedAt: now,
    }
  })

  for (const event of orderedEvents) {
    if (event.type !== 'world.object.activated') continue
    const objectId = textValue(event.payload, 'objectId')
    const object = objects.find((candidate) => candidate.id === objectId)
    if (object !== undefined) {
      object.state = 'active'
      object.activityLabel = textValue(event.payload, 'label') ?? '正在使用'
      object.updatedAt = event.createdAt
    }
  }

  const lastSequence = Math.max(
    input.previous?.sequence ?? 0,
    ...input.events.map((event) => event.sequence),
    0,
  )
  return {
    snapshot: {
      contractVersion: 1,
      workspaceId: input.workspaceId,
      worldId: input.world.id,
      templateId: input.world.templateId,
      themeId: input.manifest.id,
      sceneId: scene.id,
      sequence: lastSequence,
      generatedAt: now,
      clock: {
        now,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        lightsOn: readLights(input.previous, orderedEvents),
      },
      entities: [...entities.values()].sort((left, right) => left.id.localeCompare(right.id)),
      objects,
      growthSlots,
    },
    cues,
  }
}

function applyEvent(
  event: DomainEvent,
  entities: Map<string, WorldRuntimeEntityState>,
  employeeById: ReadonlyMap<string, EmployeeInstance>,
  manifest: WorldThemeManifestV1,
  semantics: CompiledWorldSemantics,
  cues: WorldCue[],
  now: string,
): void {
  const employeeId = eventEmployeeId(event)

  if (event.type === 'meeting.started') {
    const participants = stringArrayValue(event.payload, 'participantIds')
    const occupied = occupiedSlotIds(entities, new Set(participants))
    const meetingSlots = rankSlots(
      semantics.slots,
      genericMeetingProfile(),
      occupied,
      'meeting',
    )
    for (const [index, participantId] of participants.entries()) {
      const entity = entities.get(participantId)
      const slot = meetingSlots[index]
      if (entity === undefined || slot === undefined) continue
      settleAtTarget(entity)
      entity.visualState = {
        ...entity.visualState,
        activeMeetingId: event.correlationId ?? event.id,
      }
      moveEntityToSlot(entity, slot, 'meeting', '前往协作会议', semantics, event, cues, {
        physicalState: 'meeting',
        source: 'conversation',
        planId: `${event.id}:meeting:${participantId}`,
        sessionId: event.sessionId,
      })
      occupied.add(slot.id)
    }
    cues.push(cue(event, 'meeting.gather', { participantIds: participants }))
    return
  }

  if (event.type === 'meeting.finished') {
    const participants = new Set(stringArrayValue(event.payload, 'participantIds'))
    const meetingId = event.correlationId
    for (const entity of entities.values()) {
      const activeMeetingId = entity.visualState['activeMeetingId']
      if (!participants.has(entity.id) && (typeof activeMeetingId !== 'string' || activeMeetingId !== meetingId)) continue
      settleAtTarget(entity)
      delete entity.visualState['activeMeetingId']
      const home = slotFromVisualState(semantics, entity, 'homeSlotId')
      if (home === undefined) continue
      moveEntityToSlot(entity, home, 'idle', '会议结束，返回岗位', semantics, event, cues, {
        physicalState: 'navigating',
        source: 'system',
        planId: `${event.id}:return-home:${entity.id}`,
        sessionId: event.sessionId,
      })
    }
    cues.push(cue(event, 'meeting.disperse', {}))
    return
  }

  if (employeeId !== undefined) {
    const entity = entities.get(employeeId)
    const employee = employeeById.get(employeeId)
    if (entity !== undefined && employee !== undefined && typeof entity.visualState['activeMeetingId'] !== 'string') {
      if (event.type === 'task.completed' || event.type === 'task.blocked' || event.type === 'turn.completed') {
        settleAtTarget(entity)
      }
      const home = slotFromVisualState(semantics, entity, 'homeSlotId')
      const directive = directWorldEvent({
        event,
        character: employee,
        semantics,
        occupiedSlotIds: occupiedSlotIds(entities, new Set([employee.id])),
        ...(home === undefined ? {} : { homeSlot: home }),
      })
      if (directive !== undefined) {
        if (directive.targetSlot === undefined) {
          entity.activity = directive.activity
          entity.activityLabel = directive.label
          entity.updatedAt = event.createdAt
          entity.visualState = compactVisualState({
            ...entity.visualState,
            physicalState: directive.physicalState,
            actionSource: directive.source,
            activeSessionId: directive.sessionId,
            activePlanId: directive.plan?.id,
            lastEventType: event.type,
            projectedAt: now,
          })
          cues.push(cue(event, 'entity.activity', {
            entityId: entity.id,
            activity: directive.activity,
            label: directive.label,
          }, entity.id))
        } else {
          moveEntityToSlot(entity, directive.targetSlot, directive.activity, directive.label, semantics, event, cues, {
            physicalState: directive.physicalState,
            source: directive.source,
            planId: directive.plan?.id,
            sessionId: directive.sessionId,
          })
        }
        if (directive.speechExcerpt !== undefined) {
          cues.push(cue(event, 'entity.speech', {
            entityId: entity.id,
            excerpt: directive.speechExcerpt,
            sessionId: directive.sessionId ?? '',
          }, entity.id))
        }
      }
    }
  }

  if (employeeId !== undefined) {
    const entity = entities.get(employeeId)
    if (entity !== undefined && event.type === 'message.appended' && textValue(event.payload, 'messageKind') === 'assistant') {
      cues.push(cue(event, 'entity.speech', {
        entityId: entity.id,
        messageId: textValue(event.payload, 'messageId') ?? '',
        excerpt: textValue(event.payload, 'excerpt') ?? '',
        sessionId: event.sessionId ?? '',
      }, entity.id))
    }
    if (entity !== undefined && event.type === 'employee.milestone.recorded') {
      cues.push(cue(event, 'growth.unlocked', {
        entityId: entity.id,
        milestoneId: textValue(event.payload, 'milestoneId') ?? '',
        category: textValue(event.payload, 'category') ?? 'task',
      }, entity.id))
    }
  }

  const mappedActivity = manifest.activityMapping[event.type]
  if (employeeId !== undefined && mappedActivity !== undefined) {
    const entity = entities.get(employeeId)
    if (entity !== undefined && !cues.some((item) => item.sequence === event.sequence && item.entityId === employeeId && item.kind === 'entity.activity')) {
      entity.activity = mappedActivity
      entity.activityLabel = activityLabel(event.type)
      entity.updatedAt = event.createdAt
      cues.push(cue(event, 'entity.activity', {
        entityId: entity.id,
        activity: mappedActivity,
        label: entity.activityLabel,
      }, entity.id))
    }
  }
}

function moveEntityToSlot(
  entity: WorldRuntimeEntityState,
  slot: WorldSlotDefinition,
  activity: WorldActivityKind,
  label: string,
  semantics: CompiledWorldSemantics,
  event: DomainEvent,
  cues: WorldCue[],
  context: {
    physicalState: string
    source: string
    planId?: string | undefined
    sessionId?: string | undefined
  },
): void {
  const sceneNavigation = semantics.navigation ?? semanticsNavigation(semantics)
  const route = findPath(sceneNavigation, entity.position, slot.position)
  entity.facing = facingToward(entity.position, slot.position, slot.facing)
  entity.activity = activity
  entity.activityLabel = label
  entity.updatedAt = event.createdAt
  entity.visualState = compactVisualState({
    ...entity.visualState,
    zoneId: slot.zoneId,
    reservedSlotId: slot.id,
    physicalState: context.physicalState,
    actionSource: context.source,
    activePlanId: context.planId,
    activeSessionId: context.sessionId,
  })

  if (route.length < 2 || samePoint(entity.position, slot.position)) {
    entity.position = { ...slot.position }
    entity.anchorId = slot.anchorId
    entity.route = []
    delete entity.targetAnchorId
    delete entity.targetPosition
    entity.visualState = compactVisualState({
      ...entity.visualState,
      currentSlotId: slot.id,
      physicalState: activity === 'idle' ? 'at-home' : context.physicalState,
    })
    delete entity.visualState['reservedSlotId']
  } else {
    delete entity.anchorId
    entity.targetAnchorId = slot.anchorId
    entity.targetPosition = { ...slot.position }
    entity.route = route
    cues.push(cue(event, 'entity.route', {
      entityId: entity.id,
      targetAnchorId: slot.anchorId,
      targetSlotId: slot.id,
      route: route.map((point) => ({ x: point.x, y: point.y })),
    }, entity.id))
  }

  cues.push(cue(event, 'entity.activity', {
    entityId: entity.id,
    activity,
    label,
  }, entity.id))
}

function createEmployeeEntity(
  employee: EmployeeInstance,
  sceneId: string,
  currentSlot: WorldSlotDefinition,
  homeSlot: WorldSlotDefinition,
  presence?: CharacterPresence,
): WorldRuntimeEntityState {
  return {
    id: employee.id,
    kind: 'agent',
    sceneId,
    sourceId: employee.id,
    displayName: employee.displayName,
    role: employee.role,
    anchorId: currentSlot.anchorId,
    position: { ...currentSlot.position },
    footOffset: { x: 0, y: 112 },
    facing: presence?.facing ?? currentSlot.facing,
    activity: employee.status === 'blocked' ? 'blocked' : employee.status === 'working' ? 'working' : 'idle',
    activityLabel: statusLabel(employee.status),
    status: employee.status,
    route: [],
    visualState: compactVisualState({
      rosterIndex: 0,
      zoneId: presence?.zoneId ?? currentSlot.zoneId,
      homeSlotId: homeSlot.id,
      currentSlotId: currentSlot.id,
      physicalState: presence?.physicalState ?? 'at-home',
      activePlanId: presence?.activePlanId,
      activeSessionId: presence?.activeSessionId,
    }),
    updatedAt: employee.updatedAt,
  }
}

function settleAtTarget(entity: WorldRuntimeEntityState): void {
  if (entity.targetPosition !== undefined) entity.position = { ...entity.targetPosition }
  if (entity.targetAnchorId === undefined) delete entity.anchorId
  else entity.anchorId = entity.targetAnchorId
  const reservedSlotId = stringVisual(entity.visualState, 'reservedSlotId')
  if (reservedSlotId !== undefined) {
    entity.visualState = {
      ...entity.visualState,
      currentSlotId: reservedSlotId,
    }
    delete entity.visualState['reservedSlotId']
  }
  delete entity.targetPosition
  delete entity.targetAnchorId
  entity.route = []
}

function occupiedSlotIds(
  entities: ReadonlyMap<string, WorldRuntimeEntityState>,
  excludedCharacterIds: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>()
  for (const entity of entities.values()) {
    if (excludedCharacterIds.has(entity.id)) continue
    const current = stringVisual(entity.visualState, 'currentSlotId')
    const reserved = stringVisual(entity.visualState, 'reservedSlotId')
    if (current !== undefined) result.add(current)
    if (reserved !== undefined) result.add(reserved)
  }
  return result
}

function slotFromVisualState(
  semantics: CompiledWorldSemantics,
  entity: WorldRuntimeEntityState,
  key: 'homeSlotId' | 'currentSlotId',
): WorldSlotDefinition | undefined {
  const slotId = stringVisual(entity.visualState, key)
  return slotId === undefined ? undefined : semantics.slots.find((slot) => slot.id === slotId)
}

function semanticsNavigation(semantics: CompiledWorldSemantics): Parameters<typeof findPath>[0] {
  const points = semantics.slots.map((slot) => slot.position)
  const maxX = Math.max(1, ...points.map((point) => point.x))
  const maxY = Math.max(1, ...points.map((point) => point.y))
  const cellSize = 48
  return {
    origin: { x: 0, y: 0 },
    cellSize,
    columns: Math.max(1, Math.ceil(maxX / cellSize) + 2),
    rows: Math.max(1, Math.ceil(maxY / cellSize) + 2),
    blocked: [],
  }
}

function genericMeetingProfile() {
  return {
    id: 'meeting',
    roleTags: ['meeting'],
    preferredZoneTags: ['meeting'],
    preferredFacilityCapabilities: ['meeting', 'conversation'],
    allowedZoneTags: ['meeting'],
    homeSlotTags: ['meeting'],
    ambientBehaviors: [],
    socialPolicy: { canInitiateConversation: false, cooldownSeconds: 0, maxDailyConversations: 0 },
  }
}

function eventEmployeeId(event: DomainEvent): string | undefined {
  return textValue(event.payload, 'employeeId')
    ?? textValue(event.payload, 'characterId')
    ?? textValue(event.payload, 'senderId')
    ?? (event.actorKind === 'employee' ? event.actorId : undefined)
}

function cue(
  event: DomainEvent,
  kind: WorldCue['kind'],
  payload: JsonObject,
  entityId?: string,
): WorldCue {
  return {
    id: `${event.id}:${kind}:${entityId ?? 'world'}`,
    worldId: event.worldId ?? '',
    sequence: event.sequence,
    kind,
    ...(entityId === undefined ? {} : { entityId }),
    payload,
    createdAt: event.createdAt,
  }
}

function readLights(previous: WorldRuntimeSnapshot | undefined, events: DomainEvent[]): boolean {
  let lightsOn = previous?.clock.lightsOn ?? true
  for (const event of events) {
    if (event.type === 'world.lights.changed') {
      const next = event.payload['lightsOn']
      if (typeof next === 'boolean') lightsOn = next
    }
  }
  return lightsOn
}

function cloneEntity(entity: WorldRuntimeEntityState): WorldRuntimeEntityState {
  return {
    ...entity,
    position: { ...entity.position },
    ...(entity.targetPosition === undefined ? {} : { targetPosition: { ...entity.targetPosition } }),
    footOffset: { ...entity.footOffset },
    route: entity.route.map((point) => ({ ...point })),
    visualState: { ...entity.visualState },
  }
}

function textValue(payload: JsonObject, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArrayValue(payload: JsonObject, key: string): string[] {
  const value = payload[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringVisual(value: JsonObject, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

function facingToward(from: WorldPoint, to: WorldPoint, fallback: WorldFacing): WorldFacing {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return fallback
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west'
  return dy > 0 ? 'south' : 'north'
}

function samePoint(left: WorldPoint, right: WorldPoint): boolean {
  return Math.abs(left.x - right.x) < 1 && Math.abs(left.y - right.y) < 1
}

function compactVisualState(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {}
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined && isJsonValue(field)) result[key] = field
  }
  return result
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

function activityLabel(type: string): string {
  const labels: Record<string, string> = {
    'task.started': '开始执行任务',
    'turn.started': '正在思考',
    'tool.started': '正在调用工具',
    'message.appended': '正在同步进展',
    'task.blocked': '遇到阻塞，等待处理',
    'task.completed': '任务完成，等待安排',
  }
  return labels[type] ?? '状态已更新'
}

function statusLabel(status: EmployeeInstance['status']): string {
  if (status === 'working') return '正在执行'
  if (status === 'blocked') return '等待处理'
  if (status === 'waiting') return '等待依赖'
  return '可接任务'
}
