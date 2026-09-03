import { describe, expect, it } from 'vitest'

import { summarizeToolCall } from '../src/tool-summary.js'

describe('summarizeToolCall', () => {
  it('summarizes a command by its program and first argument', () => {
    const summary = summarizeToolCall('{"command":"git status --short"}')
    expect(summary?.summary).toBe('git status')
  })

  it('keeps only the leading command of a chain and flags truncation', () => {
    const summary = summarizeToolCall('{"command":"npm install && npm test"}')
    expect(summary?.summary).toBe('npm install')
    expect(summary?.detail).toContain('…')
  })

  it('folds user home prefixes out of file paths', () => {
    const windows = summarizeToolCall('{"file_path":"C:\\\\Users\\\\alice\\\\proj\\\\src\\\\main.ts"}')
    expect(windows?.summary).toBe('~/proj/src/main.ts')
    const posix = summarizeToolCall('{"path":"/home/bob/notes/todo.md"}')
    expect(posix?.summary).toBe('~/notes/todo.md')
  })

  it('shows search patterns', () => {
    const summary = summarizeToolCall('{"pattern":"function parseJson","glob":"**/*.ts","path":"src"}')
    expect(summary?.summary).toContain('function parseJson')
    expect(summary?.summary).toContain('src')
  })

  it('strips the query string of urls', () => {
    const summary = summarizeToolCall('{"url":"https://example.com/docs?session=abc123"}')
    expect(summary?.summary).toBe('https://example.com/docs')
  })

  it('masks high-entropy first arguments on command lines', () => {
    const summary = summarizeToolCall('{"command":"auth hx9Kq2Lm4Pq7Rt0WvYzBe3Nn5Ma8Cs1Df"}')
    expect(summary?.summary).toBe('auth [已隐藏]')
    expect(JSON.stringify(summary)).not.toContain('hx9Kq2Lm')
  })

  it('never surfaces tokens that live in the dropped tail of a command', () => {
    // firstCommandLine keeps program+first argument; the token sits in a later
    // argument, so it is gone — and the redaction layers guard the rest.
    const summary = summarizeToolCall('{"command":"curl -H \\"Authorization: Bearer abc.def.ghi\\" https://api.internal/v1"}')
    expect(summary?.summary).toBe('curl')
    expect(JSON.stringify(summary)).not.toContain('abc.def.ghi')
  })

  it('never renders values of keys outside the allow-list', () => {
    expect(summarizeToolCall('{"apiKey":"sk-live-abcdef0123456789"}')).toBeUndefined()
    expect(summarizeToolCall('{"body":"full prompt text"}')).toBeUndefined()
    expect(summarizeToolCall('{"content":"-----BEGIN PRIVATE KEY-----"}')).toBeUndefined()
  })

  it('rejects non-object and malformed argument payloads', () => {
    expect(summarizeToolCall(undefined)).toBeUndefined()
    expect(summarizeToolCall('not json at all')).toBeUndefined()
    expect(summarizeToolCall('["array"]')).toBeUndefined()
    expect(summarizeToolCall({})).toBeUndefined()
  })

  it('caps length so a giant argument cannot bloat the trace', () => {
    const huge = '{"pattern":"' + 'x'.repeat(5_000) + '"}'
    const summary = summarizeToolCall(huge)
    expect(summary).toBeDefined()
    expect((summary?.detail.length ?? 0)).toBeLessThanOrEqual(480 + 60)
  })
})
