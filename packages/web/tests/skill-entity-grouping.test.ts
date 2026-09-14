import { describe, expect, it } from 'vitest'
import type { SkillCatalogEntry } from '@dsh-cyber/contracts'

import {
  groupSkillCatalog,
  skillEntitySelectionState,
  toggleSkillEntity,
} from '../src/components/skill-entity-grouping.js'

describe('Skill entity grouping', () => {
  const items: SkillCatalogEntry[] = [
    entry('mcp.playwright.browser_click', '点击', {
      mcpService: { id: 'playwright', label: 'Playwright MCP' },
    }),
    entry('mcp.playwright.browser_navigate', '打开网页', {
      mcpService: { id: 'playwright', label: 'Playwright MCP' },
    }),
    entry('browser.open', '浏览器打开网页', {
      packageId: 'official-browser',
      packageVersion: '1.0.1',
      skillPackage: { id: 'official-browser', version: '1.0.1', displayName: '只读网页浏览', summary: '浏览器能力包。' },
    }),
    entry('browser.read', '浏览器读取网页', {
      packageId: 'official-browser',
      packageVersion: '1.0.1',
      skillPackage: { id: 'official-browser', version: '1.0.1', displayName: '只读网页浏览', summary: '浏览器能力包。' },
    }),
  ]

  it('collapses one MCP service and one multi-entry Skill package into two rows', () => {
    const groups = groupSkillCatalog(items)
    expect(groups).toHaveLength(2)
    expect(groups.find((group) => group.kind === 'mcp-service')).toMatchObject({
      displayName: 'MCP · Playwright MCP',
      memberIds: ['mcp.playwright.browser_click', 'mcp.playwright.browser_navigate'],
    })
    expect(groups.find((group) => group.kind === 'skill-package')).toMatchObject({
      displayName: '只读网页浏览',
      memberIds: ['browser.open', 'browser.read'],
    })
  })

  it('maps one row selection back to every available exact id', () => {
    const group = groupSkillCatalog(items).find((item) => item.kind === 'mcp-service')!
    expect(toggleSkillEntity(group, [], true)).toEqual([
      'mcp.playwright.browser_click',
      'mcp.playwright.browser_navigate',
    ])
    expect(skillEntitySelectionState(group, ['mcp.playwright.browser_click'])).toMatchObject({ checked: false, indeterminate: true, selectedCount: 1 })
    expect(toggleSkillEntity(group, ['mcp.playwright.browser_click', 'mcp.playwright.browser_navigate'], false)).toEqual([])
  })
})

function entry(id: string, displayName: string, extra: Partial<SkillCatalogEntry>): SkillCatalogEntry {
  return {
    id,
    displayName,
    summary: `${displayName}说明`,
    adapterId: 'test-adapter',
    risks: [],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    kind: 'integration',
    source: extra.mcpService === undefined && extra.packageId === undefined ? 'other' : extra.mcpService === undefined ? 'plugin' : 'mcp',
    scope: 'workspace',
    globalKnown: true,
    worldAvailable: true,
    availability: 'available',
    ...extra,
  }
}
