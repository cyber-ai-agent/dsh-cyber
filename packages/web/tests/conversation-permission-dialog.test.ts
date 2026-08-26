import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationPermissionControl } from '../src/components/ConversationPermissionControl.js'

describe('ConversationPermissionControl', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('keeps operation permission in the composer menu', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onChange = vi.fn()
    const onRequestFullAccess = vi.fn()

    await act(async () => { root.render(createElement(ConversationPermissionControl, { value: 'workspace-write', onChange, onRequestFullAccess })) })
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="当前消息权限"]')
    expect(trigger).toBeDefined()
    await act(async () => { trigger?.click() })

    expect(host.textContent).toContain('请求批准')
    expect(host.textContent).toContain('帮我批准')
    expect(host.textContent).toContain('完全访问')
    expect(host.textContent).not.toContain('DSH 操作权限')
    expect(host.textContent).not.toContain('DSH')
    expect(host.textContent).not.toContain('本次电脑访问')
    expect(host.textContent).not.toContain('角色操作权限')

    const fullAccessButton = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes('完全访问'))
    expect(fullAccessButton).toBeDefined()
    await act(async () => { fullAccessButton?.click() })
    expect(onRequestFullAccess).toHaveBeenCalledOnce()

    await act(async () => { trigger?.click() })
    const askButton = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.includes('请求批准'))
    expect(askButton).toBeDefined()
    await act(async () => { askButton?.click() })
    expect(onChange).toHaveBeenCalledWith('read-only')
    await act(async () => { root.render(createElement(ConversationPermissionControl, { value: 'danger-full-access', onChange, onRequestFullAccess })) })
    expect(host.querySelector('[aria-label="当前消息权限"]')?.textContent).toContain('完全访问')
    await act(async () => { root.unmount() })
  })
})
