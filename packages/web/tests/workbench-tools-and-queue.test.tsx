import { act, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchToolsMenu } from '../src/components/WorkbenchToolsMenu.js'
import { ChatQueuePanel } from '../src/components/ChatQueuePanel.js'

afterEach(() => document.body.replaceChildren())

function Launcher() {
  const [open, setOpen] = useState(false)
  return <><button type="button" onClick={() => setOpen(true)}>配置模型</button>{open ? createPortal(<section role="dialog" aria-label="角色模型设置"><button onClick={() => setOpen(false)}>关闭配置</button></section>, document.body) : null}</>
}

it('keeps a launched settings dialog open when the tools panel closes', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  await act(async () => root.render(<WorkbenchToolsMenu><Launcher /></WorkbenchToolsMenu>))
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="工具"]')!.click())
  expect(host.querySelector<HTMLElement>('.workbench-tools__panel')!.hidden).toBe(false)
  await act(async () => host.querySelector<HTMLButtonElement>('.workbench-tools__panel button')!.click())
  expect(host.querySelector<HTMLElement>('.workbench-tools__panel')!.hidden).toBe(true)
  expect(document.querySelector('[aria-label="角色模型设置"]')).not.toBeNull()
  await act(async () => root.unmount())
})

it('opens real queue controls and acts on the selected queued turn', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const promote = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  await act(async () => root.render(<ChatQueuePanel turns={[{ id: 'follow-up', worldId: 'world', queueKey: 'direct:role', employeeIds: ['role'], title: '补充要求', status: 'queued', createdAt: new Date(0).toISOString() }]} running saturated={false} onPromote={promote} onCancel={cancel} />))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click())
  const priority = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === '优先处理')!
  await act(async () => priority.click())
  expect(promote).toHaveBeenCalledExactlyOnceWith('follow-up')
  expect(cancel).not.toHaveBeenCalled()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => root.unmount())
})
