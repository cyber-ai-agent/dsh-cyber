import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ensureHarnessProfile, validateProviderProfile, type HarnessProviderProfile } from '../src/profile.js'

function profile(overrides: Partial<HarnessProviderProfile> = {}): HarnessProviderProfile {
  return { route: 'local-keyless', displayName: '本地无密钥模型', api: 'openai-completions',
    baseURL: 'http://127.0.0.1:11434/v1', model: { id: 'local-model' }, ...overrides }
}

async function savedRoute(input: HarnessProviderProfile): Promise<Record<string, unknown>> {
  const home = await mkdtemp(join(tmpdir(), 'cyber-keyless-profile-'))
  const paths = await ensureHarnessProfile(home, 'keyless-profile', input)
  const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'))
  const patches = JSON.parse(await readFile(paths.profilePatchPath, 'utf8'))
  const route = settings['llm-pi-ai'].providers[input.route] as Record<string, unknown>
  expect(patches.find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers[input.route]).toEqual(route)
  return route
}

describe('explicit keyless provider profile', () => {
  it('uses a nonsecret SDK compatibility header only for an explicit keyless route', async () => {
    expect(await savedRoute(profile({ requiresApiKey: false }))).toMatchObject({
      headers: { Authorization: 'Bearer dsh-cyber-local-no-auth' },
    })
    expect(await savedRoute(profile({ requiresApiKey: false }))).not.toHaveProperty('apiKeyEnv')
    expect(await savedRoute(profile())).not.toHaveProperty('headers')
    expect(await savedRoute(profile({ requiresApiKey: true }))).not.toHaveProperty('headers')
  })

  it('preserves a configured credential without installing the compatibility header', async () => {
    const route = await savedRoute(profile({ apiKeyEnv: 'LOCAL_PROVIDER_KEY' }))
    expect(route.apiKeyEnv).toBe('LOCAL_PROVIDER_KEY')
    expect(route).not.toHaveProperty('headers')
  })

  it('rejects keyless mode on public endpoints, including HTTPS', () => {
    for (const baseURL of ['https://api.example.com/v1', 'https://8.8.8.8/v1', 'https://169.254.1.1/v1']) {
      expect(() => validateProviderProfile(profile({ baseURL, requiresApiKey: false })))
        .toThrow(/private-network endpoint/)
    }
  })

  it('accepts explicitly keyless loopback and private LAN endpoints', () => {
    for (const baseURL of ['http://localhost:1234/v1', 'http://[::1]:1234/v1', 'https://192.168.1.2/v1', 'http://10.0.0.2/v1']) {
      expect(() => validateProviderProfile(profile({ baseURL, requiresApiKey: false }))).not.toThrow()
    }
  })

  it('refuses to substitute a marker for a declared credential, including an unset one', () => {
    expect(() => validateProviderProfile(profile({ requiresApiKey: false, apiKeyEnv: 'LOCAL_PROVIDER_KEY' })))
      .toThrow(/cannot name a credential/)
  })
})
