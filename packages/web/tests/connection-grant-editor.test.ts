import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeInstance, IntegrationConnection, IntegrationDescriptor } from '@dsh-cyber/contracts'

import { ConnectionGrantEditor } from '../src/components/ConnectionGrantEditor.js'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

describe('ConnectionGrantEditor', () => {
  it('groups every connection category and supports selecting all concrete children', async () => {
    const descriptors: IntegrationDescriptor[] = [descriptor('builtin.web-search', '联网搜索'), descriptor('builtin.ssh-device', '设备连接')]
    const items: IntegrationConnection[] = [connection('firecrawl-1', 'builtin.firecrawl', 'Firecrawl'), connection('device-1', 'builtin.ssh-device', '办公室主机')]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ descriptors, items }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const onChange = vi.fn()
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(ConnectionGrantEditor, { employee, value: [], onChange })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(host.textContent).toContain('全部连接')
    expect(host.textContent).toContain('联网搜索')
    expect(host.textContent).toContain('设备连接')
    expect(host.textContent).toContain('Firecrawl')
    expect(host.textContent).toContain('办公室主机')
    const all = Array.from(host.querySelectorAll('label')).find((label) => label.textContent?.includes('全部连接'))?.querySelector<HTMLInputElement>('input')
    await act(async () => { all?.click() })
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining(['firecrawl-1', 'device-1']))
    await act(async () => { root.unmount() })
  })

  it('derives the required connection category from the granted Skill dependency', async () => {
    const descriptors: IntegrationDescriptor[] = [descriptor('builtin.web-search', '联网搜索'), descriptor('builtin.ssh-device', '设备连接')]
    const items: IntegrationConnection[] = [connection('firecrawl-1', 'builtin.firecrawl', 'Firecrawl')]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.endsWith('/skill-catalog')
        ? { items: [{ id: 'web.search.firecrawl', displayName: '联网搜索', summary: '联网搜索', adapterId: 'builtin.firecrawl', risks: ['external-side-effect'], supportsScheduling: false, persistentApproval: 'forbidden', kind: 'integration', source: 'plugin', scope: 'workspace', globalKnown: true, worldAvailable: true, availability: 'available', dependencies: [{ kind: 'integration', id: 'builtin.firecrawl', required: true }] }] }
        : { descriptors, items }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(ConnectionGrantEditor, { employee, value: [], skillIds: ['web.search.firecrawl'], onChange: vi.fn() })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(host.textContent).toContain('当前 Skill 需要的连接设置')
    expect(host.textContent).toContain('联网搜索')
    expect(host.querySelector('.connection-grant-type.is-required')).not.toBeNull()
    await act(async () => { root.unmount() })
  })
})

const employee = { id: 'employee-1', workspaceId: 'workspace-1', worldId: 'world-1', blueprintId: 'core.butler', blueprintVersion: 1, displayName: '管家', role: '世界管家', status: 'available', presence: 'available', health: 'healthy', currentRevision: 1, createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' } as EmployeeInstance
function descriptor(id: string, displayName: string): IntegrationDescriptor { return { id, displayName, summary: `${displayName}说明`, configFields: [], secretFields: [], skillIds: [], dataEgress: [], allowsMultipleConnections: true } }
function connection(id: string, integrationId: string, displayName: string): IntegrationConnection { return { id, workspaceId: employee.workspaceId, integrationId, displayName, config: {}, enabled: true, credentialConfigured: true, createdAt: employee.createdAt, updatedAt: employee.updatedAt } }
