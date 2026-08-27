import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CompletionWorker } from '../src/services/completion-worker.js'

const stores: SqliteStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('CompletionWorker', () => {
  it('keeps the main answer completed while post-processing retries and succeeds', async () => {
    let now = new Date('2026-08-27T14:00:00.000Z')
    const { store, ids, jobId } = await setup(() => now.toISOString())
    let calls = 0
    const worker = new CompletionWorker({
      store,
      handlers: new Map([['artifact-publication', async () => {
        calls += 1
        if (calls === 1) throw new Error('artifact scan failed')
        return { artifactRefs: ['artifact-retry-success'], messageMetadata: { artifactCount: 1 } }
      }]]),
      owner: 'worker-test',
      retryBaseMs: 10,
      leaseDurationMs: 1_000,
      maxAttempts: 2,
      clock: () => now,
    })

    expect(await worker.dispatchOnce()).toBe(true)
    await waitFor(() => store.getCompletionJob(jobId)?.status === 'retrying')
    expect(store.getAgentRun(ids.runId)?.status).toBe('completed')
    expect(store.listMessages(ids.sessionId).at(-1)).toMatchObject({
      content: '模型主回答', metadata: expect.objectContaining({ completionStatus: 'retrying' }),
    })

    now = new Date(now.getTime() + 20)
    expect(await worker.dispatchOnce()).toBe(true)
    await waitFor(() => store.getCompletionJob(jobId)?.status === 'completed')
    expect(calls).toBe(2)
    expect(store.listMessages(ids.sessionId).at(-1)?.metadata).toMatchObject({
      completionStatus: 'completed', artifactRefs: ['artifact-retry-success'], artifactCount: 1,
    })
    await worker.close()
  })

  it('waits for an in-flight handler during graceful shutdown', async () => {
    const { store } = await setup(() => new Date().toISOString())
    let resolveHandler: (() => void) | undefined
    let started = false
    const worker = new CompletionWorker({
      store,
      handlers: new Map([['artifact-publication', async () => {
        started = true
        await new Promise<void>((resolve) => { resolveHandler = resolve })
        return {}
      }]]),
      owner: 'shutdown-worker',
      leaseDurationMs: 1_000,
    })
    await worker.dispatchOnce()
    await waitFor(() => started)
    let closed = false
    const closing = worker.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    resolveHandler?.()
    await closing
    expect(closed).toBe(true)
  })
})

async function setup(clock: () => string) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-completion-worker-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'), { clock })
  stores.push(store)
  const workspace = store.createWorkspace({ name: 'Worker workspace' })
  const world = store.createWorld({ workspaceId: workspace.id, name: 'Worker world', templateId: 'personal-world' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1, id: 'completion.worker', version: 1, worldTemplateId: 'personal-world',
    displayName: '整理员', role: '整理员', summary: '整理产物', persona: '整理产物',
    requestedSkills: [], requestedCapabilities: [], createdAt: clock(),
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1 })
  const session = store.createSession({
    workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: 'Worker',
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
  })
  const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
  store.startWorkTurn(turn.id)
  const run = store.createAgentRun({ workspaceId: workspace.id, worldId: world.id, turnId: turn.id, sessionId: session.id, employeeId: employee.id, ordinal: 1 })
  store.startAgentRun(run.id)
  const committed = store.commitAgentRunCompletion({
    runId: run.id,
    messages: [{
      sessionId: session.id, senderId: employee.id, senderKind: 'employee', kind: 'assistant',
      content: '模型主回答', metadata: { agentRunId: run.id, completionStatus: 'pending' },
    }],
    completionJob: {
      idempotencyKey: `completion:${run.id}`,
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id,
      workTurnId: turn.id, agentRunId: run.id, type: 'artifact-publication',
      payload: { employeeId: employee.id, workspacePath: directory },
    },
  })
  return { store, ids: { sessionId: session.id, runId: run.id }, jobId: committed.completionJob!.id }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for completion worker')
}
