import { describe, expect, it } from 'vitest'

import { normalizeHarnessNotification } from '../src/index.js'

describe('Harness failure diagnostics', () => {
  it('preserves actionable turn failure facts while redacting credentials', () => {
    const [event] = normalizeHarnessNotification({
      method: 'session.event',
      params: {
        sessionId: 'employee-1',
        event: {
          type: 'turn/end',
          seq: 9,
          data: {
            reason: {
              kind: 'failed',
              error: {
                code: 'invalid_api_key',
                type: 'authentication_error',
                status: 401,
                message: 'Authorization failed: Bearer secret-token-123456789',
              },
            },
          },
        },
      },
    })

    expect(event).toMatchObject({
      kind: 'turn.failed',
      failed: true,
      metadata: {
        reason: 'failed',
        errorCode: 'invalid_api_key',
        errorType: 'authentication_error',
        httpStatus: 401,
      },
    })
    expect(String(event?.metadata.error)).toContain('[已隐藏]')
    expect(JSON.stringify(event)).not.toContain('secret-token-123456789')
  })

  it('walks nested provider causes and creates a stable fallback code for 5xx responses', () => {
    const [event] = normalizeHarnessNotification({
      method: 'session.event',
      params: {
        sessionId: 'employee-2',
        event: {
          type: 'turn/end',
          seq: 4,
          data: {
            reason: {
              kind: 'failed',
              error: {
                cause: {
                  statusCode: '503',
                  message: 'upstream provider temporarily unavailable',
                },
              },
            },
          },
        },
      },
    })

    expect(event).toMatchObject({
      kind: 'turn.failed',
      metadata: {
        errorCode: 'upstream_unreachable',
        httpStatus: 503,
        error: 'upstream provider temporarily unavailable',
      },
    })
  })

  it('keeps tool failures diagnostic without persisting tool arguments or secrets', () => {
    const [event] = normalizeHarnessNotification({
      method: 'session.event',
      params: {
        sessionId: 'employee-3',
        event: {
          type: 'tool/result',
          seq: 8,
          data: {
            message: { source: { callId: 'call-8' } },
            error: {
              code: 'tool_transport_error',
              message: 'api_key=top-secret-value-12345678',
              status: 502,
            },
          },
        },
      },
    })

    expect(event).toMatchObject({
      kind: 'tool.completed',
      callId: 'call-8',
      failed: true,
      metadata: {
        failed: true,
        errorCode: 'tool_transport_error',
        httpStatus: 502,
      },
    })
    expect(JSON.stringify(event)).not.toContain('top-secret-value-12345678')
  })
})
