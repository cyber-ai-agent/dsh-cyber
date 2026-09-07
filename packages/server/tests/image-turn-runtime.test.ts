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

function makeAssignedRequest(events: AgentRuntimeEvent[]): AgentTurnRequest {
  const request = makeRequest(events)
  delete (request as { modelProfileId?: string }).modelProfileId
  return request
}

function deps(overrides: Record<string, unknown> = {}) {
  const events: AgentRuntimeEvent[] = []
  const inner = { runTurn: vi.fn(async () => ({ agentSessionId: 'inner', finalResponse: 'chat', eventCount: 1 })), close: vi.fn(async () => {}) }
  const d = {
    inner,
    store: { getModelProfile: vi.fn((id: string) => (id === IMAGE_PROFILE.id ? IMAGE_PROFILE : id === CHAT_PROFILE.id ? CHAT_PROFILE : undefined)), resolveModelProfile: vi.fn(() => IMAGE_PROFILE) },
    credentials: { resolve: vi.fn(() => 'sk-key') },
    images: { generate: vi.fn(async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]), mimeType: 'image/png' })) },
    worldFiles: { saveGeneratedImage: vi.fn(async () => ({ assetId: 'asset-1', name: 'x.png', mimeType: 'image/png', byteLength: 13, url: '/api/worlds/world-1/file?path=x.png' })) },
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
    expect(d.worldFiles.saveGeneratedImage).not.toHaveBeenCalled()
  })

  it('runs an image model as a picture: same event channel, a visible world file - and no runtime artifact of its own', async () => {
    const { d, events } = deps()
    const runtime = createImageAwareRuntime(d as never)
    const result = await runtime.runTurn(makeRequest(events))
    expect(events.map((event) => event.kind)).toEqual(['turn.started', 'assistant.message', 'turn.completed'])
    const message = events[1]!
    expect(message.content).toContain('图片已经生成')
    const metadata = message.metadata as { attachments: Array<Record<string, unknown>>; artifactRefs?: Array<Record<string, unknown>>; imageModel?: string; generatedImage?: boolean }
    expect(metadata.attachments[0]).toMatchObject({ assetId: 'asset-1', url: '/api/worlds/world-1/file?path=x.png', mimeType: 'image/png' })
    expect(metadata.generatedImage).toBe(true)
    expect(metadata.imageModel).toBe('wan2.7-image')
    expect(result.finalResponse).toBe(message.content)
    expect(d.interactions.recordTurn).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', modelId: 'wan2.7-image', agentRunId: 'run-1' }))
    // One generation must produce exactly one durable artifact, and it is the
    // run-completion worker - not this runtime - who registers the world file
    // it just wrote. The runtime publishes nothing: no artifactRefs on the
    // message, no extra bytes in a cache copy, so the worker's later
    // publication cannot double with a manual one.
    expect(metadata.artifactRefs).toBeUndefined()
    const saveArgs = (d.worldFiles.saveGeneratedImage as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { bytes: Buffer; mimeType: string; name: string }
    expect(saveArgs.bytes.byteLength).toBeGreaterThan(0)
    // The file service appends the extension itself; a name that already
    // carries one would produce the visible 生成图片-...png-<id8>.png.
    expect(saveArgs.name).not.toMatch(/\.(png|jpe?g|webp)$/u)
    expect(saveArgs.name.startsWith('生成图片-')).toBe(true)
  })

  it('takes the image path when the model comes from the assignment chain alone', async () => {
    const { d, events } = deps()
    const runtime = createImageAwareRuntime(d as never)
    const result = await runtime.runTurn(makeAssignedRequest(events))
    expect(events.map((event) => event.kind)).toEqual(['turn.started', 'assistant.message', 'turn.completed'])
    expect(d.inner.runTurn).not.toHaveBeenCalled()
    expect(result.finalResponse).toContain('图片已经生成')
    expect(d.worldFiles.saveGeneratedImage).toHaveBeenCalledOnce()
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
