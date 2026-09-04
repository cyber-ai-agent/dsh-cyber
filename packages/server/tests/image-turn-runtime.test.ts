import type { AgentRuntimeEvent, AgentTurnRequest, ModelProfile } from '@dsh-cyber/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createImageAwareRuntime } from '../src/services/image-turn-runtime.js'

const IMAGE_PROFILE = {
  id: 'profile-img',
  workspaceId: 'ws-1',
  displayName: 'Wan Image',
  providerKind: 'openai-compatible-remote',
  baseUrl: 'https://gw.example.com/v1',
  modelId: 'wan2.7-image',
  api: 'openai-completions',
  isDefault: false,
  settings: { imageGeneration: true },
  createdAt: '',
  updatedAt: '',
} as unknown as ModelProfile

const CHAT_PROFILE = { ...IMAGE_PROFILE, id: 'profile-chat', settings: {} } as unknown as ModelProfile

function makeRequest(events: AgentRuntimeEvent[]): AgentTurnRequest {
  return {
    agent: { id: 'emp-1', workspaceId: 'ws-1', worldId: 'world-1', displayName: '管家' },
    revision: {},
    conversationId: 'session-1',
    history: [],
    observedThroughSequence: 0,
    prompt: '画一只猫',
    workTurnId: 'turn-1',
    agentRunId: 'run-1',
    modelProfileId: IMAGE_PROFILE.id,
    onEvent: (event) => { events.push(event) },
  } as unknown as AgentTurnRequest
}

function deps(overrides: Record<string, unknown> = {}) {
  const events: AgentRuntimeEvent[] = []
  const inner = { runTurn: vi.fn(async () => ({ agentSessionId: 'inner', finalResponse: 'chat', eventCount: 1 })), close: vi.fn(async () => {}) }
  const d = {
    inner,
    store: { getModelProfile: vi.fn((id: string) => (id === IMAGE_PROFILE.id ? IMAGE_PROFILE : id === CHAT_PROFILE.id ? CHAT_PROFILE : undefined)) },
    credentials: { resolve: vi.fn(() => 'sk-key') },
    images: { generate: vi.fn(async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]), mimeType: 'image/png' })) },
    worldFiles: { saveGeneratedImage: vi.fn(async () => ({ assetId: 'asset-1', name: 'x.png', mimeType: 'image/png', byteLength: 13, url: '/api/worlds/world-1/assets/asset-1' })) },
    worldArtifacts: { publishGeneratedImage: vi.fn(async () => ({ artifact: { id: 'art-1', title: '生成图片' }, version: {} })) },
    interactions: { recordTurn: vi.fn() },
    ...overrides,
  }
  return { d, events, inner }
}

describe('image-aware runtime', () => {
  it('delegates ordinary chat turns and unmarked profiles untouched', async () => {
    const { d, inner } = deps()
    const runtime = createImageAwareRuntime(d as never)
    const events: AgentRuntimeEvent[] = []
    const request = makeRequest(events)
    const result = await runtime.runTurn({ ...request, modelProfileId: CHAT_PROFILE.id })
    expect(result.finalResponse).toBe('chat')
    expect(inner.runTurn).toHaveBeenCalledOnce()
    expect((d.worldArtifacts.publishGeneratedImage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('runs an image model as a picture: same event channel, attachment and artifact', async () => {
    const { d, events } = deps()
    const runtime = createImageAwareRuntime(d as never)
    const result = await runtime.runTurn(makeRequest(events))
    expect(events.map((event) => event.kind)).toEqual(['turn.started', 'assistant.message', 'turn.completed'])
    const message = events[1]!
    expect(message.content).toContain('图片已经生成')
    const metadata = message.metadata as { attachments: Array<Record<string, unknown>>; artifactRefs: Array<Record<string, unknown>>; generatedImage?: boolean }
    expect(metadata.attachments[0]).toMatchObject({ assetId: 'asset-1', url: '/api/worlds/world-1/assets/asset-1', mimeType: 'image/png' })
    expect(metadata.artifactRefs[0]).toMatchObject({ artifactId: 'art-1', kind: 'image' })
    expect(metadata.generatedImage).toBe(true)
    expect(result.finalResponse).toBe(message.content)
    expect(d.interactions.recordTurn).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', modelId: 'wan2.7-image', agentRunId: 'run-1' }))
    // 产物幂等键绑定 agentRun：重放同一轮不会存出两张
    expect(d.worldArtifacts.publishGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'generated-image:run-1' }))
  })

  it('fails the turn through turn.failed and records the attempt when the endpoint errors', async () => {
    const { d, events } = deps({ images: { generate: vi.fn(async () => { throw new Error('图像服务限流（HTTP 429），稍后再试。') }) } })
    const runtime = createImageAwareRuntime(d as never)
    const result = await runtime.runTurn(makeRequest(events))
    expect(events.map((event) => event.kind)).toEqual(['turn.started', 'turn.failed'])
    expect(result.finalResponse).toBe('')
    expect(d.interactions.recordTurn).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })
})
