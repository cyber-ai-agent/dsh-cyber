import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, api } from '../src/api.js'
import { setUiLocale } from '../src/i18n/runtime.js'

beforeEach(() => setUiLocale('zh-CN'))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web API errors', () => {
  it('preserves the server error code for model recovery UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'model_turn_timeout',
        message: '模型服务响应超时。',
      },
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })))

    let error: unknown
    try {
      await api('/api/worlds/world-1/chat')
    } catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 502,
      code: 'model_turn_timeout',
      message: '模型服务响应超时。',
    })
  })

  it('carries the server code, message key and structured detail in every locale', async () => {
    const payload = JSON.stringify({
      error: {
        code: 'work_session_has_active_runs',
        messageKey: 'error.work_session_has_active_runs',
        message: '还有 3 个工作回合和 2 个代理运行未结束，无法关闭。',
        details: { workTurns: 3, agentRuns: 2 },
      },
    })

    for (const locale of ['en-US', 'ja-JP', 'ar-SA'] as const) {
      setUiLocale(locale)
      vi.stubGlobal('fetch', vi.fn(async () => new Response(payload, {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })))

      let error: unknown
      try {
        await api('/api/worlds/world-1/sessions/session-1', { method: 'DELETE' })
      } catch (cause) {
        error = cause
      }

      expect(error, locale).toBeInstanceOf(ApiError)
      expect(error, locale).toMatchObject({
        status: 409,
        code: 'work_session_has_active_runs',
        messageKey: 'error.work_session_has_active_runs',
        details: { workTurns: 3, agentRuns: 2 },
      })
      // The backend copy is Chinese, so it must not leak into other locales.
      expect((error as ApiError).message, locale).not.toContain('工作回合')
    }
  })
})
