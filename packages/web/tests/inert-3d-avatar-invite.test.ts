import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'
import { CharacterAvatarManager } from '../src/components/CharacterAvatarManager.js'
import { EmployeeFocusMode } from '../src/features/world/avatar/focus/EmployeeFocusMode.js'
import { writeWorldExtensionEnabled } from '../src/features/world/extensions/world-extension-preference.js'
import type { CyberEmployee } from '../src/types.js'

vi.mock('../src/features/world/avatar/avatar-creation-provider.js', () => ({
  LOCAL_PROCEDURAL_AVATAR_PROVIDER_ID: 'dsh.local-procedural-vrm-v1',
  avatarCreationProviders: { require: () => ({ create: vi.fn() }) },
}))

beforeEach(() => localStorage.clear())
afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
})

/**
 * The core 2D world always draws the sprite renderer, so a VRM published while
 * the spatial 3D extension is off is invisible everywhere the character shows
 * up. Offering to build one is then a promise the product cannot keep.
 */
describe('3D avatar invite follows the spatial 3D extension', () => {
  it('hides the focus-panel invite while the extension is off', async () => {
    const host = await renderFocusMode(false)
    expect(host.textContent).not.toContain('创建 3D 形象')
    expect(host.textContent).not.toContain('还没有 3D 形象')
  })

  it('shows the focus-panel invite once the extension is on', async () => {
    writeWorldExtensionEnabled('spatial-3d', true)
    const host = await renderFocusMode(true)
    expect(host.textContent).toContain('创建 3D 形象')
    expect(host.textContent).toContain('还没有 3D 形象')
  })

  it('hides the avatar-manager creation entry point while the extension is off', async () => {
    const host = await renderAvatarManager()
    expect(labels(host)).not.toContain('创建 3D 形象')
    expect(host.querySelector('[aria-controls="character-avatar-creator"]')).toBe(null)
    // The 2D upload path is untouched by the gate.
    expect(host.querySelector('input[type="file"]')).not.toBe(null)
  })

  it('shows the avatar-manager creation entry point once the extension is on', async () => {
    writeWorldExtensionEnabled('spatial-3d', true)
    const host = await renderAvatarManager()
    expect(labels(host)).toContain('创建 3D 形象')
    expect(host.querySelector('[aria-controls="character-avatar-creator"]')).not.toBe(null)
  })

  it('never promises 3D in the avatar manager while the extension is off', async () => {
    const host = await renderAvatarManager()
    expect(host.textContent).not.toContain('3D')
    expect(host.textContent).not.toContain('VRM')
  })
})

async function renderFocusMode(spatial3dEnabled: boolean): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(EmployeeFocusMode, {
      world: { id: 'world', name: '默认世界' } as World,
      employee: employee(),
      collaborators: [],
      connected: true,
      staticMode: true,
      rendererMode: '2d' as const,
      embedded: false,
      spatial3dEnabled,
      onFocusEmployee: vi.fn(),
      onManageAvatar: vi.fn(),
      onStaticModeChange: vi.fn(),
      onVoiceFinal: vi.fn().mockResolvedValue(undefined),
    }))
  })
  return host
}

async function renderAvatarManager(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(CharacterAvatarManager, {
      employeeName: '测试角色',
      profileHistory: [],
      fallbackAvatarIndex: 0,
      busy: false,
      onFallbackAvatarChange: vi.fn(),
      onUpload: vi.fn(),
      onPublish: vi.fn(),
      onRollback: vi.fn(),
      onReset: vi.fn(),
    }))
  })
  return host
}

function labels(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('button')).map((button) => button.textContent ?? '')
}

function employee(): CyberEmployee {
  return {
    id: 'employee', displayName: '测试角色', role: '研究员', avatarIndex: 0,
  } as CyberEmployee
}
