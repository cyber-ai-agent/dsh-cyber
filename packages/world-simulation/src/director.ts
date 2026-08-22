import type { DomainEvent, EmployeeInstance } from '@dsh-cyber/contracts'
import type {
  CharacterActionPlan,
  CharacterBehaviorProfile,
  CharacterPhysicalState,
  CompiledWorldSemantics,
  WorldSlotDefinition,
} from '@dsh-cyber/contracts/world-simulation'

import { CHARACTER_ACTION_PRIORITIES, createCharacterActionPlan } from './action-plan.js'
import { selectCharacterSlot } from './semantics.js'

export interface WorldCharacterDirective {
  characterId: string
  physicalState: CharacterPhysicalState
  activity: 'idle' | 'walking' | 'thinking' | 'working' | 'talking' | 'meeting' | 'blocked' | 'celebrating'
  label: string
  source: CharacterActionPlan['source']
  targetSlot?: WorldSlotDefinition
  plan?: CharacterActionPlan
  speechExcerpt?: string
  sessionId?: string
}

export interface DirectWorldEventInput {
  event: DomainEvent
  character: EmployeeInstance
  semantics: CompiledWorldSemantics
  occupiedSlotIds: ReadonlySet<string>
  homeSlot?: WorldSlotDefinition
  behaviorProfile?: CharacterBehaviorProfile
}

export function directWorldEvent(input: DirectWorldEventInput): WorldCharacterDirective | undefined {
  const { event, character, semantics, occupiedSlotIds, homeSlot, behaviorProfile } = input
  if (!eventTargetsCharacter(event, character.id)) return undefined

  if (event.type === 'task.started') {
    const targetSlot = selectCharacterSlot(
      character,
      semantics,
      occupiedSlotIds,
      'task',
      behaviorProfile,
    ) ?? homeSlot
    return directiveWithPlan({
      event,
      character,
      physicalState: 'navigating',
      activity: 'working',
      label: targetSlot === undefined ? '开始执行任务' : `前往${zoneLabel(targetSlot.zoneId)}执行任务`,
      source: 'task',
      priority: CHARACTER_ACTION_PRIORITIES.task,
      interruptible: false,
      ...(targetSlot === undefined ? {} : { targetSlot }),
      activityStep: 'working',
    })
  }

  if (event.type === 'turn.started') {
    return {
      characterId: character.id,
      physicalState: 'thinking',
      activity: 'thinking',
      label: '正在理解并思考',
      source: 'conversation',
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    }
  }

  if (event.type === 'tool.started') {
    const targetSlot = selectCharacterSlot(
      character,
      semantics,
      occupiedSlotIds,
      'task',
      behaviorProfile,
    ) ?? homeSlot
    const toolName = textValue(event, 'toolName')
    return directiveWithPlan({
      event,
      character,
      physicalState: targetSlot === undefined ? 'using-object' : 'navigating',
      activity: 'working',
      label: toolName === undefined ? '正在使用工具' : `正在使用 ${toolName}`,
      source: 'task',
      priority: CHARACTER_ACTION_PRIORITIES.task,
      interruptible: false,
      ...(targetSlot === undefined ? {} : { targetSlot }),
      activityStep: 'working',
    })
  }

  if (event.type === 'message.appended' && textValue(event, 'messageKind') === 'assistant') {
    const excerpt = textValue(event, 'excerpt')
    return {
      characterId: character.id,
      physicalState: 'speaking',
      activity: 'talking',
      label: '正在回应',
      source: 'conversation',
      ...(excerpt === undefined ? {} : { speechExcerpt: excerpt }),
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    }
  }

  if (event.type === 'task.completed' || event.type === 'turn.completed') {
    return directiveWithPlan({
      event,
      character,
      physicalState: homeSlot === undefined ? 'at-home' : 'navigating',
      activity: 'idle',
      label: homeSlot === undefined ? '任务完成，等待安排' : '任务完成，返回岗位',
      source: 'system',
      priority: CHARACTER_ACTION_PRIORITIES.roleRoutine,
      interruptible: true,
      ...(homeSlot === undefined ? {} : { targetSlot: homeSlot }),
      activityStep: 'idle',
    })
  }

  if (event.type === 'task.blocked' || event.type === 'turn.failed') {
    return {
      characterId: character.id,
      physicalState: 'blocked',
      activity: 'blocked',
      label: '遇到阻塞，等待处理',
      source: 'system',
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    }
  }

  return undefined
}

export function eventCharacterId(event: DomainEvent): string | undefined {
  return textValue(event, 'employeeId')
    ?? textValue(event, 'characterId')
    ?? textValue(event, 'senderId')
    ?? (event.actorKind === 'employee' ? event.actorId : undefined)
}

function eventTargetsCharacter(event: DomainEvent, characterId: string): boolean {
  return eventCharacterId(event) === characterId
}

function directiveWithPlan(input: {
  event: DomainEvent
  character: EmployeeInstance
  physicalState: CharacterPhysicalState
  activity: WorldCharacterDirective['activity']
  label: string
  source: CharacterActionPlan['source']
  priority: number
  interruptible: boolean
  targetSlot?: WorldSlotDefinition
  activityStep: string
}): WorldCharacterDirective {
  const plan = createCharacterActionPlan({
    id: `${input.event.id}:plan:${input.character.id}`,
    worldId: input.character.worldId,
    characterId: input.character.id,
    source: input.source,
    reason: input.label,
    priority: input.priority,
    interruptible: input.interruptible,
    now: input.event.createdAt,
    ...(input.targetSlot === undefined ? {} : { targetSlot: input.targetSlot }),
    activity: input.activityStep,
    causationId: input.event.id,
    ...(input.event.correlationId === undefined ? {} : { correlationId: input.event.correlationId }),
  })
  return {
    characterId: input.character.id,
    physicalState: input.physicalState,
    activity: input.activity,
    label: input.label,
    source: input.source,
    ...(input.targetSlot === undefined ? {} : { targetSlot: input.targetSlot }),
    plan,
    ...(input.event.sessionId === undefined ? {} : { sessionId: input.event.sessionId }),
  }
}

function textValue(event: DomainEvent, key: string): string | undefined {
  const value = event.payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function zoneLabel(zoneId: string): string {
  const labels: Record<string, string> = {
    'zone-administration': '行政协调区',
    'zone-engineering': '研发区',
    'zone-research': '研究与档案区',
    'zone-operations': '运行区',
    'zone-meeting': '会议区',
    'zone-rest': '休息区',
    'zone-public': '公共区',
  }
  return labels[zoneId] ?? '对应区域'
}
