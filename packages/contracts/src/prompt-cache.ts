/**
 * Provider-neutral prompt caching (Magic Context V1, slice D2.5).
 *
 * Prompt caching is not an optimisation bolted onto a provider call: it is the
 * pay-off of the layer ordering D1 established. A provider can only reuse work
 * across two turns when the *first* bytes of the prompt are byte-identical, so
 * the cacheable prefix — persona, world stable rules, stable skill instructions
 * — has to come first and must not move. `composeStableIdentity` already hashes
 * exactly that prefix deterministically; this module turns that hash into a
 * declared policy the domain can reason about.
 *
 * Nothing here knows what `cache_control` or `prompt_cache_key` are. Those are
 * one provider's spelling. A provider adapter maps this policy to whatever its
 * API actually accepts, and a provider that cannot cache at all reports that
 * honestly instead of failing the turn.
 */

/** What unit of work a cached prefix may be reused across. */
export type PromptCacheScope =
  /** Reusable across every conversation of one character. */
  | 'employee'
  /** Reusable only inside one conversation. */
  | 'conversation'
  /** Reusable across every character of one world. */
  | 'world'

/**
 * How long the prefix is worth keeping, in intent rather than in seconds.
 *
 * A provider adapter maps this to its own TTL vocabulary; providers disagree on
 * both the units and the available steps, so the domain refuses to pick one.
 */
export type PromptCacheRetentionHint = 'short' | 'long'

/**
 * The floor below which no provider caches anything.
 *
 * Every provider that offers prefix caching imposes a minimum prefix size, and
 * the smallest of them is well above this. Declaring a policy for a prefix that
 * short would produce a cache identity no provider could ever honour, so the
 * policy is disabled instead of quietly never hitting. A provider's real, larger
 * minimum belongs in its adapter, not here.
 */
export const PROMPT_CACHE_MIN_PREFIX_TOKENS = 64

export interface PromptCachePolicy {
  /** False when this prefix must not be cached, or is too small to ever be. */
  enabled: boolean
  /**
   * Cache partition. A cached prefix is never reused across two namespaces,
   * whatever their content hashes say.
   */
  namespace: string
  scope: PromptCacheScope
  /** Content identity of the prefix that must not move: `stableContextHash`. */
  stablePrefixHash: string
  retentionHint?: PromptCacheRetentionHint
}

/** How a provider adapter actually honoured a declared policy for one turn. */
export type PromptCacheMode =
  /** The provider caches matching prefixes on its own; nothing was sent. */
  | 'automatic'
  /** The policy said not to cache. */
  | 'disabled'
  /** This provider cannot cache; the prompt was sent unchanged. */
  | 'unsupported'

/**
 * What a turn's provider adapter did with the policy.
 *
 * This is telemetry, not a private adapter detail: the Context Inspector reads
 * it next to the envelope to explain why a turn did or did not hit cache. The
 * token counts live on `ModelTokenUsage`, where the runtime's own numbers land,
 * so they are never restated (and never guessed) here.
 */
export interface PromptCacheOutcome {
  policy: PromptCachePolicy
  mode: PromptCacheMode
  /**
   * Cache identity of this prefix. A provider that accepts an explicit key
   * sends this; an automatic provider only reports it, so two turns that should
   * have shared a prefix can be told apart from two that never could.
   */
  cacheKey?: string
  /** Why the policy could not be honoured verbatim. */
  reason?: string
}

export interface DerivePromptCachePolicyInput {
  /** `ContextEnvelope.stableContextHash`. */
  stablePrefixHash: string
  namespace: string
  scope: PromptCacheScope
  /** Token estimate of the stable prefix layer(s). */
  stablePrefixTokens: number
  retentionHint?: PromptCacheRetentionHint
  /** Caller veto. A false here always wins. */
  enabled?: boolean
}

/**
 * Declares the cache policy for one composed turn.
 *
 * Deterministic by construction: every input is already a durable fact or a
 * content hash, so two turns that differ only in their dynamic layers declare
 * exactly the same policy. That is the property prompt caching lives on, and
 * it is why nothing here may read a clock or a counter.
 */
export function derivePromptCachePolicy(input: DerivePromptCachePolicyInput): PromptCachePolicy {
  const namespace = input.namespace.trim()
  const stablePrefixHash = input.stablePrefixHash.trim()
  const enabled = input.enabled !== false
    && namespace.length > 0
    && stablePrefixHash.length > 0
    && input.stablePrefixTokens >= PROMPT_CACHE_MIN_PREFIX_TOKENS
  return {
    enabled,
    namespace,
    scope: input.scope,
    stablePrefixHash,
    ...(input.retentionHint === undefined ? {} : { retentionHint: input.retentionHint }),
  }
}

/**
 * The cache identity of a policy's prefix, or `undefined` when it declares that
 * this prefix must not be cached.
 *
 * The namespace comes first so a key can never be confused across partitions by
 * a hash collision in the suffix.
 */
export function promptCacheKey(policy: PromptCachePolicy): string | undefined {
  if (!policy.enabled) return undefined
  return `${policy.namespace}:${policy.scope}:${policy.stablePrefixHash}`
}
