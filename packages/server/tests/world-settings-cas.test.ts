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

