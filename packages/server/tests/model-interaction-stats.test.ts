import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ModelInteractionService } from '../src/services/model-interaction-service.js'
import { SqliteStore } from '@dsh-cyber/persistence'

const stores: SqliteStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function makeStore() {
  const path = join(tmpdir(), `dsh-cyber-stats-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const store = await SqliteStore.open(path)
  stores.push(store)
  return store
}

describe('ModelInteractionService aggregateStats (unit)', () => {
  it('returns all-zero for empty workspace', async () => {
    const store = await makeStore()
    const wsId = store.createWorkspace({ name: 'stats-test' }).id
    const svc = new ModelInteractionService(store)

    const result = svc.aggregateStats(wsId, { groupBy: 'all' })
    expect(result.summary.totalTokensSent).toBe(0)
    expect(result.summary.totalRequests).toBe(0)
    expect(result.summary.successRate).toBe(0)
    expect(result.items).toEqual([])
  })

  it('aggregates token totals across multiple records', async () => {
    const store = await makeStore()
    const wsId = store.createWorkspace({ name: 'stats-test' }).id
    const svc = new ModelInteractionService(store)

    svc.recordTurn({
      workspaceId: wsId,
      modelId: 'gpt-4',
      provider: 'OpenAI',
      status: 'success',
      prompt: 'hello',
      response: 'hi',
      durationMs: 100,
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
      httpStatus: 200,
    })
    svc.recordTurn({
      workspaceId: wsId,
      modelId: 'gpt-4',
      provider: 'OpenAI',
      status: 'success',
      prompt: 'world',
      response: 'earth',
      durationMs: 200,
      tokenUsage: { prompt: 20, completion: 10, total: 30 },
      httpStatus: 200,
    })
    svc.recordTurn({
      workspaceId: wsId,
      modelId: 'gpt-4',
      provider: 'OpenAI',
      status: 'failed',
      prompt: 'error',
      response: '',
      durationMs: 50,
      tokenUsage: { prompt: 3, completion: 0, total: 3 },
      httpStatus: 500,
    })

    const result = svc.aggregateStats(wsId, { groupBy: 'all' })
    expect(result.summary.totalTokensSent).toBe(33)
    expect(result.summary.totalTokensReceived).toBe(15)
    expect(result.summary.totalRequests).toBe(3)
    expect(result.summary.successCount).toBe(2)
    expect(result.summary.successRate).toBeCloseTo(66.67, 1)
  })

  it('groups by provider with correct per-model sums', async () => {
    const store = await makeStore()
    const wsId = store.createWorkspace({ name: 'stats-test' }).id
    const svc = new ModelInteractionService(store)

    svc.recordTurn({ workspaceId: wsId, modelId: 'gpt-4', provider: 'OpenAI', status: 'success', prompt: 'a', response: 'b', durationMs: 100, tokenUsage: { prompt: 10, completion: 5, total: 15 }, httpStatus: 200 })
    svc.recordTurn({ workspaceId: wsId, modelId: 'claude-3', provider: 'Anthropic', status: 'success', prompt: 'c', response: 'd', durationMs: 200, tokenUsage: { prompt: 20, completion: 10, total: 30 }, httpStatus: 200 })
    svc.recordTurn({ workspaceId: wsId, modelId: 'claude-3', provider: 'Anthropic', status: 'failed', prompt: 'e', response: '', durationMs: 50, tokenUsage: { prompt: 2, completion: 0, total: 2 }, httpStatus: 429 })

    // All records across all providers
    const all = svc.aggregateStats(wsId, { groupBy: 'all' })
    expect(all.summary.totalRequests).toBe(3)

    // OpenAI provider: only gpt-4 (no aggregate row in items)
    const openai = svc.aggregateStats(wsId, { groupBy: 'provider', providerId: 'OpenAI' })
    expect(openai.items.length).toBe(1)
    expect(openai.items[0].id).toBe('gpt-4')
    expect(openai.items[0].requests).toBe(1)
    expect(openai.items[0].tokensSent).toBe(10)
    expect(openai.summary.totalRequests).toBe(1)

    // Anthropic provider: only claude-3 (no aggregate row in items)
    const anthropic = svc.aggregateStats(wsId, { groupBy: 'provider', providerId: 'Anthropic' })
    expect(anthropic.items.length).toBe(1)
    expect(anthropic.items[0].id).toBe('claude-3')
    expect(anthropic.items[0].requests).toBe(2)
    expect(anthropic.items[0].tokensSent).toBe(22)
    expect(anthropic.summary.totalRequests).toBe(2)
  })

  it('coalesces null tokens to 0 (image generation pattern)', async () => {
    const store = await makeStore()
    const wsId = store.createWorkspace({ name: 'stats-test' }).id
    const svc = new ModelInteractionService(store)

    // Image generation turn typically has no token usage fields
    svc.recordTurn({ workspaceId: wsId, modelId: 'image-model', provider: 'img-provider', status: 'success', prompt: 'draw', response: 'url', durationMs: 5000 })

    const result = svc.aggregateStats(wsId, { groupBy: 'provider', providerId: 'img-provider' })
    expect(result.summary.totalRequests).toBe(1)
    expect(result.summary.totalTokensSent).toBe(0)
    expect(result.summary.totalTokensReceived).toBe(0)
    expect(result.items[0].tokensSent).toBe(0)
  })

  it('respects date bounds in query', async () => {
    const store = await makeStore()
    const wsId = store.createWorkspace({ name: 'stats-test' }).id
    const svc = new ModelInteractionService(store)

    svc.recordTurn({ workspaceId: wsId, modelId: 'gpt-4', provider: 'OpenAI', status: 'success', prompt: 'hi', response: 'hello', durationMs: 100, tokenUsage: { prompt: 5, completion: 3, total: 8 }, httpStatus: 200 })

    // Default window (last 7 days) should include the record
    const all = svc.aggregateStats(wsId, { groupBy: 'all' })
    expect(all.summary.totalRequests).toBe(1)

    // Far future window should exclude it
    const future = svc.aggregateStats(wsId, {
      groupBy: 'all',
      from: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      to: new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString(),
    })
    expect(future.summary.totalRequests).toBe(0)
  })

  it('throws on invalid groupBy', async () => {
    const store = await makeStore()
    const wsId = store.createWorkspace({ name: 'stats-test' }).id
    const svc = new ModelInteractionService(store)

    expect(() => svc.aggregateStats(wsId, { groupBy: 'invalid' as any })).toThrow()
  })
})
