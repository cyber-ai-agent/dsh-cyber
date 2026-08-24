import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import { createBuiltinIntegrationRegistry } from '../src/integrations/builtin-integration-registry.js'
import { FIRECRAWL_INTEGRATION_ID } from '../src/integrations/firecrawl-provider.js'
import { IntegrationService } from '../src/integrations/integration-service.js'
import { FirecrawlSkillAdapter } from '../src/skills/firecrawl-skill-adapter.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('Integration Registry + Firecrawl', () => {
  it('persists public configuration separately from encrypted credentials and restores both after restart', async () => {
    const root = await makeRoot()
    const service = await IntegrationService.open(root, createBuiltinIntegrationRegistry(), async () => Response.json({ success: true, data: [] }))
    const saved = await service.save({
      workspaceId: 'workspace-1', integrationId: FIRECRAWL_INTEGRATION_ID,
      config: { baseUrl: 'http://127.0.0.1:3002' }, enabled: true, credential: 'fc-private-test-key',
    })
    expect(saved.credentialConfigured).toBe(true)
    expect(await readFile(join(root, 'integrations', 'connections.json'), 'utf8')).not.toContain('fc-private-test-key')
    service.close()

    const restored = await IntegrationService.open(root, createBuiltinIntegrationRegistry(), async () => Response.json({ success: true, data: [] }))
    expect(restored.get('workspace-1', FIRECRAWL_INTEGRATION_ID)).toMatchObject({ enabled: true, credentialConfigured: true, config: { baseUrl: 'http://127.0.0.1:3002' } })
    expect(restored.credential('workspace-1', FIRECRAWL_INTEGRATION_ID)).toBe('fc-private-test-key')
    restored.close()
  })

  it('tests a configured connection without exposing its credential', async () => {
    const root = await makeRoot()
    let authorization = ''
    const service = await IntegrationService.open(root, createBuiltinIntegrationRegistry(), async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return Response.json({ success: true, data: [] })
    })
    await service.save({ workspaceId: 'workspace-1', integrationId: FIRECRAWL_INTEGRATION_ID, config: {}, enabled: true, credential: 'fc-test' })
    expect(await service.test('workspace-1', FIRECRAWL_INTEGRATION_ID)).toMatchObject({ status: 'ready', detail: '连接测试成功' })
    expect(authorization).toBe('Bearer fc-test')
    expect(JSON.stringify(service.list('workspace-1'))).not.toContain('fc-test')
    service.close()
  })

  it('keeps Firecrawl behind explicit grant language and returns bounded public results', async () => {
    const root = await makeRoot()
    const service = await IntegrationService.open(root, createBuiltinIntegrationRegistry(), async () => Response.json({
      success: true,
      data: { web: [{ title: '官方资料', url: 'https://example.com/source', description: '可追溯的公开摘要。' }] },
    }))
    await service.save({ workspaceId: 'workspace-1', integrationId: FIRECRAWL_INTEGRATION_ID, config: {}, enabled: true, credential: 'fc-test' })
    const adapter = new FirecrawlSkillAdapter({
      store: { getWorld: () => ({ id: 'world-1', workspaceId: 'workspace-1', name: '世界', templateId: 'personal-world', status: 'active', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' }) },
      integrations: service,
      listWorldPackages: async () => [{ manifest: { entrypoints: [{ id: 'web.search.firecrawl', kind: 'skill', path: 'skill.json' }] } } as never],
      fetch: async () => Response.json({ success: true, data: { web: [{ title: '官方资料', url: 'https://example.com/source', description: '可追溯的公开摘要。' }] } }),
    })
    expect(adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '请联网搜索 DSH Cyber', grantedSkillIds: [], now: new Date() })).toEqual([])
    const proposal = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '请联网搜索 DSH Cyber', grantedSkillIds: ['web.search.firecrawl'], now: new Date() })[0]!
    expect(proposal).toMatchObject({ target: 'firecrawl:web-search', risk: 'external-side-effect', parameters: { query: 'DSH Cyber' } })
    const result = await adapter.execute(actionFrom(proposal))
    expect(result).toMatchObject({ status: 'executed' })
    expect(result.detail).toContain('官方资料')
    expect(result.detail).toContain('https://example.com/source')
    expect(result.detail).not.toContain('fc-test')
    service.close()
  })

  it('does not send a query when the current world has no Skill Recipe instance', async () => {
    const root = await makeRoot()
    let requests = 0
    const service = await IntegrationService.open(root, createBuiltinIntegrationRegistry())
    await service.save({ workspaceId: 'workspace-1', integrationId: FIRECRAWL_INTEGRATION_ID, config: {}, enabled: true, credential: 'fc-test' })
    const adapter = new FirecrawlSkillAdapter({
      store: { getWorld: () => ({ id: 'world-1', workspaceId: 'workspace-1', name: '世界', templateId: 'personal-world', status: 'active', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' }) },
      integrations: service,
      listWorldPackages: async () => [],
      fetch: async () => { requests += 1; return Response.json({ success: true, data: { web: [] } }) },
    })
    const proposal = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '请联网搜索 边界测试', grantedSkillIds: ['web.search.firecrawl'], now: new Date() })[0]!
    expect(await adapter.execute(actionFrom(proposal))).toMatchObject({ status: 'waiting-for-integration', detail: expect.stringContaining('尚未安装联网搜索 Skill Recipe') })
    expect(requests).toBe(0)
    service.close()
  })
})

async function makeRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'dsh-integrations-')); roots.push(root); return root }

function actionFrom(proposal: ReturnType<FirecrawlSkillAdapter['propose']>[number]): CharacterSkillAction {
  return {
    id: 'action-1', worldId: 'world-1', characterId: 'character-1', skillId: proposal.skillId,
    adapterId: proposal.adapterId, action: proposal.action, target: proposal.target, label: proposal.label,
    risk: proposal.risk, authorization: proposal.authorization, parameters: proposal.parameters ?? {},
    status: 'waiting-for-integration', detail: '', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
  }
}
