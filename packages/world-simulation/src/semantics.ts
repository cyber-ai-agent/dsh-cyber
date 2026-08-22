import type {
  EmployeeInstance,
  WorldPoint,
  WorldRect,
  WorldThemeAnchorManifest,
  WorldThemeInteractableManifest,
  WorldThemeManifestV1,
  WorldThemeSceneManifest,
} from '@dsh-cyber/contracts'
import type {
  CharacterBehaviorProfile,
  CompiledWorldSemantics,
  WorldFacilityDefinition,
  WorldSlotDefinition,
  WorldSlotKind,
  WorldZoneDefinition,
  WorldZoneKind,
} from '@dsh-cyber/contracts/world-simulation'

const ZONE_TAGS: readonly WorldZoneKind[] = [
  'administration',
  'engineering',
  'research',
  'operations',
  'meeting',
  'rest',
  'public',
]

export function compileWorldSemantics(
  manifest: WorldThemeManifestV1,
  sceneId?: string,
): CompiledWorldSemantics {
  const scene = manifest.scenes.find((candidate) => candidate.id === sceneId) ?? manifest.scenes[0]
  if (scene === undefined) throw new Error(`Theme ${manifest.id} does not define a scene`)

  const anchorZones = new Map<string, WorldZoneKind>()
  for (const anchor of scene.anchors) anchorZones.set(anchor.id, inferZoneKind(anchor))

  const facilityByAnchor = new Map<string, WorldThemeInteractableManifest>()
  for (const interactable of scene.interactables) {
    for (const anchorId of interactable.approachAnchorIds) {
      if (!facilityByAnchor.has(anchorId)) facilityByAnchor.set(anchorId, interactable)
    }
  }

  const slots = scene.anchors.flatMap((anchor) => {
    const zone = anchorZones.get(anchor.id) ?? 'public'
    const facility = facilityByAnchor.get(anchor.id)
    return createSlots(scene.id, anchor, zone, facility)
  })

  const zones = createZones(scene, anchorZones)
  const facilities = scene.interactables.map((interactable) =>
    createFacility(scene.id, interactable, anchorZones, slots))

  return {
    contractVersion: 1,
    themeId: manifest.id,
    sceneId: scene.id,
    navigation: structuredClone(scene.navigation),
    zones,
    facilities,
    slots,
  }
}

export function resolveCharacterBehavior(
  character: Pick<EmployeeInstance, 'blueprintId' | 'displayName' | 'role'>,
  configured?: CharacterBehaviorProfile,
): CharacterBehaviorProfile {
  if (configured !== undefined) return cloneBehaviorProfile(configured)
  const identity = `${character.blueprintId} ${character.role} ${character.displayName}`.toLowerCase()

  if (containsAny(identity, ['secretary', '秘书', 'butler', '管家', 'assistant', '助理'])) {
    return behaviorProfile({
      id: 'coordination',
      roleTags: ['administration', 'coordination', 'schedule'],
      preferredZoneTags: ['administration', 'public'],
      preferredFacilityCapabilities: ['coordination', 'schedule', 'meeting', 'archive'],
      homeSlotTags: ['administration', 'coordination', 'work'],
      ambientBehaviors: ['stay-at-home', 'organize-schedule', 'inspect-meeting-room'],
    })
  }

  if (containsAny(identity, ['engineer', 'developer', 'software', '工程师', '开发', '架构'])) {
    return behaviorProfile({
      id: 'engineering',
      roleTags: ['engineering', 'coding', 'testing'],
      preferredZoneTags: ['engineering'],
      preferredFacilityCapabilities: ['coding', 'testing', 'work'],
      homeSlotTags: ['engineering', 'coding', 'work'],
      ambientBehaviors: ['stay-at-home', 'inspect-board', 'take-short-break'],
    })
  }

  if (containsAny(identity, ['archive', 'research', 'knowledge', '档案', '研究', '知识'])) {
    return behaviorProfile({
      id: 'research',
      roleTags: ['research', 'archive', 'knowledge'],
      preferredZoneTags: ['research'],
      preferredFacilityCapabilities: ['research', 'archive', 'inspect'],
      homeSlotTags: ['research', 'archive', 'work'],
      ambientBehaviors: ['stay-at-home', 'inspect-archive', 'organize-knowledge'],
    })
  }

  if (containsAny(identity, ['ops', 'operation', '运维', '运营', '监控'])) {
    return behaviorProfile({
      id: 'operations',
      roleTags: ['operations', 'monitoring'],
      preferredZoneTags: ['operations'],
      preferredFacilityCapabilities: ['operations', 'monitoring', 'work'],
      homeSlotTags: ['operations', 'monitoring', 'work'],
      ambientBehaviors: ['stay-at-home', 'inspect-console', 'take-short-break'],
    })
  }

  return behaviorProfile({
    id: 'general',
    roleTags: ['general'],
    preferredZoneTags: ['public', 'rest'],
    preferredFacilityCapabilities: ['work', 'conversation'],
    homeSlotTags: ['public', 'work', 'rest'],
    ambientBehaviors: ['stay-at-home', 'take-short-break'],
  })
}

