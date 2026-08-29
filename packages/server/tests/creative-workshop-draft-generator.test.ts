import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore } from '@dsh-cyber/persistence'
import { CreativeWorkshopDraftGenerator } from '../src/services/creative-workshop-draft-generator.js'
import { CreativeWorkshopDraftService } from '../src/services/creative-workshop-draft-service.js'
import { ModelCredentialService } from '../src/services/model-credential-service.js'

const roots: string[] = []
const stores: SqliteStore[] = []
const credentials: ModelCredentialService[] = []

afterEach(async () => {
  for (const service of credentials.splice(0)) service.close()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('CreativeWorkshopDraftGenerator', () => {
  it('uses the configured default model and persists a strict five-character draft without creating a world', async () => {
    const { store, workspaceId, generator, seen } = await setup(JSON.stringify({
      schemaVersion: 1,
      world: { name: '夜航工作室', modelPolicy: { mode: 'inherit' } },
      characters: ['产品经理', '程序员 1', '程序员 2', '视觉设计师', '运营'].map((name, index) => ({ tempId: `draft-${index + 1}`, name, modelPolicy: { mode: 'inherit' } })),
    }))
    const draft = await generator.generate(workspaceId, '创建一个五人游戏工作室：一个产品经理、两个程序员、一个视觉设计师和一个运营。')
    expect(draft.characters).toHaveLength(5)
    expect(store.listWorlds(workspaceId)).toHaveLength(0)
    expect(seen.authorization).toBe('Bearer sk-workshop-test')
    expect(seen.body).toContain('user_request')
    expect(seen.body).toContain('Every requested person is a separate')
    expect((await new CreativeWorkshopDraftService(store).get(workspaceId))?.characters).toHaveLength(5)
  })

  it('repairs common model draft mistakes instead of failing the whole workshop', async () => {
    const content = [
      '好的，下面是建议草稿：',
      '```json',
      JSON.stringify({
        draft: {
          schemaVersion: 1,
          world: { name: '股票投资分析团队', purpose: '研究市场并形成投资观点' },
          characters: [
            { tempId: '投研负责人', name: '林夕', role: '投资负责人', requestedSkills: ['browser.read', '股票分析'], modelPolicy: { mode: 'recommend', requiredCapabilities: ['reasoning', '中文能力', 'tools'], reason: '负责综合判断' } },
            { tempId: 'draft-2', name: '阿澈', role: '宏观研究员', requestedSkills: ['made-up-skill'] },
            { tempId: '策略/员', name: '小北', role: '策略研究员' },
            { name: '墨羽', role: '风险分析师' },
            { tempId: 'draft-5', name: '七七', role: '数据分析师' },
          ],
        },
      }),
      '```',
      '请检查后再创建。',
    ].join('\n')
    const { store, workspaceId, generator, seen } = await setup(content, {
      baseUrl: 'https://models.example.test/v1/chat/completions',
      skillIds: ['browser.read'],
    })

    const draft = await generator.generate(workspaceId, '创建一个五个人的股票投资分析团队')

    expect(draft.world.name).toBe('股票投资分析团队')
    expect(draft.characters).toHaveLength(5)
    expect(draft.characters.map((character) => character.tempId)).toEqual(['draft-1', 'draft-2', 'draft-3', 'draft-4', 'draft-5'])
    expect(draft.characters[0]?.requestedSkills).toEqual(['browser.read'])
    expect(draft.characters[1]?.requestedSkills).toBeUndefined()
    expect(draft.characters[0]?.modelPolicy).toEqual({
      mode: 'recommend',
      requiredCapabilities: ['reasoning', 'tools'],
      reason: '负责综合判断',
    })
    expect(seen.url).toBe('https://models.example.test/v1/chat/completions')
    expect((JSON.parse(seen.body) as Record<string, unknown>).response_format).toBeUndefined()
    expect(store.listWorlds(workspaceId)).toHaveLength(0)
  })

  it('rejects malformed model JSON without creating entities', async () => {
    const { store, workspaceId, generator } = await setup('{not-json')
    await expect(generator.generate(workspaceId, '创建团队')).rejects.toMatchObject({ code: 'workshop_draft_json_invalid' })
    expect(store.listWorlds(workspaceId)).toHaveLength(0)
  })
})

async function setup(content: string, options: { baseUrl?: string; skillIds?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workshop-generator-'))
  roots.push(root)
  const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: 'AI 草稿工作区' })
  const profile = store.saveModelProfile({
    workspaceId: workspace.id, displayName: '测试模型', providerKind: 'openai-compatible-remote',
    baseUrl: options.baseUrl ?? 'https://models.example.test/v1', modelId: 'draft-model', api: 'openai-completions', isDefault: true, settings: {},
  })
  const vault = await ModelCredentialService.open(root)
  credentials.push(vault)
  await vault.set(profile.id, 'sk-workshop-test')
  const seen = { authorization: '', body: '', url: '' }
  const generator = new CreativeWorkshopDraftGenerator(store, vault, new CreativeWorkshopDraftService(store), {
    resolveHostname: { async resolve() { return ['93.184.216.34'] } },
    fetch: (async (url, init) => {
      seen.url = String(url)
      seen.authorization = new Headers(init?.headers).get('authorization') ?? ''
      seen.body = String(init?.body ?? '')
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
    ...(options.skillIds === undefined ? {} : {
      skillCatalog: {
        async listWorkspace() { return options.skillIds!.map((id) => ({ id })) },
      },
    }),
  })
  return { store, workspaceId: workspace.id, generator, seen }
}
