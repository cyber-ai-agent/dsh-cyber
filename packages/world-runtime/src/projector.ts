import type {
  DomainEvent,
  EmployeeInstance,
  EmployeeMilestone,
  JsonObject,
  World,
  WorldActivityKind,
  WorldCue,
  WorldFacing,
  WorldPoint,
  WorldRuntimeEntityState,
  WorldRuntimeObjectState,
  WorldRuntimeSnapshot,
  WorldThemeAnchorManifest,
  WorldThemeManifestV1,
} from '@dsh-cyber/contracts'

import { findPath } from './navigation.js'
import { getAnchor, getScene } from './manifest.js'

export interface ProjectWorldRuntimeInput {
  workspaceId: string
  world: World
  employees: EmployeeInstance[]
  events: DomainEvent[]
  milestones?: EmployeeMilestone[]
  manifest: WorldThemeManifestV1
  previous?: WorldRuntimeSnapshot
  now?: string
}

export interface ProjectWorldRuntimeResult {
  snapshot: WorldRuntimeSnapshot
  cues: WorldCue[]
}

export function projectWorldRuntime(input: ProjectWorldRuntimeInput): ProjectWorldRuntimeResult {
  const scene = getScene(input.manifest, input.previous?.sceneId)
  const now = input.now ?? new Date().toISOString()
  const entities = new Map<string, WorldRuntimeEntityState>()
  for (const entity of input.previous?.entities ?? []) entities.set(entity.id, cloneEntity(entity))

  const arrivalAnchors = scene.anchors.filter((anchor) => anchor.tags.includes('idle'))
  const fallbackAnchors = scene.anchors.filter((anchor) => anchor.tags.includes('work'))
  for (const [index, employee] of input.employees.entries()) {
    if (employee.status === 'archived') continue
    const existing = entities.get(employee.id)
    if (existing !== undefined) {
      existing.displayName = employee.displayName
      existing.role = employee.role
      existing.status = employee.status
      existing.updatedAt = employee.updatedAt
      continue
    }
    const anchor = arrivalAnchors[index % arrivalAnchors.length]
      ?? fallbackAnchors[index % fallbackAnchors.length]
      ?? getAnchor(scene, 'spawn')
    entities.set(employee.id, createEmployeeEntity(employee, scene.id, anchor, index))
  }

  const activeEmployeeIds = new Set(input.employees.filter((employee) => employee.status !== 'archived').map((employee) => employee.id))
  for (const [entityId, entity] of entities) {
    if (entity.kind === 'agent' && !activeEmployeeIds.has(entityId)) entities.delete(entityId)
  }

  const cues: WorldCue[] = []
  const appliedAfter = input.previous?.sequence ?? 0
  const orderedEvents = [...input.events]
    .filter((event) => event.sequence > appliedAfter)
    .sort((left, right) => left.sequence - right.sequence)
  for (const event of orderedEvents) applyEvent(event, entities, input.manifest, scene.id, cues, now)

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
  manifest: WorldThemeManifestV1,
  sceneId: string,
  cues: WorldCue[],
  now: string,
): void {
  const scene = getScene(manifest, sceneId)
  const employeeId = textValue(event.payload, 'employeeId')
    ?? textValue(event.payload, 'senderId')
    ?? (event.actorKind === 'employee' ? event.actorId : undefined)
  const activity = manifest.activityMapping[event.type]

  if (event.type === 'task.started' && employeeId !== undefined) {
    const entity = entities.get(employeeId)
    if (entity !== undefined && typeof entity.visualState['activeMeetingId'] !== 'string') {
      moveEntity(
        entity,
        chooseWorkAnchor(scene.anchors, entity.id),
        'working',
        '前往工位执行任务',
        scene.navigation,
        event,
        cues,
      )
    }
  }

  if (event.type === 'meeting.started') {
    const participants = stringArrayValue(event.payload, 'participantIds')
    const anchors = scene.anchors.filter((anchor) => anchor.tags.includes('meeting'))
    for (const [index, participantId] of participants.entries()) {
      const entity = entities.get(participantId)
      const anchor = anchors[index % anchors.length]
      if (entity !== undefined && anchor !== undefined) {
        settleAtTarget(entity)
        entity.visualState = {
          ...entity.visualState,
          activeMeetingId: event.correlationId ?? event.id,
        }
        moveEntity(entity, anchor, 'meeting', '前往协作会议', scene.navigation, event, cues)
      }
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
      const anchor = chooseWorkAnchor(scene.anchors, entity.id)
      moveEntity(entity, anchor, 'idle', '会议结束，返回工位', scene.navigation, event, cues)
    }
    cues.push(cue(event, 'meeting.disperse', {}))
    return
  }

  if (employeeId === undefined) return
  const entity = entities.get(employeeId)
  if (entity === undefined) return
  if (event.type === 'task.completed' || event.type === 'task.blocked') settleAtTarget(entity)
  if (activity !== undefined) {
    entity.activity = activity
    entity.activityLabel = activityLabel(event.type)
    entity.updatedAt = event.createdAt
    cues.push(cue(event, 'entity.activity', {
      entityId: entity.id,
      activity,
      label: entity.activityLabel,
    }, entity.id))
  }
  if (event.type === 'message.appended' && textValue(event.payload, 'messageKind') === 'assistant') {
    cues.push(cue(event, 'entity.speech', {
      entityId: entity.id,
      messageId: textValue(event.payload, 'messageId') ?? '',
    }, entity.id))
  }
  if (event.type === 'employee.milestone.recorded') {
    cues.push(cue(event, 'growth.unlocked', {
      entityId: entity.id,
      milestoneId: textValue(event.payload, 'milestoneId') ?? '',
      category: textValue(event.payload, 'category') ?? 'task',
    }, entity.id))
  }
  entity.visualState = { ...entity.visualState, lastEventType: event.type, projectedAt: now }
}

