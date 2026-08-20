import { describe, expect, it } from 'vitest'
import type {
  WorldCue,
  WorldRuntimeSnapshot,
  WorldRuntimeStreamEnvelope,
  WorldThemeActorSetManifest,
} from '@dsh-cyber/contracts'

import { reduceWorldStreamState, type WorldClientState } from '../src/features/world/world-client-store.js'
import { resolveClipFrames } from '../src/features/world/renderer/actor-animation-controller.js'
import { createZoomCommand } from '../src/features/world/zoom-command.js'
import { cyberCompanyTheme } from '@dsh-cyber/world-runtime'

describe('world renderer client contracts', () => {
  it('creates one fixed zoom step per unique command', () => {
    const first = createZoomCommand(0.1)
    const second = createZoomCommand(0.1)
    const third = createZoomCommand(-0.1)
    expect([first.delta, second.delta, third.delta]).toEqual([0.1, 0.1, -0.1])
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
  })

  it('uses an explicit direction fallback from actor clip definitions', () => {
    const actorSet = structuredClone(cyberCompanyTheme.actorSets[0]!) as WorldThemeActorSetManifest
    actorSet.clips.walking = { east: [2, 3] }
    expect(resolveClipFrames(actorSet, 'walking', 'north')).toEqual([2, 3])
    actorSet.clips.blocked = {}
    expect(resolveClipFrames(actorSet, 'blocked', 'west')).toEqual([0])
  })

  it('ignores duplicate cues, stale cues, and old snapshots after recovery', () => {
    const snapshot = makeSnapshot(10)
    const initial: WorldClientState = { manifest: cyberCompanyTheme, snapshot, cues: [], loading: false, connected: true }
    const freshCue = makeCue(10, 'cue-10')
    const withCue = reduceWorldStreamState(initial, envelope('world-cue', 10, freshCue))
    expect(withCue.cues).toHaveLength(1)
    expect(reduceWorldStreamState(withCue, envelope('world-cue', 10, freshCue)).cues).toHaveLength(1)
    expect(reduceWorldStreamState(withCue, envelope('world-cue', 9, makeCue(9, 'cue-9')))).toBe(withCue)
    expect(reduceWorldStreamState(withCue, envelope('world-state', 8, makeSnapshot(8)))).toBe(withCue)
  })
})

function makeSnapshot(sequence: number): WorldRuntimeSnapshot {
  const now = '2026-08-20T00:00:00.000Z'
  return {
    contractVersion: 1,
    workspaceId: 'workspace',
    worldId: 'world',
    templateId: 'cyber-company',
    themeId: cyberCompanyTheme.id,
    sceneId: 'headquarters',
    sequence,
    generatedAt: now,
    clock: { now, timezone: 'UTC', lightsOn: true },
    entities: [],
    objects: [],
    growthSlots: {},
  }
}

function makeCue(sequence: number, id: string): WorldCue {
  return { id, worldId: 'world', sequence, kind: 'entity.activity', payload: {}, createdAt: '2026-08-20T00:00:00.000Z' }
}

function envelope(kind: 'world-cue' | 'world-state', sequence: number, payload: WorldCue | WorldRuntimeSnapshot): WorldRuntimeStreamEnvelope {
  return { contractVersion: 1, id: String(sequence), worldId: 'world', sequence, kind, payload: payload as never, createdAt: '2026-08-20T00:00:00.000Z' }
}
