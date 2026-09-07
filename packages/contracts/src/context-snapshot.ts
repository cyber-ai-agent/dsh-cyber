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
 * Provider-neutral accounting for the exact input accepted by a runtime lane.
 *
 * The projection deliberately contains estimates and durable pointers only.
 * It never carries the rendered system prompt, user prompt, recovered history,
 * native tool schemas or retained provider messages.
 */
export interface RuntimeContextUsage {
  systemTokens: number
  promptTokens: number
  historyTokens: number
  nativeReservedTokens: number
  retainedTokens: number
  /** Highest durable history sequence included in this invocation, if any. */
  replayedThroughSequence?: number
  /** Exact durable history sequences included, in runtime order. */
  replayedSequences: number[]
  /** Durable rows behind the accepted input; no rendered text. */
  sourceRefs: ContextSourceRef[]
}

export function runtimeContextInputTokens(usage: RuntimeContextUsage): number {
  return usage.systemTokens
    + usage.promptTokens
    + usage.historyTokens
    + usage.nativeReservedTokens
    + usage.retainedTokens
}

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
  /** Exact runtime-facing accounting when the adapter reported it. */
  runtime?: RuntimeContextUsage
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
  'world-directory',
])

export interface ComposeContextSnapshotInput {
  envelope: ContextEnvelope
  /** Final accounting returned by the runtime adapter. */
  runtime?: RuntimeContextUsage
  /** Prefix hash of the previous run in the same conversation, when there is one. */
  previousStablePrefixHash?: string
}

/** Projects an envelope to the structure-and-pointers record that gets stored. */
export function composeContextSnapshot(input: ComposeContextSnapshotInput): ContextSnapshot {
  const runtimeRefs = input.runtime === undefined ? undefined : new Set(input.runtime.sourceRefs.map(sourceRefKey))
  const layers = contextEnvelopeLayers(input.envelope).map((layer) => snapshotLayer(layer, runtimeRefs))
  const previous = input.previousStablePrefixHash?.trim()
  const stablePrefixTokens = layers
    .filter((layer) => STABLE_PREFIX_KINDS.has(layer.kind))
    .reduce((total, layer) => total + layer.tokenEstimate, 0)
  const totalTokenEstimate = input.runtime === undefined
    ? input.envelope.totalTokenEstimate
    : runtimeContextInputTokens(input.runtime)
  return {
    snapshotVersion: CONTEXT_SNAPSHOT_VERSION,
    envelopeVersion: input.envelope.envelopeVersion,
    stablePrefixHash: input.envelope.stableContextHash,
    structureHash: contextContentHash(layers),
    layers,
    totalTokenEstimate,
    ...(input.runtime === undefined ? {} : { runtime: copyRuntimeContextUsage(input.runtime) }),
    cache: {
      stablePrefixTokens,
      volatileTokens: Math.max(0, totalTokenEstimate - stablePrefixTokens),
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
function snapshotLayer(layer: ContextLayer, runtimeRefs?: ReadonlySet<string>): ContextSnapshotLayer {
  return {
    id: layer.id,
    kind: layer.kind,
    revision: layer.revision,
    contentHash: layer.contentHash,
    tokenEstimate: layer.tokenEstimate,
    sourceRefs: layer.sourceRefs
      .filter((ref) => runtimeRefs === undefined || runtimeRefs.has(sourceRefKey(ref)))
      .map((ref) => ({
      kind: ref.kind,
      id: ref.id,
      ...(ref.revision === undefined ? {} : { revision: ref.revision }),
      })),
  }
}

function sourceRefKey(ref: ContextSourceRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.revision ?? ''}`
}

/**
 * The numbers of a snapshot, with the pointers left out.
 *
 * This is what a surface outside the Inspector (the trace card, a run list)
 * may show inline: how many tokens each layer cost and how many durable memory
 * rows the run was given. It carries no source refs at all, so a caller that
 * holds a summary cannot dereference anything — reading the rows a run pointed
 * at stays behind `ContextSnapshotService.reconstruct` and its scope checks.
 */
export interface ContextSnapshotLayerSummary {
  kind: ContextLayerKind
  tokenEstimate: number
}

export interface ContextSnapshotSummary {
  totalTokenEstimate: number
  /** Layers in envelope order, each with its own token estimate. */
  layers: ContextSnapshotLayerSummary[]
  /** Distinct durable memory rows the run was given, across every layer. */
  memoryHitCount: number
  stablePrefixTokens: number
  volatileTokens: number
  /** True when the previous run of the same pair carried the same stable prefix. */
  prefixReused: boolean
  /** Exact runtime-facing accounting, absent on legacy snapshots. */
  runtime?: RuntimeContextUsage
}

/** Projects a snapshot to its inline numbers. Pure and pointer-free by construction. */
export function summarizeContextSnapshot(snapshot: ContextSnapshot): ContextSnapshotSummary {
  return {
    totalTokenEstimate: snapshot.totalTokenEstimate,
    layers: snapshot.layers.map((layer) => ({ kind: layer.kind, tokenEstimate: layer.tokenEstimate })),
    memoryHitCount: contextSnapshotRefs(snapshot, 'memory').length,
    stablePrefixTokens: snapshot.cache.stablePrefixTokens,
    volatileTokens: snapshot.cache.volatileTokens,
    prefixReused: snapshot.cache.prefixReused,
    ...(snapshot.runtime === undefined ? {} : { runtime: copyRuntimeContextUsage(snapshot.runtime) }),
  }
}

/** Copies and normalizes the text-free runtime projection at trust boundaries. */
export function copyRuntimeContextUsage(usage: RuntimeContextUsage): RuntimeContextUsage {
  return {
    systemTokens: nonNegativeInteger(usage.systemTokens),
    promptTokens: nonNegativeInteger(usage.promptTokens),
    historyTokens: nonNegativeInteger(usage.historyTokens),
    nativeReservedTokens: nonNegativeInteger(usage.nativeReservedTokens),
    retainedTokens: nonNegativeInteger(usage.retainedTokens),
    ...(usage.replayedThroughSequence === undefined
      ? {}
      : { replayedThroughSequence: nonNegativeInteger(usage.replayedThroughSequence) }),
    replayedSequences: usage.replayedSequences.map(nonNegativeInteger),
    sourceRefs: usage.sourceRefs.map((ref) => ({
      kind: ref.kind,
      id: ref.id,
      ...(ref.revision === undefined ? {} : { revision: ref.revision }),
    })),
  }
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Runtime context estimate must be a non-negative integer')
  return value
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
