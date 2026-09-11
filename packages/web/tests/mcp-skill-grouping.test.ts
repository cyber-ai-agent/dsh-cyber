import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillCatalogEntry } from '@dsh-cyber/contracts/skill-runtime'
import type { CharacterSkillDescriptor } from '@dsh-cyber/contracts/creative-platform'

import {
  groupMcpServices,
  groupMcpServicesFromItems,
  mcpServiceChecked,
  mcpServiceOfSkillId,
  mcpServiceStatus,
  mcpServiceToggle,
  orphanMcpServiceGroups,
  toggleSkillIdInList,
  type McpGroupItem,
  type McpServiceGroup,
} from '../src/components/mcp-skill-grouping.js'
import { SkillApprovalGroup } from '../src/components/RecruitmentDialog.js'
import { WorkshopSkillPicker } from '../src/components/creative-workshop/workshop-skill-picker.js'
import { skillChipsForRole } from '../src/components/creative-workshop/CreativeWorkshopProjectLibrary.js'
import { setUiLocale } from '../src/i18n/runtime.js'

function catalogEntry(overrides: Partial<SkillCatalogEntry> & { id: string }): SkillCatalogEntry {
  return {
    displayName: overrides.id,
    summary: '技能摘要',
    adapterId: 'builtin.mcp',
    risks: ['external-side-effect'],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    kind: 'integration',
    source: 'mcp',
    scope: 'workspace',
    globalKnown: true,
    worldAvailable: true,
    availability: 'available',
    ...overrides,
  }
}

function mcpCatalogEntry(service: string, label: string, tool: string, overrides: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
  return catalogEntry({
    id: `mcp.${service}.${tool}`,
    mcpService: { id: service, label },
    ...overrides,
  })
}

describe('mcpServiceOfSkillId', () => {
  it('splits three-segment ids on the first dot after the mcp. prefix', () => {
    expect(mcpServiceOfSkillId('mcp.playwright.browser_navigate')).toBe('playwright')
    expect(mcpServiceOfSkillId('mcp.my-svc.tool.with.dots')).toBe('my-svc')
  })

  it('treats two-segment legacy ids and plain ids as service-less', () => {
    expect(mcpServiceOfSkillId('mcp.browser_navigate')).toBeUndefined()
    expect(mcpServiceOfSkillId('code-review')).toBeUndefined()
  })
})

describe('groupMcpServicesFromItems', () => {
  const items: CharacterSkillDescriptor[] = [
    { id: 'mcp.playwright.browser_navigate', mcpService: { id: 'playwright', label: '浏览器自动化' }, displayName: 'x', summary: 's', adapterId: 'builtin.mcp', risks: ['external-side-effect'], supportsScheduling: false, persistentApproval: 'forbidden', kind: 'integration' },
    { id: 'mcp.playwright.browser_snapshot', mcpService: { id: 'playwright', label: '浏览器自动化' }, displayName: 'x', summary: 's', adapterId: 'builtin.mcp', risks: ['external-side-effect'], supportsScheduling: false, persistentApproval: 'forbidden', kind: 'integration' },
    { id: 'mcp.docs.search_docs', mcpService: { id: 'docs', label: '文档检索' }, displayName: 'x', summary: 's', adapterId: 'builtin.mcp', risks: ['external-side-effect'], supportsScheduling: false, persistentApproval: 'forbidden', kind: 'integration' },
    { id: 'code-review', displayName: '代码审查', summary: 's', adapterId: 'builtin.recipe', risks: [], supportsScheduling: true, persistentApproval: 'forbidden', kind: 'recipe' },
  ]

  it('groups tool descriptors by service and falls back to the slug label', () => {
    const groups = groupMcpServicesFromItems(items, [], [])
    // Sorted by label in the zh-CN collation: 浏览器自动化 (playwright) < 文档检索 (docs).
    expect(groups.map((group) => group.serviceId)).toEqual(['playwright', 'docs'])
    const playwright = groups.find((group) => group.serviceId === 'playwright')!
    expect(playwright.label).toBe('浏览器自动化')
    expect(playwright.tools.map((tool) => tool.id)).toEqual([
      'mcp.playwright.browser_navigate',
      'mcp.playwright.browser_snapshot',
    ])
    expect(playwright.tools.every((tool) => tool.available)).toBe(true)
  })

  it('creates an empty-tools group for value ids of a service the items no longer know', () => {
    const groups = groupMcpServicesFromItems([], ['mcp.ghost.open_page'], [])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      serviceId: 'ghost',
      label: 'ghost',
      tools: [],
      grantedIds: ['mcp.ghost.open_page'],
      learnable: false,
      placement: 'unavailable',
    })
  })

  it('marks requested services as recommended and records their requested ids', () => {
    const groups = groupMcpServicesFromItems(items, [], ['mcp.playwright.browser_navigate', 'code-review'])
    const playwright = groups.find((group) => group.serviceId === 'playwright')!
    expect(playwright.recommended).toBe(true)
    expect(playwright.placement).toBe('recommended')
    expect(playwright.requestedIds).toEqual(['mcp.playwright.browser_navigate'])
    expect(groups.find((group) => group.serviceId === 'docs')!.recommended).toBe(false)
  })

  it('keeps services without grants or requests learnable and available', () => {
    const groups = groupMcpServicesFromItems(items, [], [])
    expect(groups.map((group) => group.placement)).toEqual(['learnable', 'learnable'])
    expect(groups.every((group) => group.learnable)).toBe(true)
  })

  it('hides a service with no grantable tools and no stale grants', () => {
    const deadItems: McpGroupItem[] = [
      { id: 'mcp.dead.tool', mcpService: { id: 'dead', label: '失效连接' }, available: false },
    ]
    const groups = groupMcpServicesFromItems(deadItems, [], [])
    expect(groups[0]).toMatchObject({ serviceId: 'dead', placement: 'hidden', learnable: false })
  })
})

