import { describe, expect, it } from 'vitest'

describe('web React test environment', () => {
  it('declares act support before web tests execute', () => {
    expect((globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT).toBe(true)
  })
})
