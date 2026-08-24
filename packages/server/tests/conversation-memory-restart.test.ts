import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import { HarnessCompatibilityAdapter, stableAgentSessionId } from '@dsh-cyber/harness-adapter'
import { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { SqliteStore } from '@dsh-cyber/persistence'

const HISTORY_HEADER = '[本地持久会话历史]'

const stores: SqliteStore[] = []
const orchestrators: ConversationOrchestrator[] = []

afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) await orchestrator.close()
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Already closed by the test itself while simulating a restart.
    }
  }
})

interface RecordedRun {
  sessionId: string
  prompt: string
}

interface WorkerScript {
  /** Throws for the run at this 1-based index before emitting anything. */
  failRunWithCollision?: number
  /** Emits a runtime event and then throws for the run at this 1-based index. */
  failRunAfterEvent?: number
}

function recordingAdapter(
  stateRoot: string,
  runs: RecordedRun[],
  reply: string | Record<string, string>,
  script: WorkerScript = {},
): HarnessCompatibilityAdapter {
  return new HarnessCompatibilityAdapter({
    stateRoot,
    runtimeFactory(spec) {
      const answer = typeof reply === 'string'
        ? reply
        : reply[spec.employee.displayName] ?? `reply:${spec.employee.displayName}`
      return {
        async run(sessionId, prompt, onNotification) {
          runs.push({ sessionId, prompt })
          const attempt = runs.length
          if (script.failRunWithCollision === attempt) {
            throw new Error(`session "${sessionId}" already has a persisted log on disk (id collision)`)
          }
          if (script.failRunAfterEvent === attempt) {
            onNotification?.({
              method: 'session.event',
              params: { sessionId, event: { type: 'turn/start', data: { turn: 1 } } },
            })
            throw new Error('persisted log mismatch (id collision)')
          }
          onNotification?.({
            method: 'session.event',
            params: {
              sessionId,
              event: {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: answer }] } },
              },
            },
          })
          return { finalResponse: answer, notifications: [] }
        },
        async close() {},
      }
    },
  })
}

function blueprint(
  id: string,
  displayName: string,
  role: string,
): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName,
    role,
    summary: `${role}角色`,
    persona: `你是${displayName}，只以自己的身份发言。`,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-19T00:00:00.000Z',
  }
}

async function openWorkspace(databasePath: string) {
  const store = await SqliteStore.open(databasePath)
  stores.push(store)
  return store
}

function orchestratorFor(store: SqliteStore, adapter: HarnessCompatibilityAdapter, workspacePath: string) {
  const orchestrator = new ConversationOrchestrator({ store, runtime: adapter, workspacePath })
  orchestrators.push(orchestrator)
  return orchestrator
}

async function seed(databasePath: string) {
  const store = await openWorkspace(databasePath)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({
    workspaceId: workspace.id,
    name: '赛博公司',
    templateId: 'cyber-company',
  })
  store.saveBlueprint(blueprint('engineer', '小刘', '软件工程师'))
  store.saveBlueprint(blueprint('architect', '老王', '架构师'))
  const engineer = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'engineer',
    blueprintVersion: 1,
  })
  return { store, workspace, world, engineer }
}