function settleAtTarget(entity: WorldRuntimeEntityState): void {
  if (entity.targetPosition === undefined) return
  entity.position = { ...entity.targetPosition }
  if (entity.targetAnchorId === undefined) delete entity.anchorId
  else entity.anchorId = entity.targetAnchorId
  delete entity.targetPosition
  delete entity.targetAnchorId
  entity.route = []
}

function moveEntity(
  entity: WorldRuntimeEntityState,
  anchor: WorldThemeAnchorManifest,
  activity: WorldActivityKind,
  label: string,
  navigation: Parameters<typeof findPath>[0],
  event: DomainEvent,
  cues: WorldCue[],
): void {
  const route = findPath(navigation, entity.position, anchor.position)
  delete entity.anchorId
  entity.targetAnchorId = anchor.id
  entity.targetPosition = { ...anchor.position }
  entity.route = route
  entity.facing = facingToward(entity.position, anchor.position, anchor.facing)
  entity.activity = activity
  entity.activityLabel = label
  entity.updatedAt = event.createdAt
  cues.push(cue(event, 'entity.route', {
    entityId: entity.id,
    targetAnchorId: anchor.id,
    route: route.map((point) => ({ x: point.x, y: point.y })),
  }, entity.id))
}

function createEmployeeEntity(
  employee: EmployeeInstance,
  sceneId: string,
  anchor: WorldThemeAnchorManifest,
  placementIndex: number,
): WorldRuntimeEntityState {
  return {
    id: employee.id,
    kind: 'agent',
    sceneId,
    sourceId: employee.id,
    displayName: employee.displayName,
    role: employee.role,
    anchorId: anchor.id,
    position: placementAtAnchor(anchor, placementIndex),
    footOffset: { x: 0, y: 112 },
    facing: anchor.facing,
    activity: employee.status === 'blocked' ? 'blocked' : employee.status === 'working' ? 'working' : 'idle',
    activityLabel: statusLabel(employee.status),
    status: employee.status,
    route: [],
    visualState: { rosterIndex: 0 },
    updatedAt: employee.updatedAt,
  }
}

function placementAtAnchor(anchor: WorldThemeAnchorManifest, index: number): WorldPoint {
  const capacity = Math.max(1, anchor.capacity)
  const slot = index % capacity
  const columns = Math.min(capacity, 3)
  const column = slot % columns
  const row = Math.floor(slot / columns)
  return {
    x: anchor.position.x + (column - (columns - 1) / 2) * 112,
    y: anchor.position.y + row * 112,
  }
}

function cue(
  event: DomainEvent,
  kind: WorldCue['kind'],
  payload: JsonObject,
  entityId?: string,
): WorldCue {
  return {
    id: `${event.id}:${kind}`,
    worldId: event.worldId ?? '',
    sequence: event.sequence,
    kind,
    ...(entityId === undefined ? {} : { entityId }),
    payload,
    createdAt: event.createdAt,
  }
}

function chooseWorkAnchor(anchors: WorldThemeAnchorManifest[], entityId: string): WorldThemeAnchorManifest {
  const work = anchors.filter((anchor) => anchor.tags.includes('work'))
  const hash = [...entityId].reduce((total, character) => total + character.charCodeAt(0), 0)
  return work[hash % work.length] ?? anchors[0] ?? {
    id: 'origin',
    position: { x: 0, y: 0 },
    facing: 'south',
    capacity: 1,
    tags: [],
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
  return typeof value === 'string' ? value : undefined
}

function stringArrayValue(payload: JsonObject, key: string): string[] {
  const value = payload[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function facingToward(from: WorldPoint, to: WorldPoint, fallback: WorldFacing): WorldFacing {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return fallback
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west'
  return dy > 0 ? 'south' : 'north'
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
