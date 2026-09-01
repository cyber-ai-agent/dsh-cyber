import { estimateTextTokens } from './context-budget.js'

/**
 * Provider-neutral context model (Magic Context V1, slice D1).
 *
 * An envelope describes *what* goes into a model turn, not the final prompt
 * string. Every layer keeps its own identity, its own content hash and the
 * durable rows it was derived from, so a later slice can reorder, re-budget or
 * inspect the layers without re-deriving them from free text.
 *
 * The `stableIdentity` layer is the reason the contract exists: it must hash
 * identically for two turns that carry the same durable facts, no matter what
 * the clock says or in which order a Map/Set happened to iterate. That byte
 * stability is what makes a cacheable prompt prefix possible later; nothing in
 * this module may read a clock, a counter or a random source.
 */

export const CONTEXT_ENVELOPE_VERSION = 1 as const

export type ContextLayerKind =
  | 'stable-identity'
  | 'world-context'
  | 'task-context'
  | 'memory-index'
  | 'retrieved-memories'
  | 'recent-conversation'
  | 'current-request'

/** Layer order from the most cacheable prefix to the most volatile suffix. */
export const CONTEXT_LAYER_ORDER = [
  'stable-identity',
  'world-context',
  'task-context',
  'memory-index',
  'retrieved-memories',
  'recent-conversation',
  'current-request',
] as const satisfies readonly ContextLayerKind[]

export type ContextSourceKind =
  | 'employee'
  | 'employee-revision'
  | 'employee-profile'
  | 'world'
  | 'world-authority'
  | 'permission-mode'
  | 'skill'
  | 'session'
  | 'work-turn'
  | 'message'
  | 'memory'
  | 'artifact'
  | 'knowledge-chunk'
  | 'request'

/**
 * A pointer back to the durable row a layer was built from.
 *
 * Context is always a projection. A source ref is what lets the Inspector, an
 * audit or a future re-ranker relocate the original fact instead of trusting
 * the rendered summary.
 */
export interface ContextSourceRef {
  kind: ContextSourceKind
  id: string
  /** Row revision or content hash when the source is versioned. */
  revision?: string
}

export interface ContextLayer {
  id: string
  kind: ContextLayerKind
  /** Source revision when the layer has one; otherwise the content hash. */
  revision: string
  contentHash: string
  tokenEstimate: number
  sourceRefs: ContextSourceRef[]
  text: string
}

export interface ContextEnvelope {
  envelopeVersion: typeof CONTEXT_ENVELOPE_VERSION
  stableIdentity: ContextLayer
  worldContext?: ContextLayer
  taskContext?: ContextLayer
  memoryIndex?: ContextLayer
  retrievedMemories?: ContextLayer
  recentConversation?: ContextLayer
  currentRequest: ContextLayer
  /** Cache identity of the prefix that must not move between turns. */
  stableContextHash: string
  totalTokenEstimate: number
}

export interface StableSkillInstruction {
  skillId: string
  text: string
  revision?: string
}

export interface StableIdentityAuthority {
  worldId: string
  role: string
  permissionGrants: readonly string[]
}

export interface StableIdentityInput {
  employeeId: string
  /** Employee persona and the revision that versions it. */
  persona: { text: string; revision: number }
  /** Employee profile projection (background, traits, forms of address). */
  profile?: { text: string; revision: number }
  worldAuthority?: StableIdentityAuthority
  /** Conversation permission guidance for the granted runtime mode. */
  permissionGuidance?: { mode: string; text: string }
  /**
   * Stable skill instructions. A Map is accepted because callers hold one, and
   * its iteration order is deliberately not part of the hash.
   */
  skillInstructions?: readonly StableSkillInstruction[] | ReadonlyMap<string, string>
}

const FNV_OFFSET_BASIS = 0x6c62272e07bb014262b821756295c58dn
const FNV_PRIME = 0x0000000001000000000000000000013bn
const FNV_MASK = (1n << 128n) - 1n
const HASH_ENCODER = new TextEncoder()

