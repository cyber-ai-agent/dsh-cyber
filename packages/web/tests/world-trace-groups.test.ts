import { describe, expect, it } from 'vitest'

import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import { groupTraceEntriesByTurn, summarizeTraceGroup } from '../src/components/world-trace/groupTraceTurns.js'

function entry(id: string, over: Partial<WorldTraceEntry> = {}): WorldTraceEntry {
  return {
    id, worldId: 'world-1', category: 'agent', status: 'success', summary: id,
    sourceKind: 'agent-run', sourceId: `source-${id}`,
    createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:05.000Z',
    ...over,
  }
}

describe('groupTraceEntriesByTurn', () => {
  it('folds a turn request, runs and tools into one group and keeps standalone facts apart', () => {
    const groups = groupTraceEntriesByTurn([
      entry('e-final', { workTurnId: 'turn-1' }),
      entry('e-run', { workTurnId: 'turn-1', category: 'tool', tools: [{ callId: 'c1', label: '读取文件', status: 'success' }] }),
      entry('e-request', { workTurnId: 'turn-1', category: 'task', status: 'pending' }),
      entry('e-world', { category: 'world' }),
    ])
    expect(groups.map((group) => group.key)).toEqual(['turn:turn-1', 'solo:e-world'])
    expect(groups[0]!.entries.map((item) => item.id)).toEqual(['e-final', 'e-run', 'e-request'])
  })

  it('places a group at the slot of its newest entry so chronology never jumps', () => {
    const groups = groupTraceEntriesByTurn([
      entry('a', { workTurnId: 'turn-a', createdAt: '2026-09-02T03:00:00.000Z' }),
      entry('b', { createdAt: '2026-09-02T02:00:00.000Z' }),
      entry('a-old', { workTurnId: 'turn-a', createdAt: '2026-09-02T01:00:00.000Z' }),
    ])
    expect(groups.map((group) => group.key)).toEqual(['turn:turn-a', 'solo:b'])
    expect(groups[0]!.entries).toHaveLength(2)
  })
})

describe('summarizeTraceGroup', () => {
  it('aggregates actors, dedupes tools and artifacts, sums tokens, and surfaces the worst status', () => {
    const groups = groupTraceEntriesByTurn([
      entry('u', { workTurnId: 'turn-1', actorId: 'owner', category: 'task', status: 'pending' }),
      entry('r1', { workTurnId: 'turn-1', actorId: 'emp-1', tokenUsage: { prompt: 100, completion: 40, total: 140 }, tools: [{ callId: 'c1', label: '读取文件', status: 'success' }] }),
      entry('r2', { workTurnId: 'turn-1', actorId: 'emp-2', status: 'failed', tokenUsage: { prompt: 60, completion: 0, total: 60 }, tools: [{ callId: 'c1', label: '读取文件', status: 'failed' }, { callId: 'c2', label: '搜索网络信息', status: 'success' }] }),
    ])
    const summary = summarizeTraceGroup(groups[0]!, (id) => (id === 'emp-1' ? '苏遥' : id === 'emp-2' ? '阿洛' : id))
    expect(summary.actorNames).toEqual(['苏遥', '阿洛'])
    expect(summary.toolCount).toBe(2) // deduped by callId
    expect(summary.tokenTotal).toBe(200)
    expect(summary.status).toBe('failed')
    expect(summary.label).toBe('苏遥、阿洛')
  })
})
