import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { EmployeeBlueprint } from '@dsh-cyber/contracts'

import { SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('SQLite conversation queue leases', () => {
  it('atomically limits two workers to two lanes and preserves same-session order', async () => {
    const { path, store, workspaceId, worldId, employeeId } = await setup(() => '2026-08-27T15:00:00.000Z')
    const other = await SqliteStore.open(path, { clock: () => '2026-08-27T15:00:00.000Z' })
    stores.push(other)
    const first = enqueue(store, workspaceId, worldId, employeeId, '会话一')
    const second = enqueue(store, workspaceId, worldId, employeeId, '会话二')
    const third = enqueue(store, workspaceId, worldId, employeeId, '会话三')
    const sameSessionTurn = store.createWorkTurn({ workspaceId, worldId, sessionId: first.sessionId, interactionKind: 'chat' })
    const sameSession = store.enqueueConversationTurn({ workspaceId, worldId, sessionId: first.sessionId, workTurnId: sameSessionTurn.id, employeeIds: [employeeId], conversationKind: 'direct' })

    expect(store.claimConversationQueueEntry({ queueEntryId: first.entryId, leaseOwner: 'worker-a', leaseDurationMs: 30_000 }))
      .toMatchObject({ status: 'running', leaseOwner: 'worker-a', attemptCount: 1 })
    expect(other.claimConversationQueueEntry({ queueEntryId: second.entryId, leaseOwner: 'worker-b', leaseDurationMs: 30_000 }))
      .toMatchObject({ status: 'running', leaseOwner: 'worker-b', attemptCount: 1 })
    expect(() => store.claimConversationQueueEntry({ queueEntryId: third.entryId, leaseOwner: 'worker-c', leaseDurationMs: 30_000 }))
      .toThrow('changed concurrently')
    expect(() => store.claimConversationQueueEntry({ queueEntryId: sameSession.id, leaseOwner: 'worker-c', leaseDurationMs: 30_000 }))
      .toThrow('changed concurrently')
    expect(store.getWorkTurn(third.turnId)?.status).toBe('queued')
    expect(store.getWorkTurn(sameSessionTurn.id)?.status).toBe('queued')
  })

  it('renews a lease, requeues it only after expiry, and allows a new owner to claim', async () => {
    let now = new Date('2026-08-27T16:00:00.000Z')
    const { store, workspaceId, worldId, employeeId } = await setup(() => now.toISOString())
    const queued = enqueue(store, workspaceId, worldId, employeeId, '租约恢复')
    const claimed = store.claimConversationQueueEntry({ queueEntryId: queued.entryId, leaseOwner: 'worker-a', leaseDurationMs: 1_000 })
    expect(claimed.leaseExpiresAt).toBe('2026-08-27T16:00:01.000Z')
    now = new Date(now.getTime() + 500)
    expect(store.renewConversationQueueLease(queued.entryId, 'worker-a', 1_000).leaseExpiresAt).toBe('2026-08-27T16:00:01.500Z')
    now = new Date('2026-08-27T16:00:01.400Z')
    expect(store.recoverConversationQueueLeases()).toEqual({ requeued: 0 })
    now = new Date('2026-08-27T16:00:01.600Z')
    expect(store.recoverConversationQueueLeases()).toEqual({ requeued: 1 })
    expect(store.getConversationQueueEntry(queued.entryId)).toMatchObject({ status: 'queued', attemptCount: 1 })
    expect(store.getConversationQueueEntry(queued.entryId)?.leaseOwner).toBeUndefined()
    expect(store.getWorkTurn(queued.turnId)?.status).toBe('queued')
    expect(store.claimConversationQueueEntry({ queueEntryId: queued.entryId, leaseOwner: 'worker-b', leaseDurationMs: 1_000 }))
      .toMatchObject({ status: 'running', leaseOwner: 'worker-b', attemptCount: 2 })
  })

  it('does not requeue an expired lease while an AgentRun is still active', async () => {
    let now = new Date('2026-08-27T17:00:00.000Z')
    const { store, workspaceId, worldId, employeeId } = await setup(() => now.toISOString())
    const queued = enqueue(store, workspaceId, worldId, employeeId, '活跃运行')
    store.claimConversationQueueEntry({ queueEntryId: queued.entryId, leaseOwner: 'worker-a', leaseDurationMs: 1_000 })
    const run = store.createAgentRun({ workspaceId, worldId, sessionId: queued.sessionId, turnId: queued.turnId, employeeId, ordinal: 1 })
    store.startAgentRun(run.id)
    now = new Date(now.getTime() + 2_000)
    expect(store.recoverConversationQueueLeases()).toEqual({ requeued: 0 })
    expect(store.getConversationQueueEntry(queued.entryId)?.status).toBe('running')
  })
})

async function setup(clock: () => string) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-queue-lease-'))
  const path = join(directory, 'cyber.sqlite')
  const store = await SqliteStore.open(path, { clock })
  stores.push(store)
  const workspace = store.createWorkspace({ name: 'Queue workspace' })
  const world = store.createWorld({ workspaceId: workspace.id, name: 'Queue world', templateId: 'personal-world' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1, id: 'queue.worker', version: 1, worldTemplateId: 'personal-world',
    displayName: '队列角色', role: '执行角色', summary: '验证队列', persona: '验证队列',
    requestedSkills: [], requestedCapabilities: [], createdAt: clock(),
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1 })
  return { path, store, workspaceId: workspace.id, worldId: world.id, employeeId: employee.id }
}

function enqueue(store: SqliteStore, workspaceId: string, worldId: string, employeeId: string, title: string) {
  const session = store.createSession({
    workspaceId, worldId, kind: 'direct', title,
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employeeId, kind: 'employee' }],
  })
  const turn = store.createWorkTurn({ workspaceId, worldId, sessionId: session.id, interactionKind: 'chat' })
  const entry = store.enqueueConversationTurn({ workspaceId, worldId, sessionId: session.id, workTurnId: turn.id, employeeIds: [employeeId], conversationKind: 'direct' })
  return { sessionId: session.id, turnId: turn.id, entryId: entry.id }
}
