import { describe, expect, it } from 'vitest'

import type { ModelProfile } from '@dsh-cyber/contracts'
import type { ModelCredentialService } from '../src/services/model-credential-service.js'
import { ModelJsonCall } from '../src/services/model-json-call.js'

const profile: ModelProfile = {
  id: 'profile-prompt-only',
  workspaceId: 'workspace-1',
  displayName: '兼容模型',
  providerKind: 'openai-compatible-remote',
  baseUrl: 'https://models.example.com/v1',
  modelId: 'test-model',
  api: 'openai-completions',
  isDefault: true,
  settings: {},
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
}

const credentials = { resolve: () => 'test-key' } as unknown as ModelCredentialService
const resolveHostname = { resolve: async () => ['93.184.216.34'] }

function createCall(mode?: 'native' | 'prompt-only') {
  let requestBody = ''
  const call = new ModelJsonCall({
    credentials,
    resolveHostname,
    ...(mode === undefined ? {} : { jsonResponseMode: mode }),
    fetch: (async (_url, init) => {
      requestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })
  return { call, body: () => JSON.parse(requestBody) as Record<string, unknown> }
}

describe('ModelJsonCall prompt-only JSON mode', () => {
  it('keeps native JSON mode as the default', async () => {
    const fixture = createCall()
    await fixture.call.text(profile, { system: 'return json', user: '{}' })
    expect(fixture.body()).toMatchObject({ response_format: { type: 'json_object' } })
  })

  it('omits response_format for compatible gateways when requested', async () => {
    const fixture = createCall('prompt-only')
    await fixture.call.text(profile, { system: 'return json', user: '{}' })
    expect(fixture.body().response_format).toBeUndefined()
    expect(fixture.body().messages).toBeDefined()
  })
})
