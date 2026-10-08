import type { HarnessModelRoute } from '@dsh-cyber/harness-adapter'
import type { ModelProfile } from '@dsh-cyber/contracts'
import { expect, it, vi } from 'vitest'
import { RuntimeUpdateService } from '../src/services/runtime-update-service.js'

const canary = vi.hoisted(() => vi.fn(async (_options: { route: HarnessModelRoute }) => ({ ok: true })))
vi.mock('@dsh-cyber/harness-adapter', async (importOriginal) => ({
  ...await importOriginal<typeof import('@dsh-cyber/harness-adapter')>(),
  runHarnessCandidateCanary: canary,
}))

it('uses the host-resolved credential route for runtime canaries as well as chat', async () => {
  const profile = { id: 'model', providerKind: 'openai-compatible-local', credentialEnvName: undefined } as ModelProfile
  const route: HarnessModelRoute = { id: 'model', displayName: '本地服务', baseURL: 'http://localhost:9/v1', modelId: 'test', api: 'openai-completions', apiKeyEnv: 'PROVIDER_API_KEY' }
  const resolver = vi.fn(() => route)
  const store = {
    getRuntimeUpdateTransaction: () => ({ id: 'update', candidateRoot: '/tmp/candidate' }),
    getModelProfile: () => profile,
    transitionRuntimeUpdate: (value: unknown) => value,
  }
  const service = new RuntimeUpdateService(store as never, '/tmp/readiness-state', '/tmp/readiness-workspace', resolver)
  expect((await service.canary('update', 'model')).ok).toBe(true)
  expect(resolver).toHaveBeenCalledWith(profile)
  expect(canary).toHaveBeenCalledWith(expect.objectContaining({ route }))
  expect(canary.mock.calls[0]![0]).not.toMatchObject({ route: { requiresApiKey: false } })
})
