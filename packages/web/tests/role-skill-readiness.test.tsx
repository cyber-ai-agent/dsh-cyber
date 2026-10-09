import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeDossier, SkillCatalogEntry, World } from '@dsh-cyber/contracts'

import { EmployeeSkillsPanel } from '../src/components/EmployeeSkillsPanel.js'
import { roleSkillReadiness } from '../src/components/role-skill-readiness.js'
import { normalizeSkillCatalog } from '../src/components/skill-catalog.js'

const world = { id: 'world-a', workspaceId: 'workspace', name: '研究世界', status: 'active' } as World
const otherWorld = { ...world, id: 'world-b', name: '另一个世界' }
const catalog: SkillCatalogEntry[] = [entry('writing', '文档写作'), entry('research', '资料研究'), { ...entry('disabled', '停用技能'), worldAvailable: false, availability: 'unavailable', availabilityReason: 'world-disabled' }]
const roots: Root[] = []
afterEach(async () => { await act(async () => { roots.splice(0).forEach((root) => root.unmount()) }); document.body.replaceChildren(); vi.unstubAllGlobals() })

function entry(id: string, displayName = id): SkillCatalogEntry {
  return { id, displayName, summary: '技能说明', adapterId: 'builtin.recipe', risks: [], supportsScheduling: false, persistentApproval: 'forbidden', source: 'builtin', scope: 'builtin', globalKnown: true, worldAvailable: true, availability: 'available' }
}
function dossier(grants: string[] = [], id = 'role-a', selectedWorld = world): EmployeeDossier {
  return { employee: { id, worldId: selectedWorld.id, workspaceId: selectedWorld.workspaceId, displayName: id, blueprintId: 'role', blueprintVersion: '1', currentRevision: 1 }, revisions: [{ revision: 1, skillGrants: grants }], skills: [], evidence: [], milestones: [], journals: [], relationships: [] } as unknown as EmployeeDossier
}
function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }) }
function stubRequests(requested = ['research']) {
  return vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.includes('/skill-catalog')) return json({ items: catalog })
    if (path.includes('/blueprints')) return json({ items: [{ id: 'role', version: '1', requestedSkills: requested }] })
    if (path.endsWith('/skill-settings')) return json({ global: { scope: 'workspace', scopeId: 'workspace', displayName: '全局', configured: false, inherited: false, skillIds: ['writing'] }, worlds: [world, otherWorld].map((item) => ({ scope: 'world', scopeId: item.id, displayName: item.name, configured: true, inherited: false, skillIds: ['writing'] })) })
    if (path.includes('/detail')) return json({ entry: catalog[0], tree: [], files: [], editable: false })
    throw new Error(`Unexpected ${path}`)
  }))
}
async function mount(data = dossier(), selectedWorld = world) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  const onManageSkills = vi.fn()
  await act(async () => { root.render(createElement(EmployeeSkillsPanel, { dossier: data, world: selectedWorld, worlds: [world, otherWorld], onManageSkills })) })
  await flush()
  return { host, root, onManageSkills }
}
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
async function click(text: string, container: ParentNode = document.body) {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === text || item.getAttribute('aria-label') === text)
  expect(button, text).toBeDefined(); await act(async () => { button!.click() }); await flush()
}

describe('role skill readiness projection', () => {
  it('never conflates installed, world-enabled, role-granted and verified', () => {
    expect(roleSkillReadiness(catalog[0], false)).toMatchObject({ usable: false, label: '角色未授权', target: 'role' })
    expect(roleSkillReadiness(catalog[0], true)).toMatchObject({ usable: true, label: '可使用' })
    expect(roleSkillReadiness(catalog[2], true)).toMatchObject({ usable: false, label: '世界未启用', target: 'world' })
    expect(roleSkillReadiness(undefined, true)).toMatchObject({ usable: false, label: '目录中未找到', target: 'catalog' })
    for (const reason of ['workspace-disabled', 'package-conflict', 'package-unavailable', 'adapter-unavailable', 'adapter-package-mismatch'] as const) {
      const normalized = normalizeSkillCatalog({ items: [{ ...catalog[2], availabilityReason: reason }] })[0]
      expect(normalized?.availabilityReason).toBe(reason)
      expect(roleSkillReadiness(normalized, true).usable).toBe(false)
    }
    expect(normalizeSkillCatalog({ items: [{ ...catalog[2], availabilityReason: 'invented' }] })[0]?.availabilityReason).toBeUndefined()
  })
})

