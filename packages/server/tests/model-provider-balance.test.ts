import { describe, expect, it, vi } from 'vitest'

import type { ModelProviderConnection } from '@dsh-cyber/contracts'

import { ModelProviderBalanceService } from '../src/services/model-provider-balance.js'
import { ServiceError } from '../src/services/service-error.js'

function provider(): ModelProviderConnection {
  return {
    id: 'p1',
    workspaceId: 'w1',
    kind: 'builtin',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    providerKind: 'deepseek',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

describe('ModelProviderBalanceService', () => {
  it('extracts only the wallet amounts from a DeepSeek response', async () => {
    const service = new ModelProviderBalanceService({
      fetch: vi.fn<typeof fetch>(async () => json({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '1.00', loaded_balance: '11.34' }],
        backend_version: 'internal-should-not-surface',
      })),
    })
    const result = await service.fetchBalance(provider(), 'deepseek', 'sk-key')
    expect(result.lines).toEqual(['总余额 12.34 CNY', '其中赠送额度 1.00 CNY'])
    expect(JSON.stringify(result)).not.toContain('internal-should-not-surface')
    expect(JSON.stringify(result)).not.toContain('sk-key')
  })

  it('summarizes an OpenRouter key against its limit', async () => {
    const service = new ModelProviderBalanceService({
      fetch: vi.fn<typeof fetch>(async () => json({ data: { usage: 0.0123, limit: 5, limit_remaining: 4.9877, is_free_tier: false } })),
    })
    const result = await service.fetchBalance({ ...provider(), baseUrl: 'https://openrouter.ai/api/v1' }, 'openrouter', 'sk-or')
    expect(result.lines.join(' ')).toContain('已使用 $0.0123')
    expect(result.lines.join(' ')).toContain('剩余 $4.9877')
  })

  it('reads the Kimi balance and surfaces a cash deficit only when negative', async () => {
    const service = new ModelProviderBalanceService({
      fetch: vi.fn<typeof fetch>(async (url) => {
        expect(String(url)).toBe('https://api.moonshot.cn/v1/users/me/balance')
        return json({ id: 'billing-internal-id', data: { available_balance: 88.5, voucher_balance: 0, cash_balance: -2.5 } })
      }),
    })
    const result = await service.fetchBalance({ ...provider(), baseUrl: 'https://api.moonshot.cn/v1' }, 'moonshot', 'km-key')
    expect(result.lines).toEqual(['可用余额 88.50 元', '现金已欠费 2.50 元'])
    expect(JSON.stringify(result)).not.toContain('billing-internal-id')
  })

  it('reads the SiliconFlow total balance and splits cash when it differs', async () => {
    const service = new ModelProviderBalanceService({
      fetch: vi.fn<typeof fetch>(async () => json({ data: { totalBalance: 100.25, balance: 40.25, bonus: 60 } })),
    })
    const result = await service.fetchBalance({ ...provider(), baseUrl: 'https://api.siliconflow.cn/v1' }, 'siliconflow', 'sf-key')
    expect(result.lines).toEqual(['总余额 100.25 元', '其中现金 40.25 元'])
    expect(JSON.stringify(result)).not.toContain('bonus')
  })

  it('reports nothing as a number when a shape does not match the parser', async () => {
    const service = new ModelProviderBalanceService({
      fetch: vi.fn<typeof fetch>(async () => json({ data: { unexpected: 'shape' } })),
    })
    await expect(service.fetchBalance({ ...provider(), baseUrl: 'https://api.moonshot.cn/v1' }, 'moonshot', 'k')).rejects.toMatchObject({ code: 'balance_invalid_response' })
  })

  it('refuses without a credential and never fabricates numbers', async () => {
    const service = new ModelProviderBalanceService({ fetch: vi.fn<typeof fetch>(async () => json({})) })
    await expect(service.fetchBalance(provider(), 'deepseek', undefined)).rejects.toThrowError(ServiceError)
    await expect(service.fetchBalance(provider(), 'deepseek', 'k')).rejects.toMatchObject({ code: 'balance_invalid_response' })
  })

  it('labels a rejected credential as such', async () => {
    const service = new ModelProviderBalanceService({
      fetch: vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 })),
    })
    await expect(service.fetchBalance(provider(), 'deepseek', 'bad')).rejects.toMatchObject({ code: 'balance_credential_rejected' })
  })

  it('only supports catalog-declared kinds', () => {
    const service = new ModelProviderBalanceService()
    expect(service.supports('deepseek')).toBe(true)
    expect(service.supports('openrouter')).toBe(true)
    expect(service.supports('moonshot')).toBe(true)
    expect(service.supports('siliconflow')).toBe(true)
    expect(service.supports(undefined)).toBe(false)
    expect(service.supports('invent-a-balance')).toBe(false)
  })
})
