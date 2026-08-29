import { createElement, useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'

import { WorldSideDock } from '../src/components/WorldSideDock.js'
import type { DockTab } from '../src/types.js'

afterEach(() => {
  document.body.replaceChildren()
  window.localStorage.clear()
})

describe('WorldSideDock dynamic tabs', () => {
  it('shows only the active More item while remembering recent surfaces per World', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let root = createRoot(host)
    await act(async () => { root.render(createElement(Harness, { world: world('world-a') })) })

    expect(tabLabels(host)).toEqual(['世界', '轨迹'])
    await click(host, '更多')
    expect(Array.from(host.querySelectorAll('[role="menuitemcheckbox"]')).map((item) => item.textContent)).toEqual(['角色', '任务', '知识', '产物', '日程'])
    await click(host, '角色')
    expect(tabLabels(host)).toEqual(['世界', '轨迹', '角色'])
    await click(host, '更多')
    await click(host, '日程')
    expect(tabLabels(host)).toEqual(['世界', '轨迹', '日程'])
    await click(host, '关闭日程页签')
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label')).toBe('角色')
    expect(tabLabels(host)).toEqual(['世界', '轨迹', '角色'])
    expect(JSON.parse(window.localStorage.getItem('dsh-cyber:world-dock-tabs:world-a') ?? '[]')).toEqual(['dossier'])

    await act(async () => { root.unmount() })
    root = createRoot(host)
    await act(async () => { root.render(createElement(Harness, { world: world('world-a') })) })
    expect(tabLabels(host)).toEqual(['世界', '轨迹'])
    await click(host, '更多')
    expect(host.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.textContent).toContain('角色')

    await act(async () => { root.render(createElement(Harness, { key: 'world-b', world: world('world-b') })) })
    expect(tabLabels(host)).toEqual(['世界', '轨迹'])
    await act(async () => { root.unmount() })
  })
})

function Harness({ world: value }: { world: World }) {
  const [activeTab, setActiveTab] = useState<DockTab>('world')
  return createElement(WorldSideDock, {
    demoMode: false,
    activeTab,
    dossiers: {},
    employees: [],
    world: value,
    worldContent: createElement('div', {}, '世界内容'),
    traceContent: createElement('div', {}, '轨迹内容'),
    scheduleContent: createElement('div', {}, '日程内容'),
    onTabChange: setActiveTab,
    onCollapse: vi.fn(),
    onSelectEmployee: vi.fn(),
    onDirectEmployee: vi.fn(),
    onManageEmployee: vi.fn(),
    onShowAllDossiers: vi.fn(),
    onInvite: vi.fn(),
  })
}

async function click(host: HTMLElement, label: string): Promise<void> {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.getAttribute('aria-label') === label || item.textContent === label)
  expect(button, `missing button ${label}`).toBeDefined()
  await act(async () => { button?.click() })
}

function tabLabels(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('[role="tab"]')).map((item) => item.getAttribute('aria-label') ?? '')
}

function world(id: string): World {
  return {
    id,
    workspaceId: 'workspace-dock-tabs',
    name: id,
    templateId: 'personal-world',
    status: 'active',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  }
}