/**
 * Deterministic 128-bit FNV-1a over a canonical JSON encoding.
 *
 * This is a content identity for caching and change detection, not a security
 * primitive: it is dependency-free and identical in Node and the browser,
 * which matters because the same envelope is described on both sides.
 */
export function contextContentHash(value: unknown): string {
  let hash = FNV_OFFSET_BASIS
  for (const byte of HASH_ENCODER.encode(canonicalJson(value))) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & FNV_MASK
  }
  return hash.toString(16).padStart(32, '0')
}

export interface ComposeContextLayerInput {
  id: string
  kind: ContextLayerKind
  text: string
  sourceRefs?: readonly ContextSourceRef[]
  /** Source revision; defaults to the content hash when the layer has none. */
  revision?: string
}

export function composeContextLayer(input: ComposeContextLayerInput): ContextLayer {
  const text = input.text.trim()
  const contentHash = contextContentHash(text)
  return {
    id: input.id,
    kind: input.kind,
    revision: input.revision ?? contentHash,
    contentHash,
    tokenEstimate: estimateTextTokens(text),
    sourceRefs: normalizeSourceRefs(input.sourceRefs ?? []),
    text,
  }
}

/**
 * Composes the cacheable identity prefix.
 *
 * Everything that could move between two turns carrying the same facts is
 * normalized away here: skill instructions and permission grants are sorted,
 * blank sections are dropped, and no timestamp is read. Adding a field to this
 * function means adding it to that normalization too.
 */
export function composeStableIdentity(input: StableIdentityInput): ContextLayer {
  const skills = normalizeSkillInstructions(input.skillInstructions)
  const grants = input.worldAuthority === undefined
    ? []
    : [...new Set(input.worldAuthority.permissionGrants.map((grant) => grant.trim()).filter(Boolean))].sort()

  const sections: string[] = []
  const persona = input.persona.text.trim()
  if (persona) sections.push(persona)
  const profile = input.profile?.text.trim()
  if (profile) sections.push(`[当前角色资料]\n${profile}`)
  if (input.worldAuthority !== undefined) {
    sections.push([
      '[当前世界职权]',
      `角色：${input.worldAuthority.role.trim()}`,
      `已授予的世界权限：${grants.length === 0 ? '无' : grants.join('、')}`,
    ].join('\n'))
  }
  const guidance = input.permissionGuidance?.text.trim()
  if (guidance) sections.push(`[当前会话 DSH 操作权限]\n${guidance}`)
  if (skills.length > 0) {
    sections.push(`[已授权的工作方法]\n${skills.map((skill) => `- ${skill.text}`).join('\n')}`)
  }

  const sourceRefs: ContextSourceRef[] = [
    { kind: 'employee', id: input.employeeId },
    { kind: 'employee-revision', id: input.employeeId, revision: String(input.persona.revision) },
  ]
  if (input.profile !== undefined) {
    sourceRefs.push({ kind: 'employee-profile', id: input.employeeId, revision: String(input.profile.revision) })
  }
  if (input.worldAuthority !== undefined) {
    sourceRefs.push({
      kind: 'world-authority',
      id: input.worldAuthority.worldId,
      revision: contextContentHash([input.worldAuthority.role.trim(), grants]),
    })
  }
  if (input.permissionGuidance !== undefined) {
    sourceRefs.push({ kind: 'permission-mode', id: input.permissionGuidance.mode })
  }
  for (const skill of skills) {
    sourceRefs.push({
      kind: 'skill',
      id: skill.skillId,
      ...(skill.revision === undefined ? {} : { revision: skill.revision }),
    })
  }

  return composeContextLayer({
    id: `identity:${input.employeeId}`,
    kind: 'stable-identity',
    text: sections.join('\n\n'),
    sourceRefs,
  })
}