describe('SQLite conversation memory across runtime restarts', () => {
  it('recovers the transcript from the same database file after the whole process state is rebuilt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-restart-'))
    const databasePath = join(directory, 'cyber.sqlite')

    // --- process 1 -------------------------------------------------------
    const firstRuns: RecordedRun[] = []
    const { store: storeA, workspace, world, engineer } = await seed(databasePath)
    const adapterA = recordingAdapter(join(directory, 'state-a'), firstRuns, '我先建立性能基线。')
    const orchestratorA = orchestratorFor(storeA, adapterA, directory)
    const first = await orchestratorA.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      prompt: '登录接口最近变慢了。',
    })
    const boundSessionId = storeA.getEmployee(engineer.id)!.agentSessionId
    expect(boundSessionId).toBe(firstRuns[0]!.sessionId)

    await orchestratorA.close()
    orchestrators.splice(orchestrators.indexOf(orchestratorA), 1)
    storeA.close()

    // --- process 2, same database file -----------------------------------
    const secondRuns: RecordedRun[] = []
    const storeB = await openWorkspace(databasePath)
    const adapterB = recordingAdapter(join(directory, 'state-b'), secondRuns, '基线已经跑完。')
    const orchestratorB = orchestratorFor(storeB, adapterB, directory)
    await orchestratorB.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      sessionId: first.session.id,
      prompt: '基线跑出来了吗？',
    })

    // The character can read the previous exchange…
    const recovered = secondRuns[0]!.prompt
    expect(recovered).toContain(HISTORY_HEADER)
    expect(recovered).toContain('用户：登录接口最近变慢了。')
    expect(recovered).toContain('小刘：我先建立性能基线。')
    expect(recovered).toContain('基线跑出来了吗？')

    // …and it does so without resuming any Harness log from the old process.
    expect(secondRuns[0]!.sessionId).not.toBe(boundSessionId)
    expect(secondRuns[0]!.sessionId).not.toBe(stableAgentSessionId(engineer.id))
    expect(secondRuns[0]!.sessionId).toMatch(/-[a-f0-9]{32}$/)
  })

  it('injects history once per Harness session instead of on every turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-once-'))
    const runs: RecordedRun[] = []
    const { store, workspace, world, engineer } = await seed(join(directory, 'cyber.sqlite'))
    const orchestrator = orchestratorFor(store, recordingAdapter(directory, runs, '收到。'), directory)

    const session = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      prompt: '第一轮。',
    })
    for (const prompt of ['第二轮。', '第三轮。']) {
      await orchestrator.direct({
        workspaceId: workspace.id,
        worldId: world.id,
        employeeId: engineer.id,
        sessionId: session.session.id,
        prompt,
      })
    }

    expect(runs).toHaveLength(3)
    expect(runs.every((run) => run.sessionId === runs[0]!.sessionId)).toBe(true)
    // The worker keeps its own context; replaying would duplicate the past.
    expect(runs.filter((run) => run.prompt.includes(HISTORY_HEADER))).toHaveLength(0)
  })

  it('recovers history when a permission mode change rebuilds the worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-permission-'))
    const runs: RecordedRun[] = []
    const { store, workspace, world, engineer } = await seed(join(directory, 'cyber.sqlite'))
    const orchestrator = orchestratorFor(store, recordingAdapter(directory, runs, '只读回答。'), directory)

    const session = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      prompt: '只读模式的第一句。',
      permissionMode: 'read-only',
    })
    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      sessionId: session.session.id,
      prompt: '现在切换到可写模式。',
      permissionMode: 'workspace-write',
    })

    expect(runs[1]!.sessionId).not.toBe(runs[0]!.sessionId)
    expect(runs[1]!.prompt).toContain('用户：只读模式的第一句。')
    expect(runs[1]!.prompt).toContain('小刘：只读回答。')
  })

  it('recovers history after the employee worker is closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-close-'))
    const runs: RecordedRun[] = []
    const { store, workspace, world, engineer } = await seed(join(directory, 'cyber.sqlite'))
    const adapter = recordingAdapter(directory, runs, '第一次回答。')
    const orchestrator = orchestratorFor(store, adapter, directory)

    const session = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      prompt: '关闭 worker 之前的一句。',
    })
    await adapter.closeEmployee(engineer.id)
    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      sessionId: session.session.id,
      prompt: '关闭 worker 之后的一句。',
    })

    expect(runs[1]!.sessionId).not.toBe(runs[0]!.sessionId)
    expect(runs[1]!.prompt).toContain('用户：关闭 worker 之前的一句。')
  })

  it('carries history into the session rotated by a persisted-log collision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-collision-'))
    const runs: RecordedRun[] = []
    const { store, workspace, world, engineer } = await seed(join(directory, 'cyber.sqlite'))
    // Run 1 succeeds, run 2 collides before producing anything, run 3 recovers.
    const adapter = recordingAdapter(directory, runs, '收到。', { failRunWithCollision: 2 })
    const orchestrator = orchestratorFor(store, adapter, directory)

    const session = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      prompt: '碰撞之前的一句。',
    })
    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      sessionId: session.session.id,
      prompt: '碰撞发生的这一轮。',
    })

    expect(runs).toHaveLength(3)
    // Only the colliding conversation rotates, and the fresh session is seeded.
    expect(runs[2]!.sessionId).not.toBe(runs[1]!.sessionId)
    expect(runs[2]!.prompt).toContain(HISTORY_HEADER)
    expect(runs[2]!.prompt).toContain('用户：碰撞之前的一句。')
    expect(runs[2]!.prompt).toContain('碰撞发生的这一轮。')
  })

  it('never replays a turn once the worker has emitted a runtime event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-no-replay-'))
    const runs: RecordedRun[] = []
    const { store, workspace, world, engineer } = await seed(join(directory, 'cyber.sqlite'))
    const adapter = recordingAdapter(directory, runs, '不会到达。', { failRunAfterEvent: 1 })
    const orchestrator = orchestratorFor(store, adapter, directory)

    await expect(orchestrator.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      prompt: '不要重复执行。',
    })).rejects.toThrow()

    expect(runs).toHaveLength(1)
  })

  it('lets an early group speaker read what a later speaker said in the previous round', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-group-catchup-'))
    const runs: RecordedRun[] = []
    const { store, workspace, world, engineer } = await seed(join(directory, 'cyber.sqlite'))
    const architect = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'architect',
      blueprintVersion: 1,
    })
    const orchestrator = orchestratorFor(
      store,
      recordingAdapter(directory, runs, { 小刘: '回归测试还没跑完。', 老王: '我建议延后一天。' }),
      directory,
    )

    // Round 1 speaks in order 小刘 → 老王, so 老王's statement lands after
    // 小刘's own worker session has already finished its turn.
    const meeting = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: [engineer.id, architect.id],
      prompt: '这次发布要不要延后？',
    })
    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: [engineer.id, architect.id],
      sessionId: meeting.session.id,
      prompt: '那就按结论走，谁来通知？',
    })

    expect(runs).toHaveLength(4)
    const engineerRoundTwo = runs[2]!
    // 小刘 speaks first again, so groupPrompt() carries nothing from round 1.
    // Without a catch-up the character simply never learns what 老王 said.
    expect(engineerRoundTwo.prompt).toContain('老王：我建议延后一天。')
    expect(engineerRoundTwo.prompt).toContain('那就按结论走，谁来通知？')
  })

  it('does not replay what a character already saw in its own live session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-no-duplicate-'))
    const runs: RecordedRun[] = []
    const { store, workspace, world, engineer } = await seed(join(directory, 'cyber.sqlite'))
    const architect = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'architect',
      blueprintVersion: 1,
    })
    const orchestrator = orchestratorFor(
      store,
      recordingAdapter(directory, runs, { 小刘: '回归测试还没跑完。', 老王: '我建议延后一天。' }),
      directory,
    )

    const meeting = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: [engineer.id, architect.id],
      prompt: '这次发布要不要延后？',
    })
    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: [engineer.id, architect.id],
      sessionId: meeting.session.id,
      prompt: '那就按结论走，谁来通知？',
    })

    const engineerRoundTwo = runs[2]!
    const architectRoundTwo = runs[3]!
    // 小刘 only needs the one statement it missed, not its own past.
    expect(engineerRoundTwo.prompt).not.toContain('用户：这次发布要不要延后？')
    expect(engineerRoundTwo.prompt).not.toContain('小刘：回归测试还没跑完。')
    // 老王 spoke last in round 1, so its session already saw everything and
    // gets no recovered history at all.
    expect(architectRoundTwo.prompt).not.toContain(HISTORY_HEADER)
  })

  it('gives a private chat and a group meeting of one character separate Harness sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-isolation-'))
    const databasePath = join(directory, 'cyber.sqlite')
    const firstRuns: RecordedRun[] = []
    const { store, workspace, world, engineer } = await seed(databasePath)
    const architect = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'architect',
      blueprintVersion: 1,
    })
    const orchestratorA = orchestratorFor(store, recordingAdapter(directory, firstRuns, '收到。'), directory)

    const direct = await orchestratorA.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      prompt: '私聊里的绩效谈话。',
    })
    const meeting = await orchestratorA.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: [engineer.id, architect.id],
      prompt: '群聊里的排期讨论。',
    })

    // Inside one process the two conversations of the same character already
    // hold two different worker sessions.
    const directSessionId = firstRuns[0]!.sessionId
    const groupSessionId = firstRuns[1]!.sessionId
    expect(groupSessionId).not.toBe(directSessionId)

    // Rebuilding the worker forces both conversations to be re-seeded from
    // SQLite, which is where cross-talk would become visible.
    await orchestratorA.close()
    orchestrators.splice(orchestrators.indexOf(orchestratorA), 1)

    const secondRuns: RecordedRun[] = []
    const orchestratorB = orchestratorFor(store, recordingAdapter(directory, secondRuns, '收到。'), directory)
    await orchestratorB.direct({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: engineer.id,
      sessionId: direct.session.id,
      prompt: '继续绩效。',
    })
    await orchestratorB.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: [engineer.id, architect.id],
      sessionId: meeting.session.id,
      prompt: '继续排期。',
    })

    const recoveredDirect = secondRuns[0]!
    const recoveredGroupForEngineer = secondRuns[1]!
    expect(recoveredDirect.sessionId).not.toBe(recoveredGroupForEngineer.sessionId)
    expect([directSessionId, groupSessionId]).not.toContain(recoveredDirect.sessionId)

    expect(recoveredDirect.prompt).toContain('用户：私聊里的绩效谈话。')
    expect(recoveredDirect.prompt).not.toContain('群聊里的排期讨论。')

    expect(recoveredGroupForEngineer.prompt).toContain('用户：群聊里的排期讨论。')
    expect(recoveredGroupForEngineer.prompt).not.toContain('私聊里的绩效谈话。')
  })
})
