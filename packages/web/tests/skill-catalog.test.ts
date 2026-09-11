import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EmployeeBlueprint, EmployeeInstance, World } from '@dsh-cyber/contracts'
import { RecruitmentDialog } from '../src/components/RecruitmentDialog.js'
import { SkillGrantEditor } from '../src/components/SkillGrantEditor.js'
import { normalizeSkillCatalogEntry, type SkillCatalogEntry } from '../src/components/skill-catalog.js'

const world: World = {
  id: 'world-skill-catalog-test',
  workspaceId: 'workspace-skill-catalog-test',
  name: '技能目录测试世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
}

const blueprint: EmployeeBlueprint = {
  schemaVersion: 1,
  id: 'blueprint-researcher',
  version: 2,
  worldTemplateId: world.templateId,
  displayName: '研究员',
  role: '研究员',
  summary: '整理资料与验证事实。',
  persona: '保持证据边界。',
  requestedSkills: ['core.notes', 'team.search'],
  requestedCapabilities: [],
  createdAt: '2026-08-26T00:00:00.000Z',
}

const employee: EmployeeInstance = {
  id: 'employee-researcher',
  workspaceId: world.workspaceId,
  worldId: world.id,
  blueprintId: blueprint.id,
  blueprintVersion: blueprint.version,
  displayName: '林研究员',
  role: blueprint.role,
  status: 'available',
  currentRevision: 3,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
}

const catalog: SkillCatalogEntry[] = [
  skill('core.notes', '记录整理', true),
  skill('team.search', '团队搜索', false),
  skill('extra.skill', '额外分析', false),
  { ...skill('old.skill', '旧连接', false), worldAvailable: false, availability: 'unavailable' },
]

afterEach(() => vi.unstubAllGlobals())