describe('groupMcpServices (world catalog form)', () => {
  it('derives availability from world availability, not item presence', () => {
    const catalog = [
      mcpCatalogEntry('playwright', '浏览器自动化', 'browser_navigate', { worldAvailable: false, availability: 'unavailable' }),
      mcpCatalogEntry('playwright', '浏览器自动化', 'browser_snapshot'),
    ]
    const groups = groupMcpServices(catalog, [], [])
    const playwright = groups[0]!
    expect(playwright.tools[0]).toMatchObject({ id: 'mcp.playwright.browser_navigate', available: false })
    expect(playwright.tools[1]).toMatchObject({ id: 'mcp.playwright.browser_snapshot', available: true })
    expect(playwright.learnable).toBe(true)
  })

  it('places a fully unavailable service with stale grants as "unavailable"', () => {
    const catalog = [mcpCatalogEntry('dead', '失效连接', 'old_tool', { worldAvailable: false, availability: 'unavailable' })]
    const groups = groupMcpServices(catalog, ['mcp.dead.old_tool'], [])
    expect(groups[0]!.placement).toBe('unavailable')
    expect(groups[0]!.grantedIds).toEqual(['mcp.dead.old_tool'])
  })
})

describe('orphanMcpServiceGroups', () => {
  it('synthesizes one unavailable row per requested service missing from the catalog', () => {
    const groups = orphanMcpServiceGroups(
      ['mcp.ghost.open_page', 'mcp.ghost.click', 'mcp.other.tool', 'mcp.browser_navigate'],
      ['known'],
      ['mcp.ghost.click'],
    )
    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.serviceId)).toEqual(['ghost', 'other'])
    const ghost = groups[0]!
    expect(ghost).toMatchObject({ label: 'ghost', tools: [], learnable: false, placement: 'unavailable', recommended: true })
    expect(ghost.requestedIds).toEqual(['mcp.ghost.open_page', 'mcp.ghost.click'])
    expect(ghost.grantedIds).toEqual(['mcp.ghost.click'])
  })

  it('returns nothing when every requested service is known or the request is legacy/plain', () => {
    expect(orphanMcpServiceGroups(['mcp.known.tool'], ['known'], [])).toEqual([])
    expect(orphanMcpServiceGroups(['mcp.browser_navigate', 'code-review'], [], [])).toEqual([])
  })
})