export function assignCharacterHomeSlots(
  characters: readonly Pick<EmployeeInstance, 'id' | 'blueprintId' | 'displayName' | 'role'>[],
  semantics: CompiledWorldSemantics,
  retained: ReadonlyMap<string, string> = new Map(),
  profiles: ReadonlyMap<string, CharacterBehaviorProfile> = new Map(),
): Map<string, WorldSlotDefinition> {
  const result = new Map<string, WorldSlotDefinition>()
  const occupied = new Set<string>()

  for (const character of [...characters].sort((left, right) => left.id.localeCompare(right.id))) {
    const retainedSlotId = retained.get(character.id)
    const retainedSlot = retainedSlotId === undefined
      ? undefined
      : semantics.slots.find((slot) => slot.id === retainedSlotId)
    if (retainedSlot !== undefined && (!retainedSlot.exclusive || !occupied.has(retainedSlot.id))) {
      result.set(character.id, retainedSlot)
      if (retainedSlot.exclusive) occupied.add(retainedSlot.id)
      continue
    }

    const profile = resolveCharacterBehavior(character, profiles.get(character.id))
    const candidate = rankSlots(semantics.slots, profile, occupied, 'home')[0]
      ?? semantics.slots.find((slot) => !slot.exclusive || !occupied.has(slot.id))
    if (candidate === undefined) continue
    result.set(character.id, candidate)
    if (candidate.exclusive) occupied.add(candidate.id)
  }

  return result
}

export function selectCharacterSlot(
  character: Pick<EmployeeInstance, 'id' | 'blueprintId' | 'displayName' | 'role'>,
  semantics: CompiledWorldSemantics,
  occupiedSlotIds: ReadonlySet<string>,
  purpose: 'home' | 'task' | 'meeting' | 'conversation' | 'rest',
  configured?: CharacterBehaviorProfile,
): WorldSlotDefinition | undefined {
  return rankSlots(
    semantics.slots,
    resolveCharacterBehavior(character, configured),
    occupiedSlotIds,
    purpose,
  )[0]
}

export function rankSlots(
  slots: readonly WorldSlotDefinition[],
  profile: CharacterBehaviorProfile,
  occupiedSlotIds: ReadonlySet<string>,
  purpose: 'home' | 'task' | 'meeting' | 'conversation' | 'rest',
): WorldSlotDefinition[] {
  return slots
    .filter((slot) => !slot.exclusive || !occupiedSlotIds.has(slot.id))
    .filter((slot) => slotAllowedByProfile(slot, profile))
    .filter((slot) => slotAllowedForPurpose(slot, purpose))
    .map((slot) => ({ slot, score: scoreSlot(slot, profile, purpose) }))
    .sort((left, right) => right.score - left.score || left.slot.id.localeCompare(right.slot.id))
    .map((entry) => entry.slot)
}

function createSlots(
  sceneId: string,
  anchor: WorldThemeAnchorManifest,
  zone: WorldZoneKind,
  facility?: WorldThemeInteractableManifest,
): WorldSlotDefinition[] {
  const count = Math.max(1, anchor.capacity)
  const kind = inferSlotKind(anchor, facility)
  return Array.from({ length: count }, (_, index) => ({
    id: `${anchor.id}:slot-${index + 1}`,
    sceneId,
    zoneId: `zone-${zone}`,
    ...(facility === undefined ? {} : { facilityId: facility.id }),
    anchorId: anchor.id,
    kind,
    position: spreadPosition(anchor.position, count, index),
    facing: anchor.facing,
    posture: kind === 'seat' || kind === 'work' ? 'sit' : 'stand',
    capacity: 1,
    exclusive: kind !== 'waiting',
    tags: unique([zone, kind, ...anchor.tags, ...(facility === undefined ? [] : facilityCapabilities(facility))]),
  }))
}

