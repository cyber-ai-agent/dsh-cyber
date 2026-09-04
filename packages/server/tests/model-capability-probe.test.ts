import { describe, expect, it, vi } from 'vitest'

import { ModelCapabilityProbeService } from '../src/services/model-capability-probe.js'

function chatResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function target(overrides: Partial<Parameters<ModelCapabilityProbeService['probe']>[1]> = {}) {
  return { baseUrl: 'https://models.test/v1', modelId: 'm1', api: 'openai-completions' as const, apiKey: 'k', ...overrides }
}

describe('ModelCapabilityProbeService', () => {
  it('records supported for a forced tool call and a parsed JSON object', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.tools !== undefined) {
        return chatResponse({ choices: [{ message: { tool_calls: [{ id: 't1', function: { name: 'echo_probe', arguments: '{}' } }] } }] })
      }
      return chatResponse({ choices: [{ message: { content: '{"ok":true}' } }] })
    })
    const service = new ModelCapabilityProbeService({ fetch: fetchMock })
    const outcome = await service.probe('profile-a', target())
    expect(outcome).toEqual({ status: 'probed', capabilities: { tools: 'supported', json: 'supported' } })
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('echo_probe')
    // Cost guard: both probes are bounded.
    for (const call of fetchMock.mock.calls) {
      expect(String((call[1] as RequestInit).body)).toContain('"max_tokens":16')
    }
  })

  it('records unsupported only on explicit parameter rejection', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.tools !== undefined) return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'tools'." } }), { status: 400 })
      return new Response(JSON.stringify({ error: { message: "response_format: unsupported type 'json_object'" } }), { status: 400 })
    })
    const service = new ModelCapabilityProbeService({ fetch: fetchMock })
    const outcome = await service.probe('profile-b', target())
    expect(outcome).toEqual({ status: 'probed', capabilities: { tools: 'unsupported', json: 'unsupported' } })
  })

  it('keeps an accepted-but-uncalled tool request honest as unclear', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.tools !== undefined) return chatResponse({ choices: [{ message: { content: '我不能调用工具。' } }] })
      return chatResponse({ choices: [{ message: { content: '这不是 JSON' } }] })
    })
    const service = new ModelCapabilityProbeService({ fetch: fetchMock })
    expect(await service.probe('profile-c', target())).toEqual({
      status: 'probed',
      capabilities: { tools: 'unclear', json: 'unclear' },
    })
  })

  it('reports error — not failure — when the transport dies', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => { throw new Error('socket reset') })
    const service = new ModelCapabilityProbeService({ fetch: fetchMock })
    expect(await service.probe('profile-d', target())).toEqual({
      status: 'probed',
      capabilities: { tools: 'error', json: 'error' },
    })
  })

  it('does not treat an unrelated 4xx as a capability verdict', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }))
    const service = new ModelCapabilityProbeService({ fetch: fetchMock })
    expect(await service.probe('profile-e', target())).toEqual({
      status: 'probed',
      capabilities: { tools: 'error', json: 'error' },
    })
  })

  it('cools down repeat probes for the same profile', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => chatResponse({ choices: [{ message: { content: '{"ok":true}', tool_calls: [{ id: 'x' }] } }] }))
    const service = new ModelCapabilityProbeService({ fetch: fetchMock, cooldownMs: 60_000 })
    expect((await service.probe('profile-f', target())).status).toBe('probed')
    const second = await service.probe('profile-f', target())
    expect(second.status).toBe('cooldown')
  })

  it('leaves non OpenAI-completions protocols unprobed rather than guessing', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => chatResponse({}))
    const service = new ModelCapabilityProbeService({ fetch: fetchMock })
    expect(await service.probe('profile-g', target({ api: 'anthropic-messages' }))).toEqual({ status: 'unsupported-protocol' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
