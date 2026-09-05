import { describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '@dsh-cyber/contracts'

import { ModelProfileKnowledgeExtractionPort } from '../src/services/model-profile-knowledge-extraction-port.js'

const profile: ModelProfile = {
  id: 'profile-1',
  workspaceId: 'workspace-1',
  displayName: '本地模型',
  providerKind: 'openai-compatible-local',
  baseUrl: 'http://127.0.0.1:11434/v1',
  modelId: 'model-1',
  api: 'openai-completions',
  isDefault: true,
  settings: {},
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
}

describe('ModelProfileKnowledgeExtractionPort', () => {
  it('uses the configured profile without creating a character runtime identity', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1:11434/v1/chat/completions')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer local-secret' })
      const body = JSON.parse(String(init?.body)) as { stream: boolean; response_format?: unknown; max_tokens?: number; messages: Array<{ content: string }> }
      expect(body.stream).toBe(false)
      // Prompt-only: gateways that ignore or reject response_format were the
      // direct cause of empty-content failures.
      expect(body.response_format).toBeUndefined()
      expect(body.max_tokens).toBe(8192)
      // The prompt must declare the type vocabularies, or models invent them.
      expect(body.messages[0]?.content).toContain('character, person')
      expect(body.messages[0]?.content).toContain('fact, decision')
      expect(body.messages[1]?.content).toContain('evidence-1')
      return new Response(JSON.stringify({
        model: 'model-1',
        choices: [{ message: { content: '{"entities":[],"claims":[],"relations":[],"evidenceRefs":[]}' } }],
        usage: { prompt_tokens: 21, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const port = new ModelProfileKnowledgeExtractionPort({
      store: {
        getModelAssignment: () => undefined,
        getModelProfile: (id) => id === profile.id ? profile : undefined,
        resolveWorkspaceDefaultProfile: () => profile,
      },
      credentials: { resolve: () => 'local-secret' } as never,
      fetch: fetchMock,
    })
    const result = await port.extract({
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      sourceType: 'conversation',
      sourceId: 'session-1',
      modelProfileId: profile.id,
      inputChars: 4,
      visibleText: '事实',
      evidence: [{
        evidenceId: 'evidence-1',
        workspaceId: 'workspace-1',
        worldId: 'world-1',
        sourceType: 'conversation',
        sourceId: 'session-1',
        excerpt: '事实',
        sessionId: 'session-1',
        messageId: 'message-1',
        sequence: 1,
      }],
    })
    expect(result).toMatchObject({ usage: { model: 'model-1', inputTokens: 21, outputTokens: 8 } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts a BOM and one fenced JSON provider envelope', async () => {
    const port = new ModelProfileKnowledgeExtractionPort({
      store: {
        getModelAssignment: () => undefined,
        getModelProfile: () => profile,
        resolveWorkspaceDefaultProfile: () => profile,
      },
      credentials: { resolve: () => 'local-secret' } as never,
      fetch: vi.fn(async () => new Response(`\uFEFF\n\`\`\`json\n${JSON.stringify({ choices: [{ message: { content: '{"entities":[],"claims":[],"relations":[],"evidenceRefs":[]}' } }] })}\n\`\`\``)),
    })
    await expect(port.extract({
      workspaceId: 'workspace-1', worldId: 'world-1', sourceType: 'manual', sourceId: 'note-1',
      inputChars: 2, visibleText: '事实', evidence: [],
    })).resolves.toMatchObject({ payload: expect.stringContaining('"entities"') })
  })

  it('appends the corrective line only on a hinted retry', async () => {
    let system = ''
    const port = new ModelProfileKnowledgeExtractionPort({
      store: {
        getModelAssignment: () => undefined,
        getModelProfile: () => profile,
        resolveWorkspaceDefaultProfile: () => profile,
      },
      credentials: { resolve: () => 'local-secret' } as never,
      fetch: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
        system = body.messages[0]?.content ?? ''
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"entities":[],"claims":[],"relations":[],"evidenceRefs":[]}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    })
    await port.extract({ workspaceId: 'workspace-1', worldId: 'world-1', sourceType: 'conversation', sourceId: 'session-1', inputChars: 2, visibleText: '事实', evidence: [], attemptHint: true })
    expect(system).toContain('上一次回答未能解析')
  })

  it('does not use an explicit profile from another workspace', async () => {
    const port = new ModelProfileKnowledgeExtractionPort({
      store: {
        getModelAssignment: () => undefined,
        getModelProfile: () => ({ ...profile, workspaceId: 'another-workspace' }),
        resolveWorkspaceDefaultProfile: () => undefined,
      },
      credentials: { resolve: () => undefined } as never,
      fetch: vi.fn(),
    })
    await expect(port.extract({
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      sourceType: 'document',
      sourceId: 'document-1',
      modelProfileId: profile.id,
      inputChars: 4,
      visibleText: '事实',
      evidence: [],
    })).rejects.toMatchObject({ code: 'knowledge_model_unconfigured' })
  })
})
