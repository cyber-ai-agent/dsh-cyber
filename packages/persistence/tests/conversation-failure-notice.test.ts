import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []
const roots: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(kind: 'direct' | 'group' = 'direct') {
  const root = await mkdtemp(join(tmpdir(), 'cyber-failure-notice-'))
  roots.push(root)
  const path = join(root, 'cyber.sqlite')
  const store = await SqliteStore.open(path)
  stores.push(store)
  const workspace = store.createWorkspace({ name: 'Failure test' })
  const world = store.createWorld({ workspaceId: workspace.id, name: 'Failure world', templateId: 'personal-world' })
  store.saveBlueprint({ schemaVersion: 1, id: 'fixture.worker', version: 1, worldTemplateId: 'personal-world', displayName: '测试角色', role: '测试角色', summary: '测试', persona: '测试', requestedSkills: [], requestedCapabilities: [], createdAt: '2026-10-08T00:00:00.000Z' })
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'fixture.worker', blueprintVersion: 1 })
  const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind, title: '原会话' })
  const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, clientTurnId: 'accepted-turn', interactionKind: 'chat' })
  store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '原始消息', metadata: { workTurnId: turn.id, clientTurnId: turn.clientTurnId! } })
  const queue = store.enqueueConversationTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, workTurnId: turn.id, employeeIds: [employee.id], conversationKind: kind })
  return { path, store, workspace, world, session, turn, queue }
}

describe('durable accepted-turn failure notices', () => {
  it.each(['direct', 'group'] as const)('keeps exactly one sanitized %s notice after both failure paths and reopening SQLite', async (kind) => {
    const { path, store, session, turn, queue } = await setup(kind)
    const claimed = store.claimConversationQueueEntry({ queueEntryId: queue.id, leaseOwner: 'test', leaseDurationMs: 30_000 })
    store.failWorkTurn(turn.id, 'runtime-authentication')
    store.failConversationQueueEntry({ queueEntryId: queue.id, expectedRevision: claimed.revision, errorCode: 'ignored-private-error' })
    expect(() => store.failWorkTurn(turn.id, 'runtime-authentication')).toThrow('Illegal work turn transition')
    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    const notices = reopened.listMessages(session.id).filter((message) => message.kind === 'system')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ sessionId: session.id, senderKind: 'system', content: expect.stringContaining('API 密钥被模型服务拒绝'), metadata: { productNotice: true, control: 'failure', status: 'failed', workTurnId: turn.id, clientTurnId: 'accepted-turn', errorCode: 'runtime-authentication' } })
    expect(JSON.stringify(notices)).not.toContain('ignored-private-error')
    expect(reopened.getWorkTurn(turn.id)?.status).toBe('failed')
  })

  it('rolls back the lifecycle transition if the durable failure notice cannot be saved', async () => {
    const { store, session, turn, queue } = await setup()
    const claimed = store.claimConversationQueueEntry({ queueEntryId: queue.id, leaseOwner: 'test', leaseDurationMs: 30_000 })
    store.database.exec(`CREATE TRIGGER reject_failure_notice BEFORE INSERT ON messages WHEN NEW.kind = 'system' BEGIN SELECT RAISE(ABORT, 'fixture notice write failure'); END`)
    expect(() => store.failWorkTurn(turn.id, 'runtime-timeout')).toThrow('fixture notice write failure')
    expect(store.getWorkTurn(turn.id)?.status).toBe('running')
    expect(() => store.failConversationQueueEntry({ queueEntryId: queue.id, expectedRevision: claimed.revision, errorCode: 'raw private exception' })).toThrow('fixture notice write failure')
    expect(store.getWorkTurn(turn.id)?.status).toBe('running')
    expect(store.getConversationQueueEntry(queue.id)?.status).toBe('running')
    store.database.exec('DROP TRIGGER reject_failure_notice')
    store.failConversationQueueEntry({ queueEntryId: queue.id, expectedRevision: claimed.revision, errorCode: 'raw private exception' })
    const notice = store.listMessages(session.id).find((message) => message.kind === 'system')!
    expect(notice.metadata.errorCode).toBe('turn-failed')
    expect(JSON.stringify(notice)).not.toContain('raw private exception')
  })

  it('does not add a failure notice for ordinary queued cancellation or interrupted Stop', async () => {
    const { store, session, queue } = await setup()
    store.removeConversationQueueEntry({ queueEntryId: queue.id })
    expect(store.listMessages(session.id).filter((message) => message.kind === 'system')).toHaveLength(0)
    const turn = store.createWorkTurn({ workspaceId: queue.workspaceId, worldId: queue.worldId, sessionId: session.id, interactionKind: 'chat' })
    store.startWorkTurn(turn.id)
    store.interruptWorkTurn(turn.id, 'interrupted')
    expect(store.listMessages(session.id).filter((message) => message.kind === 'system')).toHaveLength(0)
  })
})