describe('mcpServiceToggle / mcpServiceChecked / mcpServiceStatus', () => {
  const fixtureItems: McpGroupItem[] = [
    { id: 'mcp.playwright.browser_navigate', mcpService: { id: 'playwright', label: '浏览器自动化' } },
    { id: 'mcp.playwright.browser_snapshot', mcpService: { id: 'playwright', label: '浏览器自动化' } },
    { id: 'mcp.playwright.browser_old', mcpService: { id: 'playwright', label: '浏览器自动化' }, available: false },
  ]
  // Build groups from the same value they present, so grantedIds stays
  // consistent with the presentation state under test.
  function groupFor(value: string[]): McpServiceGroup {
    const group = groupMcpServicesFromItems(fixtureItems, value, []).find((item) => item.serviceId === 'playwright')
    if (group === undefined) throw new Error('fixture group missing')
    return group
  }

  it('checking the service row grants every available tool once', () => {
    const next = mcpServiceToggle(groupFor(['mcp.playwright.browser_navigate']), ['mcp.playwright.browser_navigate'], true)
    expect(next).toContain('mcp.playwright.browser_navigate')
    expect(next).toContain('mcp.playwright.browser_snapshot')
    expect(next).not.toContain('mcp.playwright.browser_old')
    // Idempotent when every available tool is already held.
    const full = mcpServiceToggle(groupFor(['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot']), ['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot'], true)
    expect(full).toEqual(['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot'])
  })

  it('unchecking the service row revokes the whole service and keeps other services', () => {
    const next = mcpServiceToggle(groupFor(['mcp.playwright.browser_navigate']), ['mcp.playwright.browser_navigate', 'mcp.docs.search_docs'], false)
    expect(next).toEqual(['mcp.docs.search_docs'])
  })

  it('computes checked / indeterminate / partial presentation states', () => {
    expect(mcpServiceChecked(groupFor(['mcp.playwright.browser_navigate']), ['mcp.playwright.browser_navigate'])).toEqual({ checked: false, indeterminate: true })
    expect(mcpServiceChecked(groupFor(['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot']), ['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot'])).toEqual({ checked: true, indeterminate: false })
    expect(mcpServiceChecked(groupFor([]), [])).toEqual({ checked: false, indeterminate: false })
  })

  it('reports an unavailable service by the stale grants it still holds', () => {
    const dead = groupMcpServicesFromItems([], ['mcp.playwright.stale'], []).find((item) => item.serviceId === 'playwright')!
    expect(dead).toMatchObject({ tools: [], grantedIds: ['mcp.playwright.stale'], learnable: false, placement: 'unavailable' })
    expect(mcpServiceChecked(dead, ['mcp.playwright.stale'])).toEqual({ checked: true, indeterminate: false })
    expect(mcpServiceStatus(dead, ['mcp.playwright.stale'])).toBe('unavailable')
  })

  it('resolves the status ordering unavailable > granted > partial > recommended > learnable', () => {
    expect(mcpServiceStatus({ ...groupFor([]), recommended: true }, [])).toBe('recommended')
    expect(mcpServiceStatus(groupFor([]), [])).toBe('learnable')
    expect(mcpServiceStatus(groupFor(['mcp.playwright.browser_navigate']), ['mcp.playwright.browser_navigate'])).toBe('partial')
    expect(mcpServiceStatus(groupFor(['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot']), ['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot'])).toBe('granted')
  })
})

describe('toggleSkillIdInList', () => {
  it('adds with deduplication and removes', () => {
    expect(toggleSkillIdInList([], 'a', true)).toEqual(['a'])
    expect(toggleSkillIdInList(['a'], 'a', true)).toEqual(['a'])
    expect(toggleSkillIdInList(['a', 'b'], 'a', false)).toEqual(['b'])
  })
})

describe('SkillApprovalGroup (recruitment, service-level)', () => {
  const catalog: SkillCatalogEntry[] = [
    mcpCatalogEntry('playwright', '浏览器自动化', 'browser_navigate'),
    mcpCatalogEntry('playwright', '浏览器自动化', 'browser_snapshot'),
    catalogEntry({ id: 'code-review', displayName: '代码审查', source: 'builtin', adapterId: 'builtin.recipe', kind: 'recipe' }),
  ]
  const requested = ['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot', 'code-review']

  beforeEach(() => setUiLocale('zh-CN'))

  it('renders one aggregated MCP service row plus one flat row per non-MCP skill', () => {
    const html = renderToStaticMarkup(createElement(SkillApprovalGroup, {
      requested,
      descriptors: catalog,
      selected: [],
      onChange: vi.fn(),
    }))
    expect(html).toContain('MCP · 浏览器自动化')
    expect(html).toContain('代码审查')
    // No per-tool rows: each tool only appears inside the expandable list.
    expect(html.match(/MCP · 浏览器自动化/g)).toHaveLength(1)
    expect(html).not.toContain('MCP · 浏览器自动化 / browser_navigate')
    expect(html).toContain('2 个工具')
  })

  it('synthesizes a revocable unavailable row for held grants of a service that left the catalog', () => {
    const onChange = vi.fn()
    const html = renderToStaticMarkup(createElement(SkillApprovalGroup, {
      requested,
      descriptors: catalog,
      selected: ['mcp.dead.open_page'],
      onChange,
    }))
    expect(html).toContain('MCP · dead')
    expect(html).toContain('暂不可用')
    // The dead service row is checked and can be revoked; the available one is not.
    expect(html.match(/data-mcp-service="dead"/)).toHaveLength(1)
  })

  it('leaves services the template did not request out of the dialog', () => {
    const withDocs = [...catalog, mcpCatalogEntry('docs', '文档检索', 'search_docs')]
    const html = renderToStaticMarkup(createElement(SkillApprovalGroup, {
      requested,
      descriptors: withDocs,
      selected: [],
      onChange: vi.fn(),
    }))
    expect(html).not.toContain('MCP · 文档检索')
  })
})

