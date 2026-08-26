import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorldRootService } from '../src/services/world-root-service.js'
import { WorldSettingsService } from '../src/services/world-settings-service.js'

describe('world foundation v3', () => {
  it('isolates files by world and persists world settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-worlds-'))
    const roots = new WorldRootService(root)
    const a = await roots.ensure('world-a')
    const b = await roots.ensure('world-b')
    expect(a.filesPath).not.toBe(b.filesPath)
    expect(a.filesPath.includes('world-a')).toBe(true)
    const settings = new WorldSettingsService(roots)
    const saved = await settings.save('world-a', { lore: '雨夜学院', userIdentity: { displayName: '洛', worldRole: '院长', addressAs: '院长' }, runtime: { permissionMode: 'workspace-write' } })
    expect(saved.lore).toBe('雨夜学院')
    expect(saved.runtime.permissionMode).toBe('workspace-write')
    expect((await settings.get('world-b')).lore).toBe('')
    expect((await settings.get('world-b')).runtime.permissionMode).toBe('read-only')
    expect((await settings.get('world-b')).model.responseLanguage).toBe('zh-CN')
    expect(JSON.parse(await readFile(join(a.rootPath, 'settings.json'), 'utf8')).userIdentity.addressAs).toBe('院长')
    expect(JSON.parse(await readFile(join(a.rootPath, 'settings.json'), 'utf8')).runtime.permissionMode).toBe('workspace-write')
    const fullAccess = await settings.save('world-a', { runtime: { permissionMode: 'danger-full-access' } })
    expect(fullAccess.runtime.permissionMode).toBe('danger-full-access')
    const english = await settings.save('world-a', { model: { reasoningEffort: 'auto', responseLanguage: 'en-US' } })
    expect(english.model.responseLanguage).toBe('en-US')
    expect(await settings.composeGroupRuntimePrompt('world-a', '检查状态')).toContain('Use English for the final response, visible reasoning summaries')
  })
})
