export type AmbientBehaviorKind =
  | 'stay-at-post'
  | 'inspect-work-area'
  | 'take-short-break'
  | 'return-home'

export interface AmbientCharacterState {
  worldId: string
  characterId: string
  displayName: string
  role: string
  status: 'available' | 'working' | 'waiting' | 'blocked' | 'archived'
  sceneId: string
  facing: 'north' | 'east' | 'south' | 'west'
  roleTags: string[]
  preferredZoneTags: string[]
  currentZoneId: string
  currentSlotId: string
  homeSlotId: string
  activePlanId?: string
  activeSessionId?: string
  idleSince: string
  lastAmbientAt?: string
}

export interface AmbientSlot {
  id: string
  zoneId: string
  kind: 'home' | 'work' | 'approach' | 'seat' | 'operate' | 'conversation' | 'waiting' | 'rest'
  tags: string[]
  occupiedBy?: string
  reservedBy?: string
}

export interface AmbientPolicyInput {
  now: string
  character: AmbientCharacterState
  slots: AmbientSlot[]
  enabled: boolean
  minimumIdleMs?: number
  minimumAmbientIntervalMs?: number
  breakAfterMs?: number
  timeBucketMs?: number
}

export interface AmbientDecision {
  characterId: string
  kind: AmbientBehaviorKind
  source: 'role-routine' | 'ambient'
  reason: string
  priority: number
  interruptible: true
  targetSlotId: string
  decisionKey: string
}

const DEFAULT_MINIMUM_IDLE_MS = 45_000
const DEFAULT_AMBIENT_INTERVAL_MS = 180_000
const DEFAULT_BREAK_AFTER_MS = 1_800_000
const DEFAULT_TIME_BUCKET_MS = 300_000

/**
 * Selects at most one bounded ambient action for an idle character.
 *
 * This policy is intentionally deterministic. It never uses Math.random(), never lets
 * the model control coordinates, and never moves a character outside role-compatible
 * zones. Ambient life only represents visual routines; all character conversations
 * continue through the real peer-collaboration runtime and are never simulated here.
 */
export function decideAmbientBehavior(input: AmbientPolicyInput): AmbientDecision | undefined {
  if (!input.enabled) return undefined
  const character = input.character
  if (character.status !== 'available') return undefined
  if (character.activePlanId !== undefined || character.activeSessionId !== undefined) return undefined

  const nowMs = parseTime(input.now)
  const idleSinceMs = parseTime(character.idleSince)
  const minimumIdleMs = input.minimumIdleMs ?? DEFAULT_MINIMUM_IDLE_MS
  if (nowMs - idleSinceMs < minimumIdleMs) return undefined

  const minimumIntervalMs = input.minimumAmbientIntervalMs ?? DEFAULT_AMBIENT_INTERVAL_MS
  if (character.lastAmbientAt !== undefined && nowMs - parseTime(character.lastAmbientAt) < minimumIntervalMs) {
    return undefined
  }

  const availableSlots = input.slots.filter((slot) => isAvailableFor(slot, character.characterId))
  const home = input.slots.find((slot) => slot.id === character.homeSlotId)
  if (character.currentSlotId !== character.homeSlotId && home !== undefined && isAvailableFor(home, character.characterId)) {
    return decision(input, {
      kind: 'return-home',
      source: 'role-routine',
      reason: '空闲后返回自己的固定岗位',
      priority: 24,
      targetSlotId: home.id,
    })
  }

  const timeBucketMs = input.timeBucketMs ?? DEFAULT_TIME_BUCKET_MS
  const bucket = Math.floor(nowMs / timeBucketMs)
  const selector = stableNumber(`${character.worldId}:${character.characterId}:${bucket}`)

  const breakAfterMs = input.breakAfterMs ?? DEFAULT_BREAK_AFTER_MS
  if (nowMs - idleSinceMs >= breakAfterMs && selector % 5 === 0) {
    const rest = rankSlots(availableSlots, ['rest', 'lounge', 'public'], ['rest', 'seat'])[0]
    if (rest !== undefined) {
      return decision(input, {
        kind: 'take-short-break',
        source: 'ambient',
        reason: '长时间处于岗位后进行一次可中断的短暂休息',
        priority: 10,
        targetSlotId: rest.id,
      })
    }
  }

  const roleRoutine = selectRoleRoutine(input, availableSlots, selector)
  if (roleRoutine !== undefined) return roleRoutine

  if (home !== undefined) {
    return decision(input, {
      kind: 'stay-at-post',
      source: 'role-routine',
      reason: '在自己的岗位保持待命，不进行无目的游走',
      priority: 8,
      targetSlotId: home.id,
    })
  }
  return undefined
}

