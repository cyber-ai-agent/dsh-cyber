import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillCatalogEntry, SkillSettingsView, World } from '@dsh-cyber/contracts'

import { SkillCenterDialog } from '../src/features/skill-center/SkillCenterDialog.js'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

describe('SkillCenterDialog', () => {
  it('matches the hub structure and supports list detail, scoped settings and add-skill modes', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); calls.push({ path, ...(init === undefined ? {} : { init }) })
      if (path.endsWith('/skill-catalog')) return json({ items: catalog })
      if (path.endsWith('/skill-settings') && init?.method === 'PUT') return json({ ...settings, global: { ...settings.global, configured: true, skillIds: [] } })
      if (path.endsWith('/skill-settings')) return json(settings)
      if (path.includes('/skills/coding/detail')) return json({ entry: catalog[0], tree: [{ path: 'SKILL.md', kind: 'file' }], files: [{ path: 'SKILL.md', language: 'markdown', content: '# 软件实现\n\n## 使用说明', editable: false }], editable: false })
      throw new Error(`unexpected request: ${path}`)
    }))
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(SkillCenterDialog, { world, worlds: [world, secondWorld], onClose: vi.fn() })) })
    await flush()

    expect(document.body.textContent).toContain('技能列表')
    expect(document.body.textContent).toContain('技能设置')
    expect(document.body.textContent).toContain('添加技能')
    expect(document.body.querySelector('[aria-label="Skill 文件树"]')).not.toBeNull()
    expect(document.body.textContent).toContain('SKILL.md')
    expect(document.body.textContent).toContain('使用说明')

    await clickButton('技能设置')
    expect(document.body.textContent).toContain('全局')
    expect(document.body.textContent).toContain('测试世界')
    expect(document.body.textContent).toContain('第二世界')
    expect(document.body.textContent).toContain('全部勾选')
    const selectAll = Array.from(document.body.querySelectorAll('label')).find((item) => item.textContent?.includes('全部勾选'))?.querySelector<HTMLInputElement>('input')
    await act(async () => { selectAll?.click() })
    await clickButton('保存技能设置')
    expect(calls.some((call) => call.path.endsWith('/skill-settings') && call.init?.method === 'PUT' && String(call.init.body).includes('"skillIds":[]'))).toBe(true)

    await clickButton('添加技能')
    expect(document.body.textContent).toContain('导入技能包')
    expect(document.body.textContent).toContain('写入技能')
    await clickButton('写入技能')
    expect(document.body.textContent).toContain('AI 撰写技能')
    expect(document.body.textContent).toContain('SKILL 内容')
    await act(async () => { root.unmount() })
    expect(calls.map((call) => call.path)).toEqual(expect.arrayContaining([
      `/api/workspaces/${world.workspaceId}/skill-catalog`,
      `/api/workspaces/${world.workspaceId}/skill-settings`,
      `/api/workspaces/${world.workspaceId}/skills/coding/detail`,
    ]))
  })
})

const timestamp = '2026-09-14T00:00:00.000Z'
const world = { id: 'world-1', workspaceId: 'workspace-1', name: '测试世界', templateId: 'personal-world', status: 'active', createdAt: timestamp, updatedAt: timestamp } as World
const secondWorld = { ...world, id: 'world-2', name: '第二世界' }
const catalog: SkillCatalogEntry[] = [skill('coding', '软件实现'), skill('testing', '测试验证')]
const settings: SkillSettingsView = {
  global: { scope: 'workspace', scopeId: world.workspaceId, displayName: '全局', configured: false, inherited: false, skillIds: ['coding', 'testing'] },
  worlds: [world, secondWorld].map((item) => ({ scope: 'world', scopeId: item.id, displayName: item.name, configured: false, inherited: false, skillIds: ['coding', 'testing'] })),
}

function skill(id: string, displayName: string): SkillCatalogEntry { return { id, displayName, summary: `${displayName}说明`, adapterId: 'builtin.recipe', risks: [], supportsScheduling: false, persistentApproval: 'forbidden', kind: 'recipe', recommendedByDefault: true, source: 'builtin', scope: 'builtin', globalKnown: true, worldAvailable: true, availability: 'available' } }
function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
async function flush(): Promise<void> { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) }) }
async function clickButton(label: string): Promise<void> { const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.includes(label)); expect(button).toBeDefined(); await act(async () => { button?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) }) }
