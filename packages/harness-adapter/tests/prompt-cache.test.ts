import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  EmployeeInstance,
  EmployeeRevision,
  PromptCachePolicy,
} from '@dsh-cyber/contracts'

import {
  HarnessCompatibilityAdapter,
  extractHarnessTokenUsage,
  resolveHarnessPromptCache,
  type HarnessProviderProfile,
  type HarnessRuntime,
} from '../src/index.js'

function employee(): EmployeeInstance {
  return {
    id: 'employee-1',
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    blueprintId: 'engineer',
    blueprintVersion: 1,
    displayName: '小刘',
    role: '软件工程师',
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  }
}

function revision(): EmployeeRevision {
  return {
    employeeId: 'employee-1',
    revision: 1,
    persona: '先建立基线，再实施变更。',
    skillGrants: [],
    capabilityGrants: [],
    modelPolicy: {},
    reason: 'recruited',
    createdAt: '2026-08-19T00:00:00.000Z',
  }
}

function policy(overrides: Partial<PromptCachePolicy> = {}): PromptCachePolicy {
  return {
    enabled: true,
    namespace: 'world-1/employee-1',
    scope: 'employee',
    stablePrefixHash: 'a'.repeat(32),
    retentionHint: 'long',
    ...overrides,
  }
}

function usageNotification(usage: unknown) {
  return [{
    method: 'session.event' as const,
    params: {
      sessionId: 'employee-1',
      event: { type: 'assistant/message', data: { turn: 1, step: 1, usage } },
    },
  }]
}

function providerProfile(api: string): HarnessProviderProfile {
  return {
    route: 'route-1',
    displayName: '测试模型',
    api,
    baseURL: 'https://example.invalid/v1',
    model: { id: 'test-model' },
  }
}

async function runOneTurn(
  api: string | undefined,
  promptCache: PromptCachePolicy | undefined,
): Promise<{ prompts: string[]; result: Awaited<ReturnType<HarnessCompatibilityAdapter['runTurn']>> }> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-prompt-cache-'))
  const prompts: string[] = []
  const runtime: HarnessRuntime = {
    async run(sessionId, prompt) {
      prompts.push(prompt)
      const notification = {
        method: 'session.event',
        params: {
          sessionId,
          event: {
            type: 'assistant/message',
            data: { turn: 1, step: 1, usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 900 } },
          },
        },
      }
      return { finalResponse: '已完成', notifications: [notification] }
    },
    async close() {},
  }
  const adapter = new HarnessCompatibilityAdapter({
    stateRoot,
    runtimeFactory: () => runtime,
    ...(api === undefined ? {} : { providerProfile: providerProfile(api) }),
  })
  try {
    const result = await adapter.runTurn({
      agent: employee(),
      revision: revision(),
      conversationId: 'conversation-direct',
      prompt: '把这一轮的结论写下来',
      workspacePath: stateRoot,
      history: [],
      observedThroughSequence: 0,
      ...(promptCache === undefined ? {} : { promptCache }),
    })
    return { prompts, result }
  } finally {
    await adapter.close()
  }
}

describe('Harness prompt cache', () => {
  it('maps DSH disjoint token usage without losing the cached prompt tokens', () => {
    // DSH `TokenUsage`: `inputTokens` is UNCACHED input only; billed prompt is
    // the sum of the three buckets.
    const usage = extractHarnessTokenUsage(usageNotification({
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
      totalTokens: 1_340,
    }))
    expect(usage).toEqual({
      prompt: 1_300,
      completion: 40,
      total: 1_340,
      cachedPrompt: 900,
      // A cache write was read by the model this call, so it is not "cached".
      uncachedPrompt: 400,
    })
  })

  it('does not double count a provider whose prompt total already contains the hits', () => {
    const usage = extractHarnessTokenUsage(usageNotification({
      prompt_tokens: 1_200,
      completion_tokens: 40,
      total_tokens: 1_240,
      prompt_cache_hit_tokens: 1_024,
      prompt_cache_miss_tokens: 176,
    }))
    expect(usage).toEqual({
      prompt: 1_200,
      completion: 40,
      total: 1_240,
      cachedPrompt: 1_024,
      uncachedPrompt: 176,
    })
  })

  it('reads the OpenAI-compatible spelling of the hit count', () => {
    const usage = extractHarnessTokenUsage(usageNotification({
      prompt_tokens: 500,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 320 },
    }))
    expect(usage).toMatchObject({ prompt: 500, cachedPrompt: 320, uncachedPrompt: 180 })
  })

  it('leaves the cache fields absent rather than fabricating a zero', () => {
    const usage = extractHarnessTokenUsage(usageNotification({
      prompt_tokens: 420,
      completion_tokens: 80,
      total_tokens: 500,
    }))
    expect(usage).toEqual({ prompt: 420, completion: 80, total: 500 })
    expect(usage).not.toHaveProperty('cachedPrompt')
    expect(usage).not.toHaveProperty('uncachedPrompt')
  })

  it('reports a real miss as zero, which is not the same fact as no accounting', () => {
    const usage = extractHarnessTokenUsage(usageNotification({
      inputTokens: 1_000,
      outputTokens: 30,
      cacheReadTokens: 0,
    }))
    expect(usage).toMatchObject({ prompt: 1_000, cachedPrompt: 0, uncachedPrompt: 1_000 })
  })

  it('treats a prefix-caching provider as automatic and records the cache identity', () => {
    const outcome = resolveHarnessPromptCache(policy(), 'openai-completions')
    expect(outcome).toEqual({
      policy: policy(),
      mode: 'automatic',
      cacheKey: `world-1/employee-1:employee:${'a'.repeat(32)}`,
    })
  })

  it('degrades to unsupported on a provider the runtime cannot cache through', () => {
    const outcome = resolveHarnessPromptCache(policy(), 'anthropic-messages')
    expect(outcome?.mode).toBe('unsupported')
    expect(outcome?.reason).toContain('anthropic-messages')
  })

  it('reports a disabled policy as disabled and hands out no cache identity', () => {
    const outcome = resolveHarnessPromptCache(policy({ enabled: false }), 'openai-completions')
    expect(outcome?.mode).toBe('disabled')
    expect(outcome?.cacheKey).toBeUndefined()
  })

  it('declares nothing when the turn carried no policy at all', () => {
    expect(resolveHarnessPromptCache(undefined, 'openai-completions')).toBeUndefined()
  })

  it('still produces a correct prompt on a provider without cache support', async () => {
    const cached = await runOneTurn('openai-completions', policy())
    const uncacheable = await runOneTurn('anthropic-messages', policy())

    // The policy never touches the prompt: the ordering already did the work.
    expect(uncacheable.prompts).toEqual(cached.prompts)
    expect(uncacheable.prompts[0]).toBe('把这一轮的结论写下来')
    expect(uncacheable.result.finalResponse).toBe('已完成')
    expect(uncacheable.result.promptCache?.mode).toBe('unsupported')
    expect(cached.result.promptCache?.mode).toBe('automatic')
    // Usage still comes from the runtime's own numbers on both routes.
    expect(uncacheable.result.tokenUsage).toEqual(cached.result.tokenUsage)
    expect(cached.result.tokenUsage).toMatchObject({ prompt: 1_200, cachedPrompt: 900, uncachedPrompt: 300 })
  })

  it('runs a turn unchanged when no cache policy was declared', async () => {
    const { prompts, result } = await runOneTurn('openai-completions', undefined)
    expect(prompts[0]).toBe('把这一轮的结论写下来')
    expect(result.promptCache).toBeUndefined()
    expect(result.finalResponse).toBe('已完成')
  })
})