function createZones(
  scene: WorldThemeSceneManifest,
  anchorZones: ReadonlyMap<string, WorldZoneKind>,
): WorldZoneDefinition[] {
  const result: WorldZoneDefinition[] = []
  for (const kind of unique([...anchorZones.values(), 'public' as const])) {
    const anchors = scene.anchors.filter((anchor) => anchorZones.get(anchor.id) === kind)
    const interactables = scene.interactables.filter((item) =>
      item.approachAnchorIds.some((anchorId) => anchorZones.get(anchorId) === kind))
    const bounds = boundsFor(anchors.map((anchor) => anchor.position), interactables.map((item) => item.bounds), scene)
    result.push({
      id: `zone-${kind}`,
      sceneId: scene.id,
      kind,
      displayName: zoneDisplayName(kind),
      bounds,
      tags: [kind],
      capacity: anchors.reduce((total, anchor) => total + Math.max(1, anchor.capacity), 0),
    })
  }
  return result.sort((left, right) => left.id.localeCompare(right.id))
}

function createFacility(
  sceneId: string,
  interactable: WorldThemeInteractableManifest,
  anchorZones: ReadonlyMap<string, WorldZoneKind>,
  slots: readonly WorldSlotDefinition[],
): WorldFacilityDefinition {
  const zone = interactable.approachAnchorIds
    .map((anchorId) => anchorZones.get(anchorId))
    .find((value): value is WorldZoneKind => value !== undefined) ?? 'public'
  return {
    id: interactable.id,
    sceneId,
    zoneId: `zone-${zone}`,
    kind: interactable.kind,
    displayName: interactable.displayName,
    capabilities: facilityCapabilities(interactable),
    slotIds: slots.filter((slot) => slot.facilityId === interactable.id).map((slot) => slot.id),
    metadata: {
      actionIds: interactable.actions.map((action) => action.id),
      zIndex: interactable.zIndex,
    },
  }
}

function inferZoneKind(anchor: WorldThemeAnchorManifest): WorldZoneKind {
  const explicit = anchor.tags.find((tag): tag is WorldZoneKind => ZONE_TAGS.includes(tag as WorldZoneKind))
  if (explicit !== undefined) return explicit
  const identity = `${anchor.id} ${anchor.tags.join(' ')}`.toLowerCase()
  if (containsAny(identity, ['engineering', 'engineer', 'coding', 'architecture'])) return 'engineering'
  if (containsAny(identity, ['product', 'admin', 'coordination', 'secretary'])) return 'administration'
  if (containsAny(identity, ['research', 'archive', 'knowledge', 'milestone'])) return 'research'
  if (containsAny(identity, ['ops', 'operation', 'console', 'monitor'])) return 'operations'
  if (containsAny(identity, ['meeting'])) return 'meeting'
  if (containsAny(identity, ['lounge', 'idle', 'rest', 'talk'])) return 'rest'
  return 'public'
}

function inferSlotKind(
  anchor: WorldThemeAnchorManifest,
  facility?: WorldThemeInteractableManifest,
): WorldSlotKind {
  if (anchor.tags.includes('meeting')) return 'seat'
  if (anchor.tags.includes('work')) return 'work'
  if (anchor.tags.includes('idle') || anchor.tags.includes('rest')) return 'rest'
  if (anchor.tags.includes('talk')) return 'conversation'
  if (anchor.tags.includes('spawn')) return 'waiting'
  if (facility !== undefined) return 'approach'
  return 'home'
}

function facilityCapabilities(interactable: WorldThemeInteractableManifest): string[] {
  const identity = `${interactable.id} ${interactable.kind} ${interactable.displayName}`.toLowerCase()
  const values = [interactable.kind, ...interactable.actions.map((action) => action.id)]
  if (containsAny(identity, ['workstation', '研发', 'coding'])) values.push('work', 'coding', 'testing')
  if (containsAny(identity, ['meeting', '会议'])) values.push('meeting', 'coordination', 'conversation')
  if (containsAny(identity, ['ops', 'console', '控制台'])) values.push('operations', 'monitoring')
  if (containsAny(identity, ['milestone', '档案', '知识'])) values.push('research', 'archive', 'inspect')
  return unique(values)
}

