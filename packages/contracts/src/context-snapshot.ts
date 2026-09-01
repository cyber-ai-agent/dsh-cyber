import type { ContextEnvelope, ContextLayer, ContextLayerKind, ContextSourceRef } from './context-envelope.js'
import { contextEnvelopeLayers, contextContentHash } from './context-envelope.js'

/**
 * What an AgentRun durably remembers about the context it ran with (slice D4).
 *
 * A snapshot deliberately stores **no prompt text**. Storing the rendered
 * prompt would make every run a second copy of user data, with its own
 * retention window, its own scope and its own leak surface — and that copy
 * would outlive the scope checks the composer applied when it built the
 * prompt in the first place.
 *
 * So a snapshot stores *structure and pointers*: which layers were present, in
 * which order, what each one hashed to, how many tokens it cost, and the
 * durable rows it was derived from. When someone needs the actual content for
 * debugging, it is reconstructed by reading those durable rows back — through
 * the same scope rules the composer applies. A pointer inherits the original's
 * access control; a copy does not.
 *
 * Everything here is derived from the envelope alone: no clock, no counter, no
 * random. Two runs with the same envelope produce the same snapshot body.
 */

export const CONTEXT_SNAPSHOT_VERSION = 1 as const

/**
 * One layer, described without its text.
 *
 * These are exactly the fields of `ContextLayer` minus `text`. The omission is
 * the contract: there is no field a caller could put prompt text into, so a
 * snapshot cannot become a prompt log by accident.
 */
export interface ContextSnapshotLayer {
  id: string
  kind: ContextLayerKind
  revision: string
  contentHash: string
  tokenEstimate: number
  sourceRefs: ContextSourceRef[]
}

/**
 * What the run cost, split at the cacheable boundary.
 *
 * `stablePrefixHash` is the identity of the prefix that must not move between
 * turns; `prefixReused` says whether the previous run of the same character in
 * the same conversation carried the same one. That is the only honest way to
 * see prefix-cache churn after the fact, because the runtime's own cache
 * counters are per-provider and are not durable.
 */
export interface ContextSnapshotCacheStats {
  /** Tokens in the layers that are eligible to stay cached across turns. */
  stablePrefixTokens: number
  /** Tokens in the layers that legitimately change every turn. */
  volatileTokens: number
  /** The prefix hash of the previous snapshot in the same conversation. */
  previousStablePrefixHash?: string
  /** True when that previous prefix hash is identical to this one. */
  prefixReused: boolean
}

export interface ContextSnapshot {
  snapshotVersion: typeof CONTEXT_SNAPSHOT_VERSION
  envelopeVersion: number
  /** Cache identity of the prefix, copied from the envelope. */
  stablePrefixHash: string
  /** Content identity of the whole layer structure, text excluded. */
  structureHash: string
  layers: ContextSnapshotLayer[]
  totalTokenEstimate: number
  cache: ContextSnapshotCacheStats
}

/**
 * The layers that may stay cached between two turns of the same conversation.
 *
 * Identity and world context are properties of the character, not of the turn.
 * Everything after them is re-selected per turn by design — retrieval reranks,
 * the raw window slides, the request is new — so counting them as cacheable
 * would report a cache hit rate the provider will never actually deliver.
 */
const STABLE_PREFIX_KINDS: ReadonlySet<ContextLayerKind> = new Set<ContextLayerKind>([
  'stable-identity',
  'world-context',
])

export interface ComposeContextSnapshotInput {
  envelope: ContextEnvelope
  /** Prefix hash of the previous run in the same conversation, when there is one. */
  previousStablePrefixHash?: string
}

/** Projects an envelope to the structure-and-pointers record that gets stored. */
export function composeContextSnapshot(input: ComposeContextSnapshotInput): ContextSnapshot {
  const layers = contextEnvelopeLayers(input.envelope).map(snapshotLayer)
  const previous = input.previousStablePrefixHash?.trim()
  const stablePrefixTokens = layers
    .filter((layer) => STABLE_PREFIX_KINDS.has(layer.kind))
    .reduce((total, layer) => total + layer.tokenEstimate, 0)
  return {
    snapshotVersion: CONTEXT_SNAPSHOT_VERSION,
    envelopeVersion: input.envelope.envelopeVersion,
    stablePrefixHash: input.envelope.stableContextHash,
    structureHash: contextContentHash(layers),
    layers,
    totalTokenEstimate: input.envelope.totalTokenEstimate,
    cache: {
      stablePrefixTokens,
      volatileTokens: Math.max(0, input.envelope.totalTokenEstimate - stablePrefixTokens),
      ...(previous === undefined || previous === '' ? {} : { previousStablePrefixHash: previous }),
      prefixReused: previous !== undefined && previous === input.envelope.stableContextHash,
    },
  }
}

/**
 * Drops `text` explicitly rather than spreading the layer.
 *
 * Spreading would silently carry over any field a later slice adds to
 * `ContextLayer`, including a rendered one. Listing the kept fields means a new
 * field has to be added here on purpose to reach the database.
 */
function snapshotLayer(layer: ContextLayer): ContextSnapshotLayer {
  return {
    id: layer.id,
    kind: layer.kind,
    revision: layer.revision,
    contentHash: layer.contentHash,
    tokenEstimate: layer.tokenEstimate,
    sourceRefs: layer.sourceRefs.map((ref) => ({
      kind: ref.kind,
      id: ref.id,
      ...(ref.revision === undefined ? {} : { revision: ref.revision }),
    })),
  }
}

/** All source refs of one kind across a snapshot, de-duplicated, order kept. */
export function contextSnapshotRefs(
  snapshot: ContextSnapshot,
  kind: ContextSourceRef['kind'],
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const layer of snapshot.layers) {
    for (const ref of layer.sourceRefs) {
      if (ref.kind !== kind || seen.has(ref.id)) continue
      seen.add(ref.id)
      ids.push(ref.id)
    }
  }
  return ids
}
