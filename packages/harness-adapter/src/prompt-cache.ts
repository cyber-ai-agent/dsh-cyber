import type { PromptCacheOutcome, PromptCachePolicy } from '@dsh-cyber/contracts'
import { promptCacheKey } from '@dsh-cyber/contracts'

/**
 * Maps the domain's provider-neutral prompt cache policy onto what the DeepSeek
 * Harness runtime can actually do.
 *
 * What 0.1.2-rc.1 offers, checked rather than assumed: the SDK exposes no
 * cache knob at all — no `cache_control`, no `prompt_cache_key`, nothing on the
 * agent, session or turn surface. What it does expose is accounting:
 * `TokenUsage` carries `cacheReadTokens` / `cacheWriteTokens`, and the DeepSeek
 * LLM adapter fills them from the provider's `prompt_cache_hit_tokens`.
 *
 * So on the openai-completions route (DeepSeek's own API) caching is automatic
 * and prefix-based: the provider matches the leading bytes of the request by
 * itself, which is precisely why the layer ordering matters and why nothing here
 * needs to be sent. Every other route reports `unsupported` and the prompt goes
 * out unchanged — a runtime that cannot cache must still produce a correct turn.
 *
 * The declared key travels on the outcome either way. An automatic provider
 * never receives it, but two turns that *should* have shared a prefix are only
 * distinguishable from two that never could if the identity is recorded.
 */
export function resolveHarnessPromptCache(
  policy: PromptCachePolicy | undefined,
  api: string | undefined,
): PromptCacheOutcome | undefined {
  if (policy === undefined) return undefined
  if (!policy.enabled) {
    return { policy, mode: 'disabled', reason: '上下文策略未对本轮启用提示缓存' }
  }
  const cacheKey = promptCacheKey(policy)
  if (normalizedApi(api) !== 'openai-completions') {
    return {
      policy,
      mode: 'unsupported',
      ...(cacheKey === undefined ? {} : { cacheKey }),
      reason: `当前模型接口 ${api ?? '未知'} 不提供提示缓存，本轮提示按原样发送`,
    }
  }
  return {
    policy,
    mode: 'automatic',
    ...(cacheKey === undefined ? {} : { cacheKey }),
  }
}

function normalizedApi(api: string | undefined): string {
  return (api ?? '').trim().toLowerCase()
}