describe('WorkshopSkillPicker (service-level requests)', () => {
  const skills: CharacterSkillDescriptor[] = [
    { id: 'mcp.playwright.browser_navigate', mcpService: { id: 'playwright', label: '浏览器自动化' }, displayName: 'MCP · 浏览器自动化 / browser_navigate', summary: '导航', adapterId: 'builtin.mcp', risks: ['external-side-effect'], supportsScheduling: false, persistentApproval: 'forbidden', kind: 'integration' },
    { id: 'mcp.playwright.browser_snapshot', mcpService: { id: 'playwright', label: '浏览器自动化' }, displayName: 'MCP · 浏览器自动化 / browser_snapshot', summary: '快照', adapterId: 'builtin.mcp', risks: ['external-side-effect'], supportsScheduling: false, persistentApproval: 'forbidden', kind: 'integration' },
    { id: 'code-review', displayName: '代码审查', summary: '审查', adapterId: 'builtin.recipe', risks: [], supportsScheduling: true, persistentApproval: 'forbidden', kind: 'recipe' },
  ]

  beforeEach(() => setUiLocale('zh-CN'))

  it('collapses the service tools into one row that requests the whole service', () => {
    const onChange = vi.fn()
    const html = renderToStaticMarkup(createElement(WorkshopSkillPicker, { skills, value: [], query: '', onChange }))
    expect(html).toContain('MCP · 浏览器自动化')
    expect(html).toContain('代码审查')
    const serviceCheckbox = /<input[^>]*aria-label="MCP 服务 浏览器自动化"[^>]*>/.exec(html)
    expect(serviceCheckbox).not.toBeNull()
  })

  it('keeps a dead service row revocable when requests outlive the catalog', () => {
    const html = renderToStaticMarkup(createElement(WorkshopSkillPicker, {
      skills,
      value: ['mcp.dead.open_page'],
      query: '',
      onChange: vi.fn(),
    }))
    expect(html).toContain('MCP · dead')
    expect(html).toContain('取消勾选可移除对应的技能请求')
  })

  it('filters both the service rows and the flat rows by the search query', () => {
    const html = renderToStaticMarkup(createElement(WorkshopSkillPicker, {
      skills,
      value: [],
      query: '代码审查',
      onChange: vi.fn(),
    }))
    expect(html).toContain('代码审查')
    expect(html).not.toContain('MCP · 浏览器自动化')
    expect(html).not.toContain('没有匹配的技能')
  })

  it('shows the empty state when nothing matches the query', () => {
    const html = renderToStaticMarkup(createElement(WorkshopSkillPicker, {
      skills,
      value: [],
      query: '不存在的技能',
      onChange: vi.fn(),
    }))
    expect(html).toContain('没有匹配的技能')
  })
})

describe('skillChipsForRole (project library, read-only)', () => {
  const skillNames = new Map<string, string>()
  const serviceLabels = new Map<string, string>([
    ['playwright', '浏览器自动化'],
    ['docs', '文档检索'],
  ])

  function chipsText(chips: ReactNode[]): string[] {
    return chips.map((chip) => {
      const element = chip as { props: { children?: unknown } }
      const children = Array.isArray(element.props.children) ? element.props.children : [element.props.children]
      return String(children).trim()
    })
  }

  it('aggregates a service into one chip and keeps single tools explicit', () => {
    const chips = skillChipsForRole(
      ['mcp.playwright.browser_navigate', 'mcp.playwright.browser_snapshot', 'mcp.docs.search_docs', 'code-review'],
      new Map([['code-review', '代码审查']]),
      serviceLabels,
    )
    expect(chipsText(chips)).toEqual([
      '代码审查',
      'MCP · 文档检索 / search_docs',
      'MCP · 浏览器自动化（2 个工具）',
    ])
  })

  it('falls back to the raw id when neither name nor service label is known', () => {
    const chips = skillChipsForRole(['mcp.ghost.open_page'], new Map<string, string>(), new Map<string, string>())
    expect(chipsText(chips)).toEqual(['MCP · ghost / open_page'])
  })

  it('treats legacy two-segment ids as plain chips', () => {
    const chips = skillChipsForRole(['mcp.browser_navigate'], skillNames, serviceLabels)
    expect(chipsText(chips)).toEqual(['mcp.browser_navigate'])
  })
})
