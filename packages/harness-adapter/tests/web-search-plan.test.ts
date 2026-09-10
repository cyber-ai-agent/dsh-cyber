import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  WORKER_WEBSEARCH_DEEPSEEK_KEY_ENV,
  applyWebSearchPlanToEnvironment,
  ensureHarnessProfile,
  type WorkerWebSearchPlan,
} from '../src/index.js'

async function writeProfile(plan?: WorkerWebSearchPlan, providerProfile?: Parameters<typeof ensureHarnessProfile>[2]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-websearch-profile-'))
  const profile = await ensureHarnessProfile(directory, 'dsh-cyber-worker', providerProfile, plan)
  return profile.profilePatchPath
}

function rows(path: string): Promise<Array<{ id: string; config: Record<string, unknown> }>> {
  return readFile(path, 'utf8').then((text) => JSON.parse(text) as Array<{ id: string; config: Record<string, unknown> }>)
}

describe('applyWebSearchPlanToEnvironment', () => {
  it('materializes the DeepSeek key under the generated env name', () => {
    const env: NodeJS.ProcessEnv = {}
    applyWebSearchPlanToEnvironment(env, { kind: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic/v1', apiKeyEnv: WORKER_WEBSEARCH_DEEPSEEK_KEY_ENV, apiKey: 'sk-test' })
    expect(env[WORKER_WEBSEARCH_DEEPSEEK_KEY_ENV]).toBe('sk-test')
  })

  it('exposes only loopback coordinates for Firecrawl (no credential)', () => {
    const env: NodeJS.ProcessEnv = {}
    applyWebSearchPlanToEnvironment(env, { kind: 'firecrawl', workspaceId: 'ws-1', hostOrigin: 'http://127.0.0.1:43123', workerToken: 'tok' })
    expect(env.DSH_CYBER_WORKSPACE_ID).toBe('ws-1')
    expect(env.DSH_CYBER_LOOPBACK_ORIGIN).toBe('http://127.0.0.1:43123')
    expect(env.DSH_CYBER_WORKER_TOKEN).toBe('tok')
    expect(JSON.stringify(env)).not.toContain('sk-')
  })

  it('leaves the environment untouched when disabled or absent', () => {
    const env: NodeJS.ProcessEnv = {}
    applyWebSearchPlanToEnvironment(env, { kind: 'disabled' })
    applyWebSearchPlanToEnvironment(env, undefined)
    expect(Object.keys(env)).toHaveLength(0)
  })
})

describe('ensureHarnessProfile web-search plan rows', () => {
  it('selects the firecrawl provider and keeps fetch enabled', async () => {
    const patchPath = await writeProfile({ kind: 'firecrawl', workspaceId: 'ws-1', hostOrigin: 'http://127.0.0.1:1', workerToken: 't' })
    const patch = await rows(patchPath)
    expect(patch).toContainEqual({ id: 'web', config: { searchProvider: 'firecrawl', fetchProvider: 'http' } })
    expect(patch.find((row) => row.id === 'tool-web')).toBeUndefined()
  })

  it('points the built-in DeepSeek provider at the connection endpoint with a generated key name', async () => {
    const patchPath = await writeProfile({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic/v1', apiKeyEnv: WORKER_WEBSEARCH_DEEPSEEK_KEY_ENV, apiKey: 'sk-x' })
    const patch = await rows(patchPath)
    expect(patch).toContainEqual({ id: 'web-search-deepseek', config: { apiKeyEnv: WORKER_WEBSEARCH_DEEPSEEK_KEY_ENV, baseURL: 'https://api.deepseek.com/anthropic/v1' } })
    expect(patch).toContainEqual({ id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } })
  })

  it('hides web_search when no backend is usable', async () => {
    const patchPath = await writeProfile({ kind: 'disabled' })
    const patch = await rows(patchPath)
    expect(patch).toContainEqual({ id: 'tool-web', config: { search: false, fetch: true, searchTimeoutMs: 60_000 } })
  })

  it('keeps the legacy empty patch when no plan and no provider profile are supplied', async () => {
    const patchPath = await writeProfile()
    const raw = await readFile(patchPath, 'utf8')
    expect(raw).toContain('[]')
    expect(raw).toContain('Machine-local DSH Cyber worker overrides')
  })

  it('lets the managed model web-search own the DeepSeek backend (plan ignored)', async () => {
    const providerProfile = {
      route: 'cyber-x',
      displayName: 'DeepSeek 测试',
      api: 'openai-completions',
      baseURL: 'https://api.deepseek.com/v1',
      model: { id: 'deepseek-chat' },
      apiKeyEnv: 'DSH_CYBER_MODEL_KEY_X',
      webSearch: { baseURL: 'https://api.deepseek.com/anthropic/v1', apiKeyEnv: 'DSH_CYBER_MODEL_KEY_X' },
    }
    const patchPath = await writeProfile({ kind: 'firecrawl', workspaceId: 'ws-1' }, providerProfile)
    const patch = await rows(patchPath)
    expect(patch).toContainEqual({ id: 'web-search-deepseek', config: { apiKeyEnv: 'DSH_CYBER_MODEL_KEY_X', baseURL: 'https://api.deepseek.com/anthropic/v1' } })
    // The managed path must not also flip the seam to firecrawl.
    expect(patch.find((row) => row.id === 'web')).toBeUndefined()
  })
})
