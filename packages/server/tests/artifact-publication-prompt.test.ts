import { describe, expect, it } from 'vitest'

import { composeArtifactPublicationPrompt } from '../src/services/character-profile-runtime.js'

describe('AgentRun artifact publication prompt', () => {
  it('injects the exact run-scoped manifest path only for writable turns', () => {
    const prompt = composeArtifactPublicationPrompt('生成一份周报', 'run-123', 'workspace-write')
    expect(prompt).toContain('.dsh/artifacts/run-123.json')
    expect(prompt).toContain('不要调用 HTTP 产物接口')
    expect(prompt).toContain('"schemaVersion":1')
    expect(composeArtifactPublicationPrompt('只回答问题', 'run-123', 'read-only')).toBe('只回答问题')
    expect(composeArtifactPublicationPrompt('生成一份周报', undefined, 'workspace-write')).toBe('生成一份周报')
  })
})
