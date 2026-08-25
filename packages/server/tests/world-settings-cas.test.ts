import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { WorldSettingsConflictError, WorldSettingsService } from '../src/services/world-settings-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'

describe('WorldSettingsService revision CAS', () => {
  it('increments a durable root revision and rejects stale patches', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-settings-cas-'))
    const service = new WorldSettingsService(new WorldRootService(stateRoot))
    const initial = await service.getSnapshot('world-cas')
    expect(initial.revision).toBe(0)

    const saved = await service.savePatch('world-cas', { scenario: '第一版场景' }, initial.revision)
    expect(saved.revision).toBe(1)
    expect(saved.settings.scenario).toBe('第一版场景')
    await expect(service.savePatch('world-cas', { scenario: '过期覆盖' }, initial.revision))
      .rejects.toBeInstanceOf(WorldSettingsConflictError)
    expect((await service.getSnapshot('world-cas')).settings.scenario).toBe('第一版场景')
  })
})


describe('world settings concurrent writes', () => {
  it('lets exactly one of two writers holding the same revision win', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-settings-race-'))
    const settings = new WorldSettingsService(new WorldRootService(root))
    const worldId = 'world-race'
    const before = await settings.getSnapshot(worldId)

    // Two windows saving at the same time, each having read the same revision.
    // A read-then-check-then-write leaves a window where both find the
    // revision current and both publish, the second silently overwriting the
    // first while each reports success.
    const results = await Promise.allSettled([
      settings.savePatch(worldId, { scenario: '第一位写入者' }, before.revision),
      settings.savePatch(worldId, { scenario: '第二位写入者' }, before.revision),
    ])
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter((item) => item.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorldSettingsConflictError)

    const after = await settings.getSnapshot(worldId)
    // The revision advances exactly once, and the file holds one complete
    // settings object — not a blend of two writes.
    expect(after.revision).toBe(before.revision + 1)
    expect(['第一位写入者', '第二位写入者']).toContain(after.settings.scenario)
  })

  it('still lets unrelated worlds write at the same time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-settings-parallel-'))
    const settings = new WorldSettingsService(new WorldRootService(root))
    const [a, b] = await Promise.all([
      settings.savePatch('world-a', { scenario: 'A' }, 0),
      settings.savePatch('world-b', { scenario: 'B' }, 0),
    ])
    expect(a.settings.scenario).toBe('A')
    expect(b.settings.scenario).toBe('B')
  })
})
