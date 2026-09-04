import { describe, expect, it, vi } from 'vitest'

import { ModelCatalogService, type DiscoveredModel } from '../src/services/model-catalog-service.js'

function service(fetchImpl: typeof fetch) {
  return new ModelCatalogService({ resolve: () => undefined } as never, { fetch: fetchImpl, resolvePublicHosts: false })
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function discover(svc: ReturnType<typeof service>, input: Parameters<typeof svc['discover']>[0]): Promise<DiscoveredModel[]> {
  return await svc.discover(input)
}

describe('ModelCatalogService context window discovery', () => {
  it('reads context_length straight from a remote catalog without probing', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/models')
      return json({ data: [{ id: 'glm-4', context_length: 200_000 }, { id: 'tiny', max_context_length: 8192 }] })
    })
    const models = await discover(service(fetchMock as never), { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', providerKind: 'openai-compatible-remote' })
    expect(models).toEqual([
      { id: 'glm-4', contextLength: 200_000 },
      { id: 'tiny', contextLength: 8192 },
    ])
    // Remote endpoints are catalog-only: one request, no metadata probes.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads max_model_len from vLLM-compatible catalogs (omlx shape)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ object: 'list', data: [{ id: 'Qwen3.5-9B-MLX-4bit', object: 'model', owned_by: 'omlx', max_model_len: 32_768 }] }))
    const models = await discover(service(fetchMock as never), { baseUrl: 'http://172.16.1.125:8000/v1', api: 'openai-completions', providerKind: 'openai-compatible-local' })
    expect(models).toEqual([{ id: 'Qwen3.5-9B-MLX-4bit', contextLength: 32_768 }])
    // The catalog already answered: no follow-up probes fire.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads declared input modalities and reasoning capability without guessing', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ data: [
      { id: 'or-model', architecture: { input_modalities: ['text', 'image', 'unknown'], output_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning'], context_length: 200_000 },
      { id: 'plain-model', display_name: '显示名', modality: 'text+image->text' },
      { id: 'quiet-model' },
    ] }))
    const models = await discover(service(fetchMock as never), { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', providerKind: 'openai-compatible-remote' })
    expect(models.find((m) => m.id === 'or-model')).toMatchObject({ inputTypes: ['image', 'text'], outputTypes: ['image', 'text'], reasoning: true, contextLength: 200_000 })
    expect(models.find((m) => m.id === 'plain-model')).toMatchObject({ displayName: '显示名', inputTypes: ['image', 'text'], outputTypes: ['text'] })
    const quiet = models.find((m) => m.id === 'quiet-model')
    expect(quiet).toBeDefined()
    expect(quiet).not.toHaveProperty('inputTypes')
    expect(quiet).not.toHaveProperty('outputTypes')
    expect(quiet).not.toHaveProperty('reasoning')
  })

  it('probes llama.cpp /props for a local endpoint whose catalog omits context', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/v1/models')) return json({ data: [{ id: 'qwen' }] })
      if (String(url) === 'http://172.16.1.125:8000/props') return json({ general: { n_ctx: 0 }, default_generation_settings: { n_ctx: 4096 } })
      return new Response('nope', { status: 404 })
    })
    const models = await discover(service(fetchMock as never), { baseUrl: 'http://172.16.1.125:8000/v1', api: 'openai-completions', providerKind: 'openai-compatible-local' })
    expect(models).toEqual([{ id: 'qwen', contextLength: 4096 }])
  })

  it('falls back to LM Studio per-model catalog when llama.cpp props are absent', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = String(url)
      if (href.endsWith('/v1/models')) return json({ data: [{ id: 'a' }, { id: 'b' }] })
      if (href.endsWith('/props') || href.endsWith('/general/get_run_options')) return new Response('missing', { status: 404 })
      if (href.endsWith('/api/v0/models')) return json({ data: [{ id: 'a', loaded_config: { max_context_length: 32_768 } }, { id: 'b', meta: { context_length: 8_192 } }] })
      return new Response('missing', { status: 404 })
    })
    const models = await discover(service(fetchMock as never), { baseUrl: 'http://127.0.0.1:1234/v1', api: 'openai-completions', providerKind: 'openai-compatible-local' })
    expect(models.find((m) => m.id === 'a')?.contextLength).toBe(32_768)
    expect(models.find((m) => m.id === 'b')?.contextLength).toBe(8_192)
  })

  it('never overwrites a context the catalog already reported', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/v1/models')) return json({ data: [{ id: 'qwen', context_length: 16_384 }] })
      return json({ default_generation_settings: { n_ctx: 2048 } })
    })
    const models = await discover(service(fetchMock as never), { baseUrl: 'http://localhost:8080/v1', api: 'openai-completions', providerKind: 'openai-compatible-local' })
    expect(models).toEqual([{ id: 'qwen', contextLength: 16_384 }])
  })

  it('leaves context undefined when every local probe fails, without throwing', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/v1/models')) return json({ data: [{ id: 'qwen' }] })
      throw new Error('socket hang up')
    })
    const models = await discover(service(fetchMock as never), { baseUrl: 'http://192.168.0.9:8000/v1', api: 'openai-completions', providerKind: 'openai-compatible-local' })
    expect(models).toEqual([{ id: 'qwen' }])
  })

  it('ignores absurd sub-1024 probe numbers as they are useless as a window', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/v1/models')) return json({ data: [{ id: 'm' }] })
      return json({ default_generation_settings: { n_ctx: 512 } })
    })
    const models = await discover(service(fetchMock as never), { baseUrl: 'http://127.0.0.1:8000/v1', api: 'openai-completions', providerKind: 'openai-compatible-local' })
    expect(models[0]?.contextLength).toBeUndefined()
  })
})
