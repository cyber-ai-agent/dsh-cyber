import { describe, expect, it } from 'vitest'

import { summarizeToolCall } from '../src/tool-summary.js'

describe('summarizeToolCall', () => {
  it('shows the direct command without masking', () => {
    const summary = summarizeToolCall('{"command":"git status --short"}')
    expect(summary?.summary).toBe('git status --short')
    expect(summary?.detail).toBe('{"command":"git status --short"}')
  })

  it('keeps the full raw command chain in detail', () => {
    const summary = summarizeToolCall('{"command":"npm install && npm test"}')
    expect(summary?.summary).toBe('npm install && npm test')
    expect(summary?.detail).toBe('{"command":"npm install && npm test"}')
  })

  it('keeps file paths raw, without home folding', () => {
    const windows = summarizeToolCall('{"file_path":"C:\\\\Users\\\\alice\\\\proj\\\\src\\\\main.ts"}')
    expect(windows?.summary).toBe('{"file_path":"C:\\\\Users\\\\alice\\\\proj\\\\src\\\\main.ts"}')
    const posix = summarizeToolCall('{"path":"/home/bob/notes/todo.md"}')
    expect(posix?.detail).toBe('{"path":"/home/bob/notes/todo.md"}')
  })

  it('shows search patterns and their keys verbatim', () => {
    const summary = summarizeToolCall('{"pattern":"function parseJson","glob":"**/*.ts","path":"src"}')
    expect(summary?.detail).toBe('{"pattern":"function parseJson","glob":"**/*.ts","path":"src"}')
  })

  it('keeps url query strings raw', () => {
    const summary = summarizeToolCall('{"url":"https://example.com/docs?session=abc123"}')
    expect(summary?.detail).toContain('session=abc123')
  })

  it('surfaces first arguments that look like secrets, verbatim', () => {
    const summary = summarizeToolCall('{"command":"auth hx9Kq2Lm4Pq7Rt0WvYzBe3Nn5Ma8Cs1Df"}')
    expect(summary?.summary).toBe('auth hx9Kq2Lm4Pq7Rt0WvYzBe3Nn5Ma8Cs1Df')
    expect(JSON.stringify(summary)).toContain('hx9Kq2Lm4Pq7Rt0WvYzBe3Nn5Ma8Cs1Df')
  })

  it('never renders values of keys outside the allow-list', () => {
    const summary = summarizeToolCall('{"apiKey":"sk-live-abcdef0123456789"}')
    expect(summary?.detail).toBe('{"apiKey":"sk-live-abcdef0123456789"}')
    const body = summarizeToolCall('{"body":"full prompt text"}')
    expect(body?.detail).toBe('{"body":"full prompt text"}')
  })

  it('accepts structured argument objects directly', () => {
    const summary = summarizeToolCall({ command: 'docker compose up' })
    expect(summary?.summary).toBe('docker compose up')
    expect(summary?.detail).toBe(JSON.stringify({ command: 'docker compose up' }, null, 2))
  })

  it('shows plain text and array payloads as-is', () => {
    expect(summarizeToolCall('not json at all')?.detail).toBe('not json at all')
    expect(summarizeToolCall('["array"]')?.detail).toBe('["array"]')
  })

  it('returns undefined only for no arguments or blank payloads', () => {
    expect(summarizeToolCall(undefined)).toBeUndefined()
    expect(summarizeToolCall('   ')).toBeUndefined()
    expect(summarizeToolCall(null)?.detail).toBe('null')
  })

  it('caps length so a giant argument cannot bloat the trace', () => {
    const huge = '{"pattern":"' + 'x'.repeat(5_000) + '"}'
    const summary = summarizeToolCall(huge)
    expect(summary).toBeDefined()
    expect((summary?.detail.length ?? 0)).toBeLessThanOrEqual(32_000)
    expect((summary?.summary.length ?? 0)).toBeLessThanOrEqual(120)
  })
})
