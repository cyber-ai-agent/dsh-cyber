import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'
import type { WorkshopProjectView } from '@dsh-cyber/contracts/creative-platform'

import { ApiError } from '../src/api.js'
import { CreativeWorkshopProjectLibrary } from '../src/components/creative-workshop/CreativeWorkshopProjectLibrary.js'
import { WorldDeleteConfirmDialog, WorldLibraryDialog } from '../src/components/WorldLibraryDialog.js'
import { setUiLocale } from '../src/i18n/runtime.js'
import '../src/i18n/world-library-messages.js'
import '../src/i18n/workshop-messages.js'

const activeWorld: World = {
  id: 'world-active-1',
  workspaceId: 'workspace-1',
  name: '夜航工作室',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

const archivedWorld: World = {
  ...activeWorld,
  id: 'world-archived-1',
  name: '旧的实验世界',
  status: 'archived',
}

function makeProject(overrides: Partial<WorkshopProjectView>): WorkshopProjectView {
  return {
    schemaVersion: 1,
    id: 'project-1',
    workspaceId: 'workspace-1',
    worldId: 'world-active-1',
    displayName: '夜航工作室项目',
    baseTemplateId: 'personal-world',
    scenario: '独立游戏开发工作室',
    lore: '',
    roles: [],
    generatedPackageIds: [],
    status: 'active',
    worldLinked: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(element) })
  return { host, root }
}

function buttonNamed(host: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(label))
}

/**
 * Types into a controlled input the way a person does. React tracks the last
 * value it wrote, so assigning `input.value` directly is silently ignored;
 * going through the native setter is what makes the change event real.
 */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Row actions only, so a tab named 归档世界 never stands in for the 归档 action. */
function rowAction(host: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('.world-library-item__actions button')]
    .find((button) => button.textContent?.trim() === label)
}

beforeEach(() => setUiLocale('zh-CN'))

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('permanent world deletion gate', () => {
  it('cannot submit until the typed name matches the world exactly', async () => {
    const onConfirm = vi.fn(async () => undefined)
    const { host, root } = await mount(createElement(WorldDeleteConfirmDialog, {
      world: activeWorld,
      onCancel: () => undefined,
      onConfirm,
    }))

    const form = host.querySelector('form')!
    const input = host.querySelector('input')!
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    expect(host.textContent).toContain('名称还不一致，完全一致后才能删除。')

    // A near miss is still a miss: trailing characters and prefixes stay locked.
    for (const attempt of ['夜航', '夜航工作室 2', '夜航工作室x']) {
      await type(input, attempt)
      expect(submit.disabled).toBe(true)
      await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
      expect(onConfirm).not.toHaveBeenCalled()
    }

    await type(input, '夜航工作室')
    expect(submit.disabled).toBe(false)
    expect(host.textContent).toContain('名称一致，可以永久删除。')
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith('夜航工作室')

    await act(async () => { root.unmount() })
  })

  it('explains the still-running conflict instead of reporting a generic failure', async () => {
    const { host, root } = await mount(createElement(WorldDeleteConfirmDialog, {
      world: activeWorld,
      onCancel: () => undefined,
      onConfirm: async () => {
        throw new ApiError(409, '这个世界还有 1 个进行中的任务轮次。', 'world_has_active_work')
      },
    }))
    const input = host.querySelector('input')!
    await type(input, activeWorld.name)
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('进行中的任务或角色运行')
    expect(alert?.textContent).toContain('等它们结束后再试')
    expect(alert?.textContent).not.toContain('请求失败')
    await act(async () => { root.unmount() })
  })
})

describe('world library views', () => {
  it('opens on the active list and reads archived worlds only in the archive view', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      requested.push(String(input))
      const archived = String(input).includes('status=archived')
      return new Response(JSON.stringify({ items: archived ? [archivedWorld] : [activeWorld] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const { host, root } = await mount(createElement(WorldLibraryDialog, {
      workspaceId: 'workspace-1',
      activeWorldId: activeWorld.id,
      onClose: () => undefined,
      onChanged: () => undefined,
    }))

    expect(requested).toEqual(['/api/workspaces/workspace-1/worlds?status=active'])
    expect(host.textContent).toContain('夜航工作室')
    expect(host.textContent).not.toContain('旧的实验世界')
    expect(rowAction(host, '归档')).toBeDefined()
    expect(rowAction(host, '恢复')).toBeUndefined()
    expect(rowAction(host, '永久删除')).toBeUndefined()

    await act(async () => { buttonNamed(host, '归档世界')!.click() })
    expect(requested.at(-1)).toBe('/api/workspaces/workspace-1/worlds?status=archived')
    expect(host.textContent).toContain('旧的实验世界')
    expect(host.textContent).not.toContain('夜航工作室')
    expect(rowAction(host, '恢复')).toBeDefined()
    expect(rowAction(host, '永久删除')).toBeDefined()
    expect(rowAction(host, '归档')).toBeUndefined()

    await act(async () => { root.unmount() })
  })
})

describe('creative workshop entry', () => {
  it('opens the creation hub even when local projects already exist', async () => {
    const onCreate = vi.fn()
    const { host, root } = await mount(createElement(CreativeWorkshopProjectLibrary, {
      projects: [makeProject({})],
      skills: [],
      onSelect: () => undefined,
      onCreate,
      onDuplicate: () => undefined,
      onOpenWorld: () => undefined,
      onArchive: () => undefined,
      onRestore: () => undefined,
      onDelete: () => undefined,
    }))

    expect(host.textContent).toContain('打造专属的赛博智能体世界')
    expect(host.textContent).not.toContain('我的本地项目')
    await act(async () => { buttonNamed(host, '新建空白世界')?.click() })
    expect(onCreate).toHaveBeenCalledOnce()
    await act(async () => { root.unmount() })
  })
})
