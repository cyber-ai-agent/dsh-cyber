import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '../src/api.js'
import { ApplicationLockGate } from '../src/components/ApplicationLockGate.js'

vi.mock('../src/api.js', () => ({ api: vi.fn() }))

const apiMock = vi.mocked(api)

afterEach(() => {
  document.body.replaceChildren()
  apiMock.mockReset()
})

describe('ApplicationLockGate', () => {
  it('offers recovery-code reset from the locked entry screen', async () => {
    apiMock.mockResolvedValue({ access: { passwordEnabled: true, unlocked: false, recoveryConfigured: true } })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    await act(async () => { root.render(createElement(ApplicationLockGate, { children: createElement('div', null, '工作台内容') })) })
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toContain('忘记密码？使用恢复码')
    expect(host.textContent).not.toContain('工作台内容')

    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('忘记密码'))?.click()
    })
    expect(host.textContent).toContain('使用恢复码设置新的应用密码')
    expect(host.querySelector('input[autocomplete="one-time-code"]')).toBeTruthy()
    expect(host.textContent).toContain('重置密码并进入')

    await act(async () => { root.unmount() })
  })
})