describe('world-scoped skill catalog UI', () => {
  it('loads world-scoped blueprints/catalog and lets existing roles grant non-blueprint skills', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/catalog/blueprints?worldId=world-skill-catalog-test') return json({ items: [blueprint] })
      if (path === '/api/worlds/world-skill-catalog-test/skill-catalog') return json({ items: catalog })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    const { host, root } = await mount(createElement(SkillGrantEditor, { employee, value: ['core.notes', 'legacy.skill'], onChange }))
    await flush()
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
      '/api/catalog/blueprints?worldId=world-skill-catalog-test',
      '/api/worlds/world-skill-catalog-test/skill-catalog',
    ]))
    expect(host.textContent).toContain('推荐技能')
    expect(host.textContent).toContain('其他可学习技能')
    expect(host.textContent).toContain('当前不可用')
    expect(host.textContent).toContain('推荐')
    expect(host.textContent).toContain('可学习')
    expect(host.textContent).toContain('已启用')
    expect(host.textContent).toContain('暂不可用')
    expect(host.textContent).not.toContain('旧连接')

    const extraCheckbox = checkboxFor(host, '额外分析')
    expect(extraCheckbox.disabled).toBe(false)
    await act(async () => { extraCheckbox.click() })
    expect(onChange).toHaveBeenLastCalledWith(['core.notes', 'legacy.skill', 'extra.skill'])

    const legacyCheckbox = checkboxFor(host, 'legacy.skill')
    expect(legacyCheckbox.checked).toBe(true)
    expect(legacyCheckbox.disabled).toBe(false)
    await act(async () => { legacyCheckbox.click() })
    expect(onChange).toHaveBeenLastCalledWith(['core.notes'])
    await unmount(root, host)
  })

  it('passes through the MCP service grouping metadata', () => {
    const base = { id: 'mcp.github.create_issue', displayName: 'MCP · GitHub MCP / create_issue' }
    expect(normalizeSkillCatalogEntry({ ...base, mcpService: { id: 'github', label: 'GitHub MCP' } })?.mcpService)
      .toEqual({ id: 'github', label: 'GitHub MCP' })
    expect(normalizeSkillCatalogEntry({ ...base, mcpService: { id: 'github' } })?.mcpService).toBeUndefined()
    expect(normalizeSkillCatalogEntry({ ...base, mcpService: 'github' })?.mcpService).toBeUndefined()
  })

  it('collapses one MCP service tools into a single grant row', async () => {
    const mcpCatalog: SkillCatalogEntry[] = [
      mcpTool('mcp.playwright.browser_navigate', 'MCP · Playwright 浏览器 / browser_navigate', { id: 'playwright', label: 'Playwright 浏览器' }),
      mcpTool('mcp.playwright.browser_click', 'MCP · Playwright 浏览器 / browser_click', { id: 'playwright', label: 'Playwright 浏览器' }),
      mcpTool('mcp.github.create_issue', 'MCP · GitHub MCP / create_issue', { id: 'github', label: 'GitHub MCP' }),
      skill('core.notes', '记录整理', true),
    ]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/catalog/blueprints?worldId=world-skill-catalog-test') return json({ items: [blueprint] })
      if (path === '/api/worlds/world-skill-catalog-test/skill-catalog') return json({ items: mcpCatalog })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    const initial = ['mcp.github.create_issue', 'mcp.playwright.browser_click']
    const { host, root } = await mount(createElement(SkillGrantEditor, { employee, value: initial, onChange }))
    await flush()

    // One row per MCP service plus the single non-MCP recommended skill.
    const rows = Array.from(host.querySelectorAll('.skill-grant-row'))
    expect(rows).toHaveLength(3)
    expect(host.textContent).toContain('MCP · Playwright 浏览器')
    expect(host.textContent).toContain('MCP · GitHub MCP')

    const rowFor = (text: string): HTMLInputElement => {
      const row = Array.from(host.querySelectorAll('.skill-grant-row')).find((item) => item.textContent?.includes(text))
      const checkbox = row?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      if (checkbox === null || checkbox === undefined) throw new Error(`row not found: ${text}`)
      return checkbox
    }

    // GitHub: fully granted → checked. Playwright: one of two granted → indeterminate.
    expect(rowFor('MCP · GitHub MCP').checked).toBe(true)
    const playwrightCheckbox = rowFor('MCP · Playwright 浏览器')
    expect(playwrightCheckbox.checked).toBe(false)
    expect(playwrightCheckbox.indeterminate).toBe(true)

    // Checking the Playwright row grants every tool of the service at once.
    await act(async () => { playwrightCheckbox.click() })
    expect(onChange).toHaveBeenLastCalledWith([
      'mcp.github.create_issue',
      'mcp.playwright.browser_click',
      'mcp.playwright.browser_navigate',
    ])

    // Unchecking the GitHub row revokes all of the service's grants.
    const githubCheckbox = rowFor('MCP · GitHub MCP')
    await act(async () => { githubCheckbox.click() })
    expect(onChange).toHaveBeenLastCalledWith(['mcp.playwright.browser_click'])
    await unmount(root, host)
  })

  it('keeps a dead MCP service revocable as one aggregated row', async () => {
    const mcpCatalog: SkillCatalogEntry[] = [
      mcpTool('mcp.github.create_issue', 'MCP · GitHub MCP / create_issue', { id: 'github', label: 'GitHub MCP' }),
    ]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/catalog/blueprints?worldId=world-skill-catalog-test') return json({ items: [blueprint] })
      if (path === '/api/worlds/world-skill-catalog-test/skill-catalog') return json({ items: mcpCatalog })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    const { host, root } = await mount(createElement(SkillGrantEditor, {
      employee,
      value: ['mcp.dead.tool_one', 'mcp.dead.tool_two', 'mcp.github.create_issue'],
      onChange,
    }))
    await flush()

    // The unknown service renders exactly one aggregated row (not one per tool),
    // checked because its stale grants remain; the live service row is untouched.
    expect(host.textContent).toContain('MCP · dead')
    expect(host.textContent).toContain('暂不可用')
    const row = Array.from(host.querySelectorAll('.skill-grant-row')).find((item) => item.textContent?.includes('MCP · dead'))!
    const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.checked).toBe(true)
    await act(async () => { checkbox.click() })
    expect(onChange).toHaveBeenLastCalledWith(['mcp.github.create_issue'])
    await unmount(root, host)
  })

  it('uses recommended defaults during recruitment and preserves an explicit empty selection', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/catalog/blueprints?worldId=world-skill-catalog-test') return json({ items: [blueprint] })
      if (path === '/api/worlds/world-skill-catalog-test/skill-catalog') return json({ items: catalog })
      if (path === '/api/worlds/world-skill-catalog-test/snapshot') return json({ employees: [] })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { host, root } = await mount(createElement(RecruitmentDialog, {
      blueprints: [],
      employees: [],
      world,
      loading: false,
      recruiting: false,
      onClose: vi.fn(),
      onRecruit: vi.fn(async () => undefined),
    }))
    await flush()
    expect(host.textContent).toContain('研究员')
    const recommendedCheckbox = checkboxFor(host, '记录整理')
    const optionalCheckbox = checkboxFor(host, '团队搜索')
    expect(recommendedCheckbox.checked).toBe(true)
    expect(optionalCheckbox.checked).toBe(true)
    await act(async () => { recommendedCheckbox.click() })
    expect(recommendedCheckbox.checked).toBe(false)
    await act(async () => { optionalCheckbox.click() })
    expect(optionalCheckbox.checked).toBe(false)
    const nameInput = host.querySelector<HTMLInputElement>('input[placeholder*="研究员"]')
    await act(async () => { if (nameInput !== null) { nameInput.value = '新研究员'; nameInput.dispatchEvent(new Event('input', { bubbles: true })) } })
    expect(recommendedCheckbox.checked).toBe(false)
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
      '/api/catalog/blueprints?worldId=world-skill-catalog-test',
      '/api/worlds/world-skill-catalog-test/skill-catalog',
    ]))
    await unmount(root, host)
  })
})

function skill(id: string, displayName: string, recommendedByDefault: boolean): SkillCatalogEntry {
  return {
    id,
    displayName,
    summary: `${displayName}说明`,
    adapterId: 'test-adapter',
    risks: ['read'],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    kind: 'recipe',
    recommendedByDefault,
    source: 'builtin',
    scope: 'world',
    globalKnown: true,
    worldAvailable: true,
    availability: 'available',
  }
}

function mcpTool(id: string, displayName: string, service: { id: string; label: string }, available = true): SkillCatalogEntry {
  return {
    id,
    displayName,
    summary: 'MCP 工具说明。',
    adapterId: 'builtin.mcp',
    risks: ['external-side-effect'],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    kind: 'integration',
    recommendedByDefault: false,
    mcpService: service,
    source: 'mcp',
    scope: 'workspace',
    globalKnown: true,
    worldAvailable: available,
    availability: available ? 'available' : 'unavailable',
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function mount(element: ReturnType<typeof createElement>): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(element) })
  return { host, root }
}

async function unmount(root: Root, host: HTMLElement): Promise<void> {
  await act(async () => { root.unmount() })
  host.remove()
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
  })
}

function checkboxFor(host: HTMLElement, text: string): HTMLInputElement {
  const label = Array.from(host.querySelectorAll('label')).find((item) => item.textContent?.includes(text))
  const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (checkbox === null || checkbox === undefined) throw new Error(`checkbox not found: ${text}`)
  return checkbox
}
