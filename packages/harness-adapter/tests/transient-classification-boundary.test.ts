import { describe, expect, it } from 'vitest'

import { isTransientRuntimeFailure } from '../src/index.js'

describe('transient model failure boundaries', () => {
  it('retries broken channels but not normal 4xx requests', () => {
    expect(isTransientRuntimeFailure({
      errorCode: 'rpc_channel_closed',
      error: 'channel closed unexpectedly',
    })).toBe(true)
    expect(isTransientRuntimeFailure({
      httpStatus: 400,
      errorCode: 'invalid_request',
    })).toBe(false)
  })
})
