import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { CompletionJobDraft, EmployeeBlueprint } from '@dsh-cyber/contracts'

import { CompletionJobRepository, SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('CompletionJobRepository', () => {
  it('commits the final message, completed AgentRun, and idempotent job atomically', async () => {
    let now = new Date('2026-08-27T12:00:00.000Z')
    const { store, context } = await setup(() => now.toISOString())
    const draft = completionDraft(context)
    const committed = store.commitAgentRunCompletion({
      runId: context.runId,
      runtimeSessionId: 'runtime-session',
      messages: [assistantMessage(context)],
      completionJob: draft,
    })

    expect(committed.run.status).toBe('completed')
    expect(committed.completionJob).toMatchObject({ status: 'pending', attemptCount: 0 })
    expect(committed.messages[0]?.metadata).toMatchObject({
      agentRunId: context.runId,
      completionStatus: 'pending',
      completionJobId: committed.completionJob?.id,
    })

    const repository = new CompletionJobRepository(store.database, { clock: () => now.toISOString() })
    expect(repository.create(draft).id).toBe(committed.completionJob?.id)
    expect(() => repository.create({ ...draft, type: 'different-handler' })).toThrow('idempotency key conflict')

    const ownerA = repository.claim('worker-a', 1_000)
    expect(ownerA).toMatchObject({ status: 'running', attemptCount: 1, leaseOwner: 'worker-a' })
    expect(repository.claim('worker-b', 1_000)).toBeUndefined()
    repository.retry(ownerA!.id, 'worker-a', 'artifact_scan_failed', new Date(now.getTime() + 500).toISOString())
    expect(repository.claim('worker-b', 1_000)).toBeUndefined()
    now = new Date(now.getTime() + 600)
    const ownerB = repository.claim('worker-b', 1_000)
    expect(ownerB).toMatchObject({ status: 'running', attemptCount: 2, leaseOwner: 'worker-b' })
    store.completeCompletionJob(ownerB!.id, 'worker-b', { artifactRefs: ['artifact-1'], messageMetadata: { artifactCount: 1 } })
    expect(store.getCompletionJob(ownerB!.id)).toMatchObject({ status: 'completed', attemptCount: 2 })
    expect(store.listMessages(context.sessionId).at(-1)?.metadata).toMatchObject({
      completionStatus: 'completed', artifactRefs: ['artifact-1'], artifactCount: 1,
    })
  })

  it('rolls back message and run completion when the outbox insert is invalid and recovers expired leases', async () => {
    let now = new Date('2026-08-27T13:00:00.000Z')
    const { store, context } = await setup(() => now.toISOString())
    expect(() => store.commitAgentRunCompletion({
      runId: context.runId,
      messages: [assistantMessage(context)],
      completionJob: { ...completionDraft(context), sessionId: 'missing-session' },
    })).toThrow()
    expect(store.getAgentRun(context.runId)?.status).toBe('running')
    expect(store.listMessages(context.sessionId).filter((message) => message.kind === 'assistant')).toEqual([])

    const committed = store.commitAgentRunCompletion({
      runId: context.runId,
      messages: [assistantMessage(context)],
      completionJob: completionDraft(context),
    })
    store.claimCompletionJob('crashed-worker', 500)
    now = new Date(now.getTime() + 600)
    expect(store.recoverCompletionJobsAfterRestart()).toBe(1)
    expect(store.getCompletionJob(committed.completionJob!.id)).toMatchObject({
      status: 'retrying', lastErrorCode: 'worker-restarted',
    })
  })
})

async function setup(clock: () => string) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-completion-job-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'), { clock })
  stores.push(store)
  const workspace = store.createWorkspace({ name: 'Completion workspace' })
  const world = store.createWorld({ workspaceId: workspace.id, name: 'Completion world', templateId: 'personal-world' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1, id: 'completion.worker', version: 1, worldTemplateId: 'personal-world',
    displayName: '整理员', role: '整理员', summary: '整理产物', persona: '整理产物',
    requestedSkills: [], requestedCapabilities: [], createdAt: clock(),
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1 })
  const session = store.createSession({
    workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: 'Completion',
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
  })
  const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
  store.startWorkTurn(turn.id)
  const run = store.createAgentRun({ workspaceId: workspace.id, worldId: world.id, turnId: turn.id, sessionId: session.id, employeeId: employee.id, ordinal: 1 })
  store.startAgentRun(run.id)
  return { store, context: { workspaceId: workspace.id, worldId: world.id, sessionId: session.id, workTurnId: turn.id, runId: run.id, employeeId: employee.id } }
}

function completionDraft(context: Awaited<ReturnType<typeof setup>>['context']): CompletionJobDraft {
  return {
    idempotencyKey: `completion:${context.runId}`,
    workspaceId: context.workspaceId,
    worldId: context.worldId,
    sessionId: context.sessionId,
    workTurnId: context.workTurnId,
    agentRunId: context.runId,
    type: 'artifact-publication',
    payload: { employeeId: context.employeeId, workspacePath: 'workspace' },
  }
}

function assistantMessage(context: Awaited<ReturnType<typeof setup>>['context']) {
  return {
    sessionId: context.sessionId,
    senderId: context.employeeId,
    senderKind: 'employee' as const,
    kind: 'assistant' as const,
    content: '主回答已完成',
    metadata: { agentRunId: context.runId, completionStatus: 'pending' },
  }
}
