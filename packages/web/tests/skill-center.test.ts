import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeInstance, World } from '@dsh-cyber/contracts'

import { SkillCenterDialog } from '../src/features/skill-center/SkillCenterDialog.js'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

describe('SkillCenterDialog', () => {
  it('shows world skill dependencies and writes character references through revisions', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); calls.push({ path, ...(init === undefined ? {} : { init }) })
      if (path.endsWith('/skill-catalog')) return json({ items: [skill('coding', true), skill('web.search.firecrawl', false, 'official-firecrawl-search')] })
      if (path.endsWith('/packages')) return json({ items: [] })
      if (path.endsWith('/snapshot')) return json({ dossiers: [{ employee, revisions: [revision], skills: [], evidence: [], milestones: [], journals: [], relationships: [] }] })
      if (path.includes('/revisions')) return json({ revision: { ...revision, revision: 2, skillGrants: ['coding'] } }, 201)
      if (path.endsWith('/packages/instantiate')) return json({ instance: {} }, 201)
      throw new Error(`unexpected request: ${path}`)
    }))
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(SkillCenterDialog, { world, employees: [employee], onClose: vi.fn() })) })
    await flush()

    expect(document.body.textContent).toContain('技能中心')
    expect(document.body.textContent).toContain('技能定义保持单份')
    expect(document.body.textContent).toContain('软件实现')
    expect(document.body.textContent).toContain('联网搜索')
    const roleCheckbox = Array.from(document.body.querySelectorAll('label')).find((label) => label.textContent?.includes('管家'))?.querySelector<HTMLInputElement>('input')
    expect(roleCheckbox).toBeDefined()
    await act(async () => { roleCheckbox?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(calls.some((call) => call.path.includes(`/api/employees/${employee.id}/revisions`) && String(call.init?.body).includes('"coding"'))).toBe(true)

    const loadButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('加载到当前世界'))
    await act(async () => { loadButton?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(calls.some((call) => call.path.endsWith('/packages/instantiate') && String(call.init?.body).includes('official-firecrawl-search'))).toBe(true)
    await act(async () => { root.unmount() })
  })
})

const world = { id: 'world-1', workspaceId: 'workspace-1', name: '测试世界', templateId: 'personal-world', status: 'active', createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' } as World
const employee = { id: 'employee-1', workspaceId: world.workspaceId, worldId: world.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName: '管家', role: '世界管家', status: 'available', presence: 'available', health: 'healthy', currentRevision: 1, createdAt: world.createdAt, updatedAt: world.updatedAt } as EmployeeInstance
const revision = { employeeId: employee.id, revision: 1, persona: '管家', skillGrants: [], capabilityGrants: [], connectionGrants: [], modelPolicy: {}, runtimePermissionMode: 'read-only', reason: 'test', createdAt: world.createdAt }

function skill(id: string, available: boolean, packageId?: string) {
  return { id, displayName: id === 'coding' ? '软件实现' : '联网搜索', summary: '技能说明', adapterId: 'test', risks: [], supportsScheduling: false, persistentApproval: 'forbidden', kind: id === 'coding' ? 'recipe' : 'integration', recommendedByDefault: false, source: packageId === undefined ? 'builtin' : 'plugin', scope: packageId === undefined ? 'builtin' : 'world', globalKnown: true, worldAvailable: available, availability: available ? 'available' : 'unavailable', ...(packageId === undefined ? {} : { packageId, packageVersion: '1.0.0' }) }
}

function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
async function flush(): Promise<void> { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) }) }
