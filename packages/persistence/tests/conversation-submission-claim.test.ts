import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationSubmissionInput, EmployeeBlueprint } from '@dsh-cyber/contracts'

import { SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []
const roots: string[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })))
})

describe('atomic conversation submission claims', () => {
  it('creates session, turn, message and queue once and replays the same facts', async () => {
    const fixture = await setup()
    const input = submission(fixture, 'same-key', 'a'.repeat(64), true)

    const created = fixture.store.claimConversationSubmission(input)
    const other = await SqliteStore.open(fixture.path)
    stores.push(other)
    const replay = other.claimConversationSubmission(input)

    expect(created.created).toBe(true)
    expect(replay.created).toBe(false)
    expect(replay.claim).toEqual(created.claim)
    expect(replay.queueEntry?.id).toBe(created.queueEntry?.id)
    expect(fixture.store.listSessions(fixture.worldId)).toHaveLength(1)
    expect(fixture.store.listSessionTurns(created.session.id)).toHaveLength(1)
    expect(fixture.store.listMessages(created.session.id).filter((message) => message.kind === 'user')).toHaveLength(1)
    expect(fixture.store.listConversationQueue(fixture.worldId)).toHaveLength(1)
  })

  it('rejects a changed fingerprint and keeps the original facts untouched', async () => {
    const fixture = await setup()
    const original = fixture.store.claimConversationSubmission(submission(fixture, 'conflict-key', 'a'.repeat(64), false))
    expect(() => fixture.store.claimConversationSubmission(submission(fixture, 'conflict-key', 'b'.repeat(64), false)))
      .toThrow('different fingerprint')
    expect(fixture.store.listSessions(fixture.worldId)).toHaveLength(1)
    expect(fixture.store.listSessionTurns(original.session.id)).toHaveLength(1)
    expect(fixture.store.listMessages(original.session.id).filter((message) => message.kind === 'user')).toHaveLength(1)
  })

  it('rolls back every fact when queue validation fails', async () => {
    const fixture = await setup()
    const invalid = submission(fixture, 'invalid-queue', 'c'.repeat(64), true)
    invalid.queue!.employeeIds = ['missing-employee']

    expect(() => fixture.store.claimConversationSubmission(invalid)).toThrow('missing-employee')
    expect(fixture.store.listSessions(fixture.worldId)).toHaveLength(0)
    expect(fixture.store.getConversationSubmissionClaim(fixture.workspaceId, fixture.worldId, 'invalid-queue')).toBeUndefined()
    expect(fixture.store.listConversationQueue(fixture.worldId)).toHaveLength(0)
  })

  it('does not reuse a separate group chat merely because membership matches', async () => {
    const fixture = await setup(true)
    const first = fixture.store.claimConversationSubmission(groupSubmission(fixture, 'group-a', 'd'.repeat(64), '项目甲'))
    const second = fixture.store.claimConversationSubmission(groupSubmission(fixture, 'group-b', 'e'.repeat(64), '项目乙'))
    expect(second.session.id).not.toBe(first.session.id)
    expect(fixture.store.listSessions(fixture.worldId)).toHaveLength(2)
  })

  it('fails closed for a legacy client id whose request fingerprint is unknowable', async () => {
    const fixture = await setup()
    const session = fixture.store.createSession({
      workspaceId: fixture.workspaceId,
      worldId: fixture.worldId,
      kind: 'direct',
      title: '旧会话',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: fixture.employeeIds[0]!, kind: 'employee' }],
    })
    fixture.store.createWorkTurn({
      workspaceId: fixture.workspaceId,
      worldId: fixture.worldId,
      sessionId: session.id,
      clientTurnId: 'legacy-key',
      interactionKind: 'chat',
    })
    expect(() => fixture.store.claimConversationSubmission(submission(fixture, 'legacy-key', 'f'.repeat(64), false)))
      .toThrow('legacy WorkTurn data')
    expect(fixture.store.listSessions(fixture.worldId)).toHaveLength(1)
  })
})

async function setup(secondEmployee = false) {
  const root = await mkdtemp(join(tmpdir(), 'cyber-submission-claim-'))
  roots.push(root)
  const path = join(root, 'cyber.sqlite')
  const store = await SqliteStore.open(path)
  stores.push(store)
  const workspace = store.createWorkspace({ name: '提交测试' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '提交世界', templateId: 'personal-world' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1, id: 'submission.worker', version: 1, worldTemplateId: 'personal-world',
    displayName: '提交角色', role: '测试', summary: '原子受理', persona: '只处理一次',
    requestedSkills: [], requestedCapabilities: [], createdAt: '2026-09-06T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  const first = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1, displayName: '甲' })
  const employeeIds = [first.id]
  if (secondEmployee) {
    employeeIds.push(store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1, displayName: '乙' }).id)
  }
  return { path, store, workspaceId: workspace.id, worldId: world.id, employeeIds }
}

function submission(
  fixture: Awaited<ReturnType<typeof setup>>,
  key: string,
  fingerprintSha256: string,
  queued: boolean,
): ConversationSubmissionInput {
  return {
    workspaceId: fixture.workspaceId,
    worldId: fixture.worldId,
    idempotencyKey: key,
    fingerprintSha256,
    sessionKind: 'direct',
    participantEmployeeIds: [fixture.employeeIds[0]!],
    reservationEmployeeIds: [fixture.employeeIds[0]!],
    interactionKind: 'chat',
    ownerMessage: { content: '只执行一次', metadata: { permissionMode: 'read-only' } },
    ...(queued ? { queue: { employeeIds: [fixture.employeeIds[0]!], queueMode: 'normal', permissionMode: 'read-only' } } : {}),
  }
}

function groupSubmission(
  fixture: Awaited<ReturnType<typeof setup>>,
  key: string,
  fingerprintSha256: string,
  sessionTitle: string,
): ConversationSubmissionInput {
  return {
    workspaceId: fixture.workspaceId,
    worldId: fixture.worldId,
    idempotencyKey: key,
    fingerprintSha256,
    sessionKind: 'group',
    sessionTitle,
    participantEmployeeIds: fixture.employeeIds,
    reservationEmployeeIds: fixture.employeeIds,
    interactionKind: 'chat',
    collaborationMode: 'discussion',
    ownerMessage: { content: sessionTitle },
  }
}