describe('EmployeeSkillsPanel', () => {
  it('explains a zero-grant role, recommends only requested skills and never writes or grants on navigation', async () => {
    stubRequests()
    const { host, onManageSkills } = await mount()
    expect(host.textContent).toContain('尚未授权角色技能')
    expect(host.textContent).toContain('角色未授权')
    expect(host.textContent).toContain('资料研究')
    expect(host.textContent).not.toContain('文档写作')
    expect(host.querySelectorAll('.role-skills__row')).toHaveLength(1)
    await click('管理角色技能', host)
    expect(onManageSkills).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === undefined)).toBe(true)
  })

  it('shows usable and blocked historical grants, with verification kept separate', async () => {
    stubRequests([])
    const { host } = await mount(dossier(['writing', 'disabled', 'gone']))
    expect(host.textContent).toContain('1 项可使用')
    expect(host.textContent).toContain('世界未启用')
    expect(host.textContent).toContain('目录中未找到')
    expect(host.textContent).toContain('不代表已验证')
    expect(host.textContent).toContain('成长与验证记录 · 0')
    expect(host.querySelectorAll('.is-usable')).toHaveLength(1)
  })

  it('groups MCP tools without claiming ungranted members are usable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/blueprints') ? json({ items: [] }) : json({ items: [
      { ...entry('mcp.browser.read'), mcpService: { id: 'browser', label: '浏览器' }, source: 'mcp' },
      { ...entry('mcp.browser.write'), mcpService: { id: 'browser', label: '浏览器' }, source: 'mcp' },
    ] })))
    const { host } = await mount(dossier(['mcp.browser.read']))
    expect(host.querySelectorAll('.role-skills__row')).toHaveLength(1)
    expect(host.textContent).toContain('1 项可使用')
    expect(host.textContent).not.toContain('mcp.browser.write')
  })

  it('opens existing settings on this world, closes safely and reads refreshed state without saving', async () => {
    stubRequests([])
    const { host } = await mount(dossier(['disabled']))
    await click('世界技能设置', host)
    await vi.waitFor(async () => { await flush(); expect(document.querySelector('[role="dialog"]')).not.toBeNull() })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('技能中心')
    expect(dialog.querySelector('.skill-center__scope-rail button.is-active')?.textContent).toContain('研究世界')
    expect(dialog.querySelector('.skill-center__settings-header h3')?.textContent).toBe('研究世界')
    expect(dialog.querySelector('.skill-center__tabs [aria-current="true"]')?.textContent).toBe('技能设置')
    await click('关闭技能中心')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host.textContent).toContain('世界未启用')
    await click('世界技能设置', host)
    await vi.waitFor(async () => { await flush(); expect(document.querySelector('[role="dialog"]')).not.toBeNull() })
    expect(document.querySelector('.skill-center__settings-header h3')?.textContent).toBe('研究世界')
    await click('关闭技能中心')
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === undefined)).toBe(true)
  })

  it('does not fall back to global settings when a requested world is missing', async () => {
    stubRequests([])
    const missing = { ...world, id: 'missing' }
    const { host } = await mount(dossier(['disabled'], 'missing-role', missing), missing)
    await click('世界技能设置', host)
    await vi.waitFor(async () => { await flush(); expect(document.querySelector('[role="dialog"]')).not.toBeNull() })
    expect(document.body.textContent).toContain('此技能设置范围已不可用')
    expect(document.querySelector('.skill-center__settings-header')).toBeNull()
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === undefined)).toBe(true)
  })

  it('does not expose a previous world’s role while its replacement loads', async () => {
    stubRequests([])
    const { host } = await mount(dossier(['writing']), otherWorld)
    expect(host.textContent).toContain('正在读取当前世界的角色')
    expect(host.querySelector('button')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects stale catalog responses after switching role and world, and closes scoped settings', async () => {
    let resolveOld: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/blueprints')) return json({ items: [] })
      if (path.includes('world-a/skill-catalog')) return new Promise<Response>((resolve) => { resolveOld = resolve })
      return json({ items: [entry('new', '新世界技能')] })
    }))
    const { root, host, onManageSkills } = await mount(dossier(['writing']))
    expect(host.textContent).toContain('正在检查')
    await act(async () => { root.render(createElement(EmployeeSkillsPanel, { dossier: dossier(['new'], 'role-b', otherWorld), world: otherWorld, worlds: [world, otherWorld], onManageSkills })) })
    await flush()
    expect(host.textContent).toContain('新世界技能')
    await act(async () => { resolveOld!(json({ items: catalog })) })
    expect(host.textContent).not.toContain('文档写作')
    expect(host.textContent).not.toContain('role-a')
    expect(host.textContent).toContain('另一个世界 · role-b')
  })

  it('offers retry after failure without presenting stale grants as usable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })))
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'))
    const { host } = await mount(dossier(['writing']))
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(host.querySelector('.is-usable')).toBeNull()
    stubRequests([])
    await click('重试读取技能', host)
    expect(host.textContent).toContain('1 项可使用')
  })
})
