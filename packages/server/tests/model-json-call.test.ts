import { describe, expect, it } from 'vitest'

import type { ModelProfile } from '@dsh-cyber/contracts'

import { ModelJsonCall } from '../src/services/model-json-call.js'
import type { ModelCredentialService } from '../src/services/model-credential-service.js'

const PROFILE: ModelProfile = {
  id: 'profile-1',
  workspaceId: 'workspace-1',
  displayName: '默认模型',
  providerKind: 'openai-compatible-remote',
  baseUrl: 'https://models.example.com/v1',
  modelId: 'test-model',
  api: 'openai-completions',
  isDefault: true,
  settings: {},
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
}

const credentials = { resolve: () => 'super-secret-key' } as unknown as ModelCredentialService

/** Public DNS is not reachable from a test, and is not what is under test. */
const resolveHostname = { resolve: async () => ['93.184.216.34'] }

function callWith(handler: (url: URL, init: RequestInit) => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const call = new ModelJsonCall({
    credentials,
    resolveHostname,
    fetch: (async (url: URL | string, init: RequestInit) => {
      seen.push({ url: String(url), init })
      return handler(new URL(String(url)), init)
    }) as unknown as typeof fetch,
  })
  return { call, seen }
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ModelJsonCall', () => {
  it('returns the model text', async () => {
    const { call } = callWith(() => completion('{"ok":true}'))
    expect(await call.text(PROFILE, { system: 's', user: 'u' })).toBe('{"ok":true}')
  })

  it('refuses to follow a redirect rather than carrying the credential off-origin', async () => {
    const { call, seen } = callWith(() => new Response(null, {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
    }))

    // The base URL passed the SSRF policy; the redirect target never would.
    // fetch follows redirects by default and re-sends Authorization and
    // x-api-key with them, which turns a hostile or compromised model
    // endpoint into a credential exfiltration channel and a way into the
    // loopback and link-local ranges the policy exists to block.
    await expect(call.text(PROFILE, { system: 's', user: 'u' })).rejects.toMatchObject({
      code: 'model_call_redirected',
    })
    expect(seen[0]!.init.redirect).toBe('manual')
    expect(seen).toHaveLength(1)
  })

  it('sends the credential to the configured host only', async () => {
    const { call, seen } = callWith(() => completion('{}'))
    await call.text(PROFILE, { system: 's', user: 'u' })

    const headers = seen[0]!.init.headers as Record<string, string>
    expect(seen[0]!.url).toBe('https://models.example.com/v1/chat/completions')
    expect(headers.Authorization).toBe('Bearer super-secret-key')
  })

  it('rejects a base URL that resolves into a private range', async () => {
    const call = new ModelJsonCall({
      credentials,
      resolveHostname: { resolve: async () => ['127.0.0.1'] },
      fetch: (async () => completion('{}')) as unknown as typeof fetch,
    })
    await expect(call.text(PROFILE, { system: 's', user: 'u' })).rejects.toThrow()
  })

  it('stops reading a response that never ends', async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)) },
    })
    const { call } = callWith(() => new Response(endless, { status: 200 }))

    await expect(call.text(PROFILE, { system: 's', user: 'u' })).rejects.toMatchObject({
      code: 'model_call_response_too_large',
    })
  })

  it('reports an upstream error rather than treating it as an answer', async () => {
    const { call } = callWith(() => new Response('nope', { status: 500 }))
    await expect(call.text(PROFILE, { system: 's', user: 'u' })).rejects.toMatchObject({
      code: 'model_call_upstream_error',
      httpStatus: 500,
    })
  })
})
