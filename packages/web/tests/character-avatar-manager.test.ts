import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CharacterAvatarAsset, LocalAsset } from '@dsh-cyber/contracts'
import { CharacterAvatarManager, type UploadedAvatarDraft } from '../src/components/CharacterAvatarManager.js'
import { writeWorldExtensionEnabled } from '../src/features/world/extensions/world-extension-preference.js'

const providerCreate = vi.hoisted(() => vi.fn())

vi.mock('../src/features/world/avatar/avatar-creation-provider.js', () => ({
  LOCAL_PROCEDURAL_AVATAR_PROVIDER_ID: 'dsh.local-procedural-vrm-v1',
  avatarCreationProviders: { require: () => ({ create: providerCreate }) },
}))

afterEach(() => {
  document.body.replaceChildren()
  providerCreate.mockReset()
  localStorage.clear()
})

describe('CharacterAvatarManager', () => {
  it('keeps a draft and focuses an inline alert when publishing fails', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onPublish = vi.fn().mockRejectedValue(new Error('角色资料已更新，请重试'))
    const draft = avatarDraft()

    await act(async () => {
      root.render(createElement(CharacterAvatarManager, {
        employeeName: '测试角色',
        profileHistory: [],
        fallbackAvatarIndex: 0,
        busy: false,
        onFallbackAvatarChange: vi.fn(),
        onUpload: vi.fn().mockResolvedValue(draft),
        onPublish,
        onRollback: vi.fn(),
        onReset: vi.fn(),
      }))
    })
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'portrait.png', { type: 'image/png' })] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    const publish = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '发布到角色')!

    await act(async () => {
      publish.click()
      await Promise.resolve()
    })

    const alert = host.querySelector<HTMLElement>('[role="alert"]')
    expect(onPublish).toHaveBeenCalledWith('asset', 0, 0)
    expect(alert?.textContent).toContain('角色资料已更新，请重试')
    expect(document.activeElement).toBe(alert)
    expect(host.textContent).toContain('尚未发布')

    await act(async () => { root.unmount() })
  })

  it('does not let a cancelled generation clear the state of a newer run', async () => {
    // The 3D creator only exists while the optional spatial 3D extension is on.
    writeWorldExtensionEnabled('spatial-3d', true)
    const first = deferred<{ file: File; providerId: string; source: 'local' }>()
    const second = deferred<{ file: File; providerId: string; source: 'local' }>()
    providerCreate.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const onUpload = vi.fn().mockResolvedValue(avatarDraft())
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(createElement(CharacterAvatarManager, {
        employeeName: '测试角色', profileHistory: [], fallbackAvatarIndex: 0, busy: false,
        onFallbackAvatarChange: vi.fn(), onUpload, onPublish: vi.fn(), onRollback: vi.fn(), onReset: vi.fn(),
      }))
    })
    await act(async () => { button(host, '创建 3D 形象').click() })
    await act(async () => { button(host, '生成 3D 预览').click(); await Promise.resolve() })
    await act(async () => { button(host, '取消生成').click() })
    await act(async () => { button(host, '创建 3D 形象').click() })
    await act(async () => { button(host, '生成 3D 预览').click(); await Promise.resolve() })

    await act(async () => {
      first.resolve({ file: new File(['first'], 'first.vrm'), providerId: 'local', source: 'local' })
      await Promise.resolve()
    })
    expect(host.textContent).toContain('取消生成')
    expect(host.textContent).toContain('正在本机生成')

    await act(async () => {
      second.resolve({ file: new File(['second'], 'second.vrm'), providerId: 'local', source: 'local' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onUpload).toHaveBeenCalledWith(expect.objectContaining({ name: 'second.vrm' }), expect.any(AbortSignal))
    expect(host.textContent).toContain('尚未发布')

    await act(async () => { root.unmount() })
  })
})

function button(host: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent === label)!
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function avatarDraft(): UploadedAvatarDraft {
  const asset: LocalAsset = {
    id: 'asset', workspaceId: 'workspace', kind: 'avatar', mimeType: 'image/png', sha256: '0'.repeat(64),
    relativePath: 'workspace/avatars/asset.png', byteLength: 5, createdAt: '2026-08-31T00:00:00.000Z',
  }
  const avatarAsset: CharacterAvatarAsset = {
    assetId: asset.id, workspaceId: asset.workspaceId, worldId: 'world', employeeId: 'employee', rendererKind: 'image-2d',
    originalName: 'portrait.png', validation: { signatureVerified: true }, createdAt: asset.createdAt,
  }
  return { asset, avatarAsset, url: 'data:image/png;base64,aW1hZ2U=' }
}