function selectRoleRoutine(
  input: AmbientPolicyInput,
  slots: AmbientSlot[],
  selector: number,
): AmbientDecision | undefined {
  const tags = normalizedTags([
    ...input.character.roleTags,
    ...input.character.preferredZoneTags,
    input.character.role,
  ])

  const rolePreferences = tags.has('engineering') || tags.has('开发') || tags.has('工程师')
    ? ['engineering', 'coding', 'testing', 'work']
    : tags.has('administration') || tags.has('秘书') || tags.has('管家') || tags.has('协调')
      ? ['administration', 'coordination', 'schedule', 'archive']
      : tags.has('research') || tags.has('研究') || tags.has('档案')
        ? ['research', 'knowledge', 'archive', 'reading']
        : tags.has('operations') || tags.has('运维') || tags.has('运营')
          ? ['operations', 'monitoring', 'control', 'work']
          : input.character.preferredZoneTags

  const ranked = rankSlots(slots, rolePreferences, ['work', 'operate', 'approach'])
    .filter((slot) => slot.id !== input.character.currentSlotId)
  if (ranked.length === 0) return undefined
  const target = ranked[selector % Math.min(ranked.length, 3)]
  if (target === undefined) return undefined

  return decision(input, {
    kind: 'inspect-work-area',
    source: 'role-routine',
    reason: '在职责相关区域执行一次短暂、可中断的岗位巡检',
    priority: 16,
    targetSlotId: target.id,
  })
}

function decision(
  input: AmbientPolicyInput,
  value: Omit<AmbientDecision, 'characterId' | 'interruptible' | 'decisionKey'>,
): AmbientDecision {
  const key = [
    input.character.worldId,
    input.character.characterId,
    value.kind,
    value.targetSlotId,
    input.now,
  ].join(':')
  return {
    characterId: input.character.characterId,
    interruptible: true,
    decisionKey: stableNumber(key).toString(36),
    ...value,
  }
}

function rankSlots(slots: AmbientSlot[], semanticTags: string[], kinds: AmbientSlot['kind'][]): AmbientSlot[] {
  const normalized = semanticTags.map(normalize)
  return [...slots]
    .filter((slot) => kinds.includes(slot.kind))
    .map((slot) => ({
      slot,
      score: normalized.reduce((total, tag) => total + (slot.tags.some((item) => normalize(item).includes(tag)) ? 10 : 0), 0),
    }))
    .filter((item) => item.score > 0 || normalized.length === 0)
    .sort((left, right) => right.score - left.score || left.slot.id.localeCompare(right.slot.id))
    .map((item) => item.slot)
}

function isAvailableFor(slot: AmbientSlot, characterId: string): boolean {
  return (slot.occupiedBy === undefined || slot.occupiedBy === characterId)
    && (slot.reservedBy === undefined || slot.reservedBy === characterId)
}

function normalizedTags(values: string[]): Set<string> {
  const result = new Set<string>()
  for (const value of values) {
    const normalized = normalize(value)
    if (normalized) result.add(normalized)
  }
  return result
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function stableNumber(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

function parseTime(value: string): number {
  const result = Date.parse(value)
  if (!Number.isFinite(result)) throw new Error(`Invalid ambient policy timestamp: ${value}`)
  return result
}
