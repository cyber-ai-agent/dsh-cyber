import type { ModelProviderConnection } from '@dsh-cyber/contracts'

import { ServiceError } from './service-error.js'

const BALANCE_PATHS: Record<string, { path: string; parse: (body: Record<string, unknown>) => string[] }> = {
  // DeepSeek reports a currency-denominated wallet; keep only the amounts.
  deepseek: {
    path: '/user/balance',
    parse: (body) => {
      const infos = Array.isArray(body.balance_infos) ? body.balance_infos : []
      const lines: string[] = []
      for (const item of infos) {
        if (item === null || typeof item !== 'object') continue
        const value = item as Record<string, unknown>
        if (typeof value.total_balance !== 'string' || typeof value.currency !== 'string') continue
        lines.push(`总余额 ${value.total_balance} ${value.currency}`)
        if (typeof value.granted_balance === 'string') lines.push(`其中赠送额度 ${value.granted_balance} ${value.currency}`)
      }
      if (lines.length === 0 && body.is_available === false) lines.push('服务商返回余额不可用')
      return lines
    },
  },
  // OpenRouter keys report usage against an optional hard limit.
  openrouter: {
    path: '/api/v1/key',
    parse: (body) => {
      const data = body.data
      if (data === null || typeof data !== 'object') return []
      const key = data as Record<string, unknown>
      const lines: string[] = []
      if (typeof key.usage === 'number') lines.push(`已使用 $${key.usage.toFixed(4)}`)
      if (typeof key.limit === 'number') {
        lines.push(`额度上限 $${key.limit.toFixed(2)}`)
        if (typeof key.limit_remaining === 'number') lines.push(`剩余 $${key.limit_remaining.toFixed(4)}`)
      } else if (key.limit === null) {
        lines.push('额度上限：无')
      }
      if (key.is_free_tier === true) lines.push('免费层级')
      return lines
    },
  },
  // Kimi (Moonshot): GET /v1/users/me/balance → data.{available,voucher,cash}_balance (CNY).
  moonshot: {
    path: '/v1/users/me/balance',
    parse: (body) => {
      const data = body.data
      if (data === null || typeof data !== 'object') return []
      const balance = data as Record<string, unknown>
      if (typeof balance.available_balance !== 'number') return []
      const lines: string[] = [`可用余额 ${balance.available_balance.toFixed(2)} 元`]
      if (typeof balance.voucher_balance === 'number' && balance.voucher_balance > 0) lines.push(`代金券 ${balance.voucher_balance.toFixed(2)} 元`)
      if (typeof balance.cash_balance === 'number' && balance.cash_balance < 0) lines.push(`现金已欠费 ${(-balance.cash_balance).toFixed(2)} 元`)
      return lines
    },
  },
  // SiliconFlow: GET /v1/user/info → data.{totalBalance,balance} (CNY).
  siliconflow: {
    path: '/v1/user/info',
    parse: (body) => {
      const data = body.data
      if (data === null || typeof data !== 'object') return []
      const account = data as Record<string, unknown>
      const total = typeof account.totalBalance === 'number' ? account.totalBalance : undefined
      const cash = typeof account.balance === 'number' ? account.balance : undefined
      if (total === undefined && cash === undefined) return []
      const lines: string[] = []
      if (total !== undefined) lines.push(`总余额 ${total.toFixed(2)} 元`)
      if (cash !== undefined && total !== undefined && cash !== total) lines.push(`其中现金 ${cash.toFixed(2)} 元`)
      return lines
    },
  },
}

export interface ModelProviderBalanceResult {
  lines: string[]
  asOf: string
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Reads a provider's account balance. Only catalog-declared kinds have a
 * parser; the response is reduced to whitelisted numeric/label fields here,
 * and the result is never persisted — balances are account metadata, not
 * world facts, and they go stale by the second.
 */
export class ModelProviderBalanceService {
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  supports(kind: string | undefined): boolean {
    return kind !== undefined && BALANCE_PATHS[kind] !== undefined
  }

  async fetchBalance(provider: ModelProviderConnection, balanceKind: string, apiKey: string | undefined): Promise<ModelProviderBalanceResult> {
    const parser = BALANCE_PATHS[balanceKind]
    if (parser === undefined) throw new ServiceError('invalid', 'balance_unsupported', '该服务商暂不支持余额查询。')
    if (apiKey === undefined || apiKey.trim() === '') throw new ServiceError('invalid', 'balance_no_credential', '尚未配置 API 密钥，无法查询余额。')
    let endpoint: URL
    try {
      endpoint = new URL(provider.baseUrl)
    } catch {
      throw new ServiceError('invalid', 'balance_base_url_invalid', '服务商地址不正确。')
    }
    endpoint = new URL(`${endpoint.protocol}//${endpoint.host}${parser.path}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
        signal: controller.signal,
        redirect: 'error',
      })
    } catch {
      throw new ServiceError('unavailable', 'balance_unreachable', '余额查询失败：无法连接服务商。')
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401 || response.status === 403) {
      throw new ServiceError('forbidden', 'balance_credential_rejected', '余额查询被拒绝：API 密钥无效或没有该权限。')
    }
    if (!response.ok) throw new ServiceError('unavailable', 'balance_upstream_error', `余额查询失败（状态码 ${response.status}）。`)
    let body: Record<string, unknown> | undefined
    try {
      const value: unknown = await response.json()
      body = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    } catch {
      body = undefined
    }
    if (body === undefined) throw new ServiceError('invalid', 'balance_invalid_response', '余额查询返回了无法识别的内容。')
    const lines = parser.parse(body)
    if (lines.length === 0) throw new ServiceError('invalid', 'balance_invalid_response', '余额查询返回了无法识别的内容。')
    return { lines, asOf: new Date().toISOString() }
  }
}
