import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelCatalogService } from '../src/services/model-catalog-service.js'
import { ModelCredentialService } from '../src/services/model-credential-service.js'
import { ServiceError } from '../src/services/service-error.js'

const roots: string[] = []
const services: ModelCredentialService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('ModelCredentialService', () => {
  it('encrypts API keys, restores them after restart, and removes them on delete', async () => {
    const root = await temporaryRoot()
    const secret = 'sk-test-only-not-a-real-key-1234567890'
    const first = await ModelCredentialService.open(root)
    services.push(first)
    const envName = await first.set('profile-1', secret)
    expect(envName).toMatch(/^DSH_CYBER_MODEL_KEY_[A-F0-9]{24}$/)
    expect(first.resolve('profile-1')).toBe(secret)
    expect(await readFile(join(root, 'credentials', 'model-credentials.json'), 'utf8')).not.toContain(secret)
    expect((await readFile(join(root, 'credentials', 'model-credentials.key'))).toString('utf8')).not.toContain(secret)
    first.close()
    services.splice(services.indexOf(first), 1)
    expect(process.env[envName]).toBeUndefined()
    const reopened = await ModelCredentialService.open(root)
    services.push(reopened)
    expect(reopened.resolve('profile-1')).toBe(secret)
    await reopened.delete('profile-1')
    expect(reopened.resolve('profile-1')).toBeUndefined()
    expect(process.env[envName]).toBeUndefined()
  })
})

describe('ModelCatalogService', () => {
  const publicResolver = { resolve: async () => ['93.184.216.34'] }

  it('uses a stored API key without exposing it and parses OpenAI-compatible models', async () => {
    const root = await temporaryRoot()
    const credentials = await ModelCredentialService.open(root)
    services.push(credentials)
    await credentials.set('profile-1', 'sk-test-catalog-secret')
    let requestUrl = ''
    let authorized = false
    const catalog = new ModelCatalogService(credentials, {
      fetch: (async (input, init) => {
        requestUrl = String(input)
        authorized = new Headers(init?.headers).get('authorization') === 'Bearer sk-test-catalog-secret'
        return new Response(JSON.stringify({ data: [
          { id: 'z-model' },
          { id: 'a-model', display_name: '模型 A' },
          { id: 'a-model' },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      resolveHostname: publicResolver,
    })
    const models = await catalog.discover({ baseUrl: 'https://models.example.test/v1/', providerKind: 'openai-compatible-remote', api: 'openai-completions', profileId: 'profile-1' })
    expect(requestUrl).toBe('https://models.example.test/v1/models')
    expect(authorized).toBe(true)
    expect(models).toEqual([{ id: 'a-model', displayName: '模型 A' }, { id: 'z-model' }])
  })

  it('maps upstream authentication errors to a Chinese actionable message', async () => {
    const root = await temporaryRoot()
    const credentials = await ModelCredentialService.open(root)
    services.push(credentials)
    const catalog = new ModelCatalogService(credentials, {
      fetch: (async () => new Response('', { status: 401 })) as typeof fetch,
      resolveHostname: publicResolver,
    })
    await expect(catalog.discover({ baseUrl: 'https://models.example.test/v1', providerKind: 'openai-compatible-remote', api: 'openai-completions', apiKey: 'sk-invalid-test-key' }))
      .rejects.toMatchObject<ServiceError>({
        kind: 'forbidden',
        code: 'model_credential_rejected',
        message: 'API 密钥无效或没有访问权限，请检查后重试。',
      })
  })

  it('rejects a public hostname that resolves to a metadata or link-local address before sending credentials', async () => {
    const root = await temporaryRoot()
    const credentials = await ModelCredentialService.open(root)
    services.push(credentials)
    let fetchCalls = 0
    const catalog = new ModelCatalogService(credentials, {
      fetch: (async () => { fetchCalls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch,
      resolveHostname: { resolve: async () => ['169.254.169.254', '93.184.216.34'] },
    })

    await expect(catalog.discover({
      baseUrl: 'https://public.example.test/v1',
      providerKind: 'openai-compatible-remote',
      api: 'openai-completions',
      apiKey: 'must-not-leave-this-process',
    })).rejects.toMatchObject<ServiceError>({ code: 'model_base_url_private_target' })
    expect(fetchCalls).toBe(0)
  })

  it('rejects URL userinfo and public HTTP targets without invoking fetch', async () => {
    const root = await temporaryRoot()
    const credentials = await ModelCredentialService.open(root)
    services.push(credentials)
    let fetchCalls = 0
    const catalog = new ModelCatalogService(credentials, {
      fetch: (async () => { fetchCalls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch,
      resolveHostname: publicResolver,
    })

    await expect(catalog.discover({
      baseUrl: 'https://user:password@models.example.test/v1',
      providerKind: 'openai-compatible-remote',
      api: 'openai-completions',
      apiKey: 'must-not-leave-this-process',
    })).rejects.toMatchObject<ServiceError>({ code: 'model_base_url_credentials' })
    await expect(catalog.discover({
      baseUrl: 'http://models.example.test/v1',
      providerKind: 'openai-compatible-remote',
      api: 'openai-completions',
      apiKey: 'must-not-leave-this-process',
    })).rejects.toMatchObject<ServiceError>({ code: 'model_base_url_insecure' })
    expect(fetchCalls).toBe(0)
  })

  it('sets redirect mode to error so model credentials cannot follow an upstream redirect', async () => {
    const root = await temporaryRoot()
    const credentials = await ModelCredentialService.open(root)
    services.push(credentials)
    let redirect: RequestRedirect | undefined
    let fetchCalls = 0
    const catalog = new ModelCatalogService(credentials, {
      fetch: (async (_input, init) => {
        fetchCalls += 1
        redirect = init?.redirect
        return new Response('', { status: 302, headers: { location: 'https://evil.example.test/models' } })
      }) as typeof fetch,
      resolveHostname: publicResolver,
    })

    await expect(catalog.discover({
      baseUrl: 'https://models.example.test/v1',
      providerKind: 'openai-compatible-remote',
      api: 'openai-completions',
      apiKey: 'must-not-follow-redirect',
    })).rejects.toMatchObject<ServiceError>({ code: 'model_catalog_rejected' })
    expect(redirect).toBe('error')
    expect(fetchCalls).toBe(1)
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-model-service-'))
  roots.push(root)
  return root
}
