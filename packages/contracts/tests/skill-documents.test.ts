import { describe, expect, it } from 'vitest'
import { parseSkillDocumentDescriptors, parseSkillDocumentPath, parseSkillDocumentReadRequest, parseSkillDocumentReadResult } from '../src/skill-documents.js'

describe('skill document boundary', () => {
  it('projects descriptor-only discovery and normalizes bounded read requests', () => {
    expect(parseSkillDocumentDescriptors([{ id: 'a', displayName: '技能', summary: '摘要', revision: 'v1', body: 'PRIVATE', filePath: '/private' }]))
      .toEqual([{ id: 'a', displayName: '技能', summary: '摘要', revision: 'v1' }])
    expect(parseSkillDocumentReadRequest({ skillId: 'a' })).toEqual({ skillId: 'a', path: 'SKILL.md', offset: 0, limit: 6000, resourceOffset: 0 })
    for (const value of [{ limit: 12001 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { worldId: 'other' }]) {
      expect(() => parseSkillDocumentReadRequest({ skillId: 'a', ...value })).toThrow()
    }
  })
  it('rejects traversal and absolute paths on both platforms', () => {
    for (const path of ['/etc/passwd', '../SKILL.md', 'a/../b', 'C:/secret', 'a\\b', '//host/file', 'a/%2e%2e/b', 'a\u0000b', 'a//b', './SKILL.md']) {
      expect(() => parseSkillDocumentPath(path)).toThrow()
    }
    expect(parseSkillDocumentPath('source/references/说明.md')).toBe('source/references/说明.md')
  })
  it('validates page identity, size, revisions and forward progress without leaking extra fields', () => {
    const request = parseSkillDocumentReadRequest({ skillId: 'a', limit: 3 })
    const result = { skillId: 'a', revision: 'v1', path: 'SKILL.md', content: 'abc', totalChars: 4, nextOffset: 3, resources: ['reference.md'], absolutePath: '/private' }
    expect(parseSkillDocumentReadResult(result, request, 'v1')).not.toHaveProperty('absolutePath')
    for (const patch of [{ skillId: 'b' }, { revision: 'v2' }, { path: 'other.md' }, { content: 'long' }, { nextOffset: 2 }, { resources: ['../secret'] }]) {
      expect(() => parseSkillDocumentReadResult({ ...result, ...patch }, request, 'v1')).toThrow()
    }
    expect(() => parseSkillDocumentReadResult({ ...result, content: '', nextOffset: 0 }, request, 'v1')).toThrow()
  })
})