export interface ComposeContextEnvelopeInput {
  stableIdentity: ContextLayer
  currentRequest: ContextLayer
  worldContext?: ContextLayer
  taskContext?: ContextLayer
  memoryIndex?: ContextLayer
  retrievedMemories?: ContextLayer
  recentConversation?: ContextLayer
}

export function composeContextEnvelope(input: ComposeContextEnvelopeInput): ContextEnvelope {
  const envelope: ContextEnvelope = {
    envelopeVersion: CONTEXT_ENVELOPE_VERSION,
    stableIdentity: input.stableIdentity,
    ...(input.worldContext === undefined ? {} : { worldContext: input.worldContext }),
    ...(input.taskContext === undefined ? {} : { taskContext: input.taskContext }),
    ...(input.memoryIndex === undefined ? {} : { memoryIndex: input.memoryIndex }),
    ...(input.retrievedMemories === undefined ? {} : { retrievedMemories: input.retrievedMemories }),
    ...(input.recentConversation === undefined ? {} : { recentConversation: input.recentConversation }),
    currentRequest: input.currentRequest,
    stableContextHash: stableContextHash(input.stableIdentity),
    totalTokenEstimate: 0,
  }
  return { ...envelope, totalTokenEstimate: contextEnvelopeLayers(envelope).reduce((total, layer) => total + layer.tokenEstimate, 0) }
}

/** The present layers in cache-prefix order. */
export function contextEnvelopeLayers(envelope: ContextEnvelope): ContextLayer[] {
  const byKind: Record<ContextLayerKind, ContextLayer | undefined> = {
    'stable-identity': envelope.stableIdentity,
    'world-context': envelope.worldContext,
    'task-context': envelope.taskContext,
    'memory-index': envelope.memoryIndex,
    'retrieved-memories': envelope.retrievedMemories,
    'recent-conversation': envelope.recentConversation,
    'current-request': envelope.currentRequest,
  }
  return CONTEXT_LAYER_ORDER.flatMap((kind) => {
    const layer = byKind[kind]
    return layer === undefined ? [] : [layer]
  })
}

export function stableContextHash(identity: ContextLayer): string {
  return contextContentHash([identity.kind, identity.id, identity.contentHash])
}

function normalizeSkillInstructions(
  value: StableIdentityInput['skillInstructions'],
): StableSkillInstruction[] {
  const entries: StableSkillInstruction[] = value === undefined
    ? []
    : Array.isArray(value)
      ? [...value]
      : [...(value as ReadonlyMap<string, string>)].map(([skillId, text]) => ({ skillId, text }))
  const bySkillId = new Map<string, StableSkillInstruction>()
  for (const entry of entries) {
    const skillId = entry.skillId.trim()
    const text = entry.text.trim()
    if (!skillId || !text) continue
    bySkillId.set(skillId, {
      skillId,
      text,
      ...(entry.revision === undefined || !entry.revision.trim() ? {} : { revision: entry.revision.trim() }),
    })
  }
  return [...bySkillId.values()].sort((left, right) => left.skillId.localeCompare(right.skillId, 'en'))
}

function normalizeSourceRefs(refs: readonly ContextSourceRef[]): ContextSourceRef[] {
  const byKey = new Map<string, ContextSourceRef>()
  for (const ref of refs) {
    const id = ref.id.trim()
    if (!id) continue
    const normalized: ContextSourceRef = {
      kind: ref.kind,
      id,
      ...(ref.revision === undefined || !ref.revision.trim() ? {} : { revision: ref.revision.trim() }),
    }
    byKey.set(`${normalized.kind} ${normalized.id}`, normalized)
  }
  return [...byKey.values()]
}

/** Stable JSON: object keys sorted, Map/Set ordered, `undefined` dropped. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value instanceof Map) {
    return canonicalJson(Object.fromEntries([...value].map(([key, item]) => [String(key), item])))
  }
  if (value instanceof Set) return canonicalJson([...value].map((item) => canonicalJson(item)).sort())
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return 'null'
}
