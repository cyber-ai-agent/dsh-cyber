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
})