function scoreSlot(
  slot: WorldSlotDefinition,
  profile: CharacterBehaviorProfile,
  purpose: 'home' | 'task' | 'meeting' | 'conversation' | 'rest',
): number {
  let score = 0
  if (profile.preferredZoneTags.some((tag) => slot.tags.includes(tag))) score += 500
  if (profile.homeSlotTags.some((tag) => slot.tags.includes(tag))) score += purpose === 'home' ? 450 : 120
  if (profile.preferredFacilityCapabilities.some((tag) => slot.tags.includes(tag))) score += purpose === 'task' ? 420 : 100
  if (purpose === 'meeting' && slot.kind === 'seat' && slot.tags.includes('meeting')) score += 1_000
  if (purpose === 'conversation' && (slot.kind === 'conversation' || slot.tags.includes('talk') || slot.tags.includes('meeting'))) score += 900
  if (purpose === 'rest' && slot.kind === 'rest') score += 900
  if (purpose === 'task' && slot.kind === 'work') score += 700
  if (purpose === 'home' && (slot.kind === 'work' || slot.kind === 'home' || slot.kind === 'rest')) score += 300
  if (slot.zoneId === 'zone-public') score += 5
  return score
}

function slotAllowedByProfile(
  slot: WorldSlotDefinition,
  profile: CharacterBehaviorProfile,
): boolean {
  if (profile.allowedZoneTags.length === 0) return true
  return profile.allowedZoneTags.some((tag) =>
    slot.tags.includes(tag) || slot.zoneId === `zone-${tag}`)
}

function slotAllowedForPurpose(
  slot: WorldSlotDefinition,
  purpose: 'home' | 'task' | 'meeting' | 'conversation' | 'rest',
): boolean {
  if (purpose === 'meeting') return slot.kind === 'seat' && slot.tags.includes('meeting')
  if (purpose === 'conversation') return slot.kind === 'conversation' || slot.tags.includes('talk') || slot.tags.includes('meeting')
  if (purpose === 'rest') return slot.kind === 'rest' || slot.tags.includes('rest')
  if (purpose === 'task') return slot.kind === 'work' || slot.tags.includes('work')
  return slot.kind === 'home' || slot.kind === 'work' || slot.kind === 'rest' || slot.kind === 'waiting'
}

function behaviorProfile(input: Omit<CharacterBehaviorProfile, 'allowedZoneTags' | 'socialPolicy'>): CharacterBehaviorProfile {
  return {
    ...input,
    allowedZoneTags: ['administration', 'engineering', 'research', 'operations', 'meeting', 'rest', 'public'],
    socialPolicy: {
      canInitiateConversation: true,
      cooldownSeconds: 300,
      maxDailyConversations: 8,
    },
  }
}

function cloneBehaviorProfile(profile: CharacterBehaviorProfile): CharacterBehaviorProfile {
  return {
    id: profile.id,
    roleTags: [...profile.roleTags],
    preferredZoneTags: [...profile.preferredZoneTags],
    preferredFacilityCapabilities: [...profile.preferredFacilityCapabilities],
    allowedZoneTags: [...profile.allowedZoneTags],
    homeSlotTags: [...profile.homeSlotTags],
    ambientBehaviors: [...profile.ambientBehaviors],
    socialPolicy: { ...profile.socialPolicy },
  }
}

function spreadPosition(origin: WorldPoint, count: number, index: number): WorldPoint {
  if (count <= 1) return { ...origin }
  const columns = Math.min(count, 3)
  const column = index % columns
  const row = Math.floor(index / columns)
  const gap = 86
  return {
    x: origin.x + (column - (columns - 1) / 2) * gap,
    y: origin.y + row * gap,
  }
}

function boundsFor(points: WorldPoint[], rects: WorldRect[], scene: WorldThemeSceneManifest): WorldRect {
  if (points.length === 0 && rects.length === 0) return { ...scene.safeArea }
  const xs = [...points.map((point) => point.x), ...rects.flatMap((rect) => [rect.x, rect.x + rect.width])]
  const ys = [...points.map((point) => point.y), ...rects.flatMap((rect) => [rect.y, rect.y + rect.height])]
  const minX = Math.max(0, Math.min(...xs) - 96)
  const minY = Math.max(0, Math.min(...ys) - 96)
  const maxX = Math.min(scene.size.width, Math.max(...xs) + 96)
  const maxY = Math.min(scene.size.height, Math.max(...ys) + 96)
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

function zoneDisplayName(kind: WorldZoneKind): string {
  const names: Record<WorldZoneKind, string> = {
    administration: '行政协调区',
    engineering: '研发区',
    research: '研究与档案区',
    operations: '运行区',
    meeting: '协作会议区',
    rest: '休息与交流区',
    public: '公共区',
    custom: '自定义区域',
  }
  return names[kind]
}

function containsAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle))
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
