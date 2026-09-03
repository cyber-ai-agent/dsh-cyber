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
    expect(summary?.summary).toBe('auth [参数已隐藏]')
    expect(JSON.stringify(summary)).not.toContain('hx9Kq2Lm')
  })

  it('hides short positional arguments that are neither subcommands nor paths', () => {
    const summary = summarizeToolCall('{"command":"auth abc123shortsecret"}')
    expect(summary?.summary).toBe('auth [参数已隐藏]')
    expect(JSON.stringify(summary)).not.toContain('abc123shortsecret')
  })

  it('keeps real subcommands and path-shaped arguments', () => {
    expect(summarizeToolCall('{"command":"git commit -m msg"}')?.summary).toBe('git commit')
    expect(summarizeToolCall('{"command":"python scripts/build.py"}')?.summary).toBe('python scripts/build.py')
    expect(summarizeToolCall('{"command":"docker compose up"}')?.summary).toBe('docker compose')
  })

  it('masks webhook-shaped URL segments while keeping the safe skeleton', () => {
    const summary = summarizeToolCall('{"url":"https://hooks.slack.com/services/T02ABCDx/B03EFGH1y/XXXXXXXXXXXXXXXXXXXXxy9"}')
    expect(summary?.summary).toBe('https://hooks.slack.com/services/[已隐藏]/[已隐藏]/[已隐藏]')
    expect(JSON.stringify(summary)).not.toContain('XXXXXXXXXXXXXXXXXXXXxy9')
    const docs = summarizeToolCall('{"url":"https://code.example.com/guide/intro"}')
    expect(docs?.summary).toBe('https://code.example.com/guide/intro')
  })

  it('masks credential-shaped file path segments', () => {
    const summary = summarizeToolCall('{"file_path":"C:\\\\Users\\\\bob\\\\.config\\\\gh_hosts_token.yml"}')
    expect(summary?.summary).toContain('[已隐藏]')
    expect(JSON.stringify(summary)).not.toContain('gh_hosts_token')
    const safe = summarizeToolCall('{"file_path":"/home/bob/notes/meeting.md"}')
    expect(safe?.summary).toBe('~/notes/meeting.md')
  })

  it('applies the detail cap rather than the summary cap to the detail line', () => {
    const longPath = 'notes/' + 'folder/'.repeat(30) + 'todo.md'
    const summary = summarizeToolCall(JSON.stringify({ path: longPath }))
    expect((summary?.detail.length ?? 0)).toBeGreaterThan(120)
    expect((summary?.detail.length ?? 0)).toBeLessThanOrEqual(480)
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
