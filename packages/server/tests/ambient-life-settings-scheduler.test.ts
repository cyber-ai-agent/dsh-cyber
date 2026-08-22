import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore } from '@dsh-cyber/persistence'

import { AmbientLifeScheduler } from '../src/services/ambient-life-scheduler.js'
import { AmbientLifeSettingsService } from '../src/services/ambient-life-settings-service.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ambient-settings-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地实例' })
  const first = store.createWorld({ workspaceId: workspace.id, name: '公司', templateId: 'cyber-company' })
  const second = store.createWorld({ workspaceId: workspace.id, name: '研究室', templateId: 'research' })
  return { store, first, second }
}

describe('ambient settings and scheduler', () => {
  it('is disabled by default and persists a validated per-world policy', async () => {
    const { store, first } = await setup()
    const settings = new AmbientLifeSettingsService(store, () => '2026-08-22T10:00:00.000Z')
    expect(settings.get(first.id)).toMatchObject({
      worldId: first.id,
      enabled: false,
      maximumPlansPerTick: 3,
    })

    const updated = settings.update(first.id, {
      enabled: true,
      minimumIdleMs: 60_000,
      minimumAmbientIntervalMs: 240_000,
      breakAfterMs: 2_400_000,
      timeBucketMs: 300_000,
      maximumPlansPerTick: 2,
    })
    expect(settings.get(first.id)).toEqual(updated)
    expect(settings.listEnabled()).toEqual([updated])
  })

  it('rejects noisy or unsafe policy values', async () => {
    const { store, first } = await setup()
    const settings = new AmbientLifeSettingsService(store)
    expect(() => settings.update(first.id, { maximumPlansPerTick: 100 })).toThrow('单次最大行为数')
    expect(() => settings.update(first.id, { minimumAmbientIntervalMs: 1 })).toThrow('日常行为间隔')
    expect(() => settings.update(first.id, { breakAfterMs: 1 })).toThrow('休息触发时间')
  })

  it('ticks only enabled worlds and does not overlap the same world', async () => {
    const { store, first, second } = await setup()
    const settings = new AmbientLifeSettingsService(store)
    settings.update(first.id, { enabled: true })
    settings.update(second.id, { enabled: false })

    const calls: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fakeService = {
      async tick(worldId: string) {
        calls.push(worldId)
        await gate
        return {
          worldId,
          generatedAt: '2026-08-22T10:00:00.000Z',
          decisions: [],
          plans: [],
          skippedCharacterIds: [],
          persistedPlanIds: [],
        }
      },
    }
    const scheduler = new AmbientLifeScheduler({
      settings,
      service: fakeService as never,
      intervalMs: 5_000,
    })

    const firstRun = scheduler.runOnce()
    const secondRun = scheduler.runOnce()
    await Promise.resolve()
    expect(calls).toEqual([first.id])
    release?.()
    await Promise.all([firstRun, secondRun])
    await scheduler.close()
  })

  it('isolates world failures so one world cannot stop later ticks', async () => {
    const { store, first, second } = await setup()
    const settings = new AmbientLifeSettingsService(store)
    settings.update(first.id, { enabled: true })
    settings.update(second.id, { enabled: true })
    const errors: string[] = []
    const calls: string[] = []
    const scheduler = new AmbientLifeScheduler({
      settings,
      service: {
        async tick(worldId: string) {
          calls.push(worldId)
          if (worldId === first.id) throw new Error('world failed')
          return {
            worldId,
            generatedAt: '2026-08-22T10:00:00.000Z',
            decisions: [],
            plans: [],
            skippedCharacterIds: [],
            persistedPlanIds: [],
          }
        },
      } as never,
      onError: (worldId) => errors.push(worldId),
    })

    const results = await scheduler.runOnce()
    expect(calls).toHaveLength(2)
    expect(calls).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(errors).toEqual([first.id])
    expect(results.map((item) => item.worldId)).toEqual([second.id])
    await scheduler.close()
  })
})
