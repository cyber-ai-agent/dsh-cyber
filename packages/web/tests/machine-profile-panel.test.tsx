import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EnvironmentProfile } from '@dsh-cyber/contracts'

import { MachineProfilePanel } from '../src/features/machine-profile/MachineProfilePanel.js'
import { setUiLocale } from '../src/i18n/runtime.js'
import '../src/i18n/machine-profile-messages.js'

// The panel reports host facts; assert it in the locale that copy ships in.
setUiLocale('zh-CN')

afterEach(() => {
  vi.unstubAllGlobals()
})

function profile(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
  return {
    schemaVersion: 1,
    profileId: 'local',
    os: 'windows',
    arch: 'x64',
    shell: 'powershell',
    tools: {
      node: { present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z', version: 'v20.11.1' },
      ffmpeg: { present: false, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z' },
    },
    notes: [{ id: 'n1', text: 'docker 在本机不可用：命令未找到', source: 'failure-signature', createdAt: '2026-08-21T00:00:00.000Z' }],
    probedAt: '2026-08-21T00:00:00.000Z',
    fastSignature: 'a'.repeat(32),
    fullDirty: false,
    ...overrides,
  }
}

interface Recorded {
  method: string
  url: string
}

function stubFetch(handler: (call: Recorded) => { status?: number; body: unknown }) {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
    const call: Recorded = { method: init?.method ?? 'GET', url: String(input) }
    calls.push(call)
    const result = handler(call)
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
  return calls
}

async function renderPanel(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(MachineProfilePanel))
  })
  await vi.waitFor(() => { expect(host.textContent).not.toContain('正在读取机器档案') })
  return host
}

describe('MachineProfilePanel', () => {
  it('shows the host facts with one read, and never claims a tool it did not probe', async () => {
    const calls = stubFetch(() => ({ body: { profile: profile() } }))
    const host = await renderPanel()

    expect(calls).toEqual([{ method: 'GET', url: '/api/environments/local' }])
    expect(host.textContent).toContain('Windows x64 · shell: powershell')
    expect(host.textContent).toContain('已安装')
    expect(host.textContent).toContain('node')
    expect(host.textContent).toContain('v20.11.1')
    expect(host.textContent).toContain('未安装')
    expect(host.textContent).toContain('ffmpeg')
    expect(host.textContent).toContain('docker 在本机不可用：命令未找到')
    // The promise the injected layer makes must be visible to the owner.
    expect(host.textContent).toContain('档案在会话开始时固定')
  })

  it('offers a refresh that runs the full probe and re-renders the result', async () => {
    let refreshed = false
    const calls = stubFetch((call) => {
      if (call.url.endsWith('/refresh')) {
        refreshed = true
        return { body: { profile: profile({ tools: { node: { present: true, source: 'builtin', lastCheckedAt: '', version: 'v24.18.0' } } }) } }
      }
      return { body: { profile: refreshed ? profile() : profile() } }
    })
    const host = await renderPanel()

    const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes('刷新档案'))
    expect(button).toBeDefined()
    await act(async () => { button!.click() })

    await vi.waitFor(() => { expect(host.textContent).toContain('v24.18.0') })
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/environments/local/refresh')).toBe(true)
  })

  it('adds an owner-declared CLI by name and removes it again', async () => {
    let tools = profile().tools
    const calls = stubFetch((call) => {
      if (call.method === 'POST') {
        tools = { ...tools, mytool: { present: true, source: 'custom', lastCheckedAt: '', version: '1.2.3' } }
      }
      if (call.method === 'DELETE') {
        const { mytool: _removed, ...rest } = tools
        tools = rest
      }
      return { body: { profile: profile({ tools }) } }
    })
    const host = await renderPanel()

    const form = host.querySelector('form')
    const input = host.querySelector('input')
    expect(form).not.toBeNull()
    expect(input).not.toBeNull()
    // React's value tracker ignores a plain `value =` assignment, so type
    // through the native setter exactly like a real keystroke would.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'mytool')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // The visible 添加 button submits this form; dispatch the submit the
    // button produces so the assertion covers the real handler.
    await act(async () => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

    await vi.waitFor(() => { expect(host.textContent).toContain('mytool') })
    expect(host.textContent).toContain('1.2.3')
    expect(host.textContent).toContain('自定义')
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/environments/local/tools')).toBe(true)

    const removeButton = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes('移除'))
    await act(async () => { removeButton!.click() })
    await vi.waitFor(() => { expect(host.textContent).not.toContain('mytool') })
    expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/environments/local/tools/mytool')).toBe(true)
  })

  it('invites a first probe when no profile exists yet', async () => {
    stubFetch(() => ({ body: { profile: null } }))
    const host = await renderPanel()
    expect(host.textContent).toContain('还没有生成机器档案')
    // The empty state still offers the one action that can fix it.
    expect([...host.querySelectorAll('button')].some((entry) => entry.textContent?.includes('刷新档案'))).toBe(true)
  })

  it('describes one connected device from its own route, without owner-editable names', async () => {
    const calls = stubFetch(() => ({ body: { profile: profile({ profileId: 'ssh:device-1', os: 'linux', shell: 'bash' }) } }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(MachineProfilePanel, {
        scope: { workspaceId: 'workspace-1', integrationId: 'builtin.ssh-device', connectionId: 'device-1' },
      }))
    })
    await vi.waitFor(() => { expect(host.textContent).not.toContain('正在读取机器档案') })

    expect(calls[0]?.url).toBe('/api/workspaces/workspace-1/integrations/builtin.ssh-device/connections/device-1/environment')
    expect(host.textContent).toContain('Linux x64 · shell: bash')
    // A device profile is probed, not edited: no custom-name form.
    expect(host.querySelector('form')).toBeNull()
    expect(host.textContent).not.toContain('自定义命令行工具')
  })
})
