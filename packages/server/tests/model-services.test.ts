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
    })
    const models = await catalog.discover({ baseUrl: 'https://models.example.test/v1/', api: 'openai-completions', profileId: 'profile-1' })
    expect(requestUrl).toBe('https://models.example.test/v1/models')
    expect(authorized).toBe(true)
    expect(models).toEqual([{ id: 'a-model', displayName: '模型 A' }, { id: 'z-model' }])
  })

  it('maps upstream authentication errors to a Chinese actionable message', async () => {
    const root = await temporaryRoot()
    const credentials = await ModelCredentialService.open(root)
    services.push(credentials)
    const catalog = new ModelCatalogService(credentials, { fetch: (async () => new Response('', { status: 401 })) as typeof fetch })
    await expect(catalog.discover({ baseUrl: 'https://models.example.test/v1', api: 'openai-completions', apiKey: 'sk-invalid-test-key' }))
      .rejects.toMatchObject<ServiceError>({
        kind: 'forbidden',
        code: 'model_credential_rejected',
        message: 'API 密钥无效或没有访问权限，请检查后重试。',
      })
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-model-service-'))
  roots.push(root)
  return root
}
