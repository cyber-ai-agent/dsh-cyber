import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, World } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { createCyberServer, type CyberServer } from '../src/index.js'
import { AmbientLifeExecutor } from '../src/services/ambient-life-executor.js'
import { AmbientLifeScheduler } from '../src/services/ambient-life-scheduler.js'
import { AmbientLifeSettingsService } from '../src/services/ambient-life-settings-service.js'
import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'

import { ConversationQueueService } from '../src/services/conversation-queue-service.js'
import { WorldLifecycleService } from '../src/services/world-lifecycle-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'

const servers: CyberServer[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const store of stores.splice(0)) store.close()
})

class QuietRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: `agent-${request.agent.id}`, finalResponse: '好的。', eventCount: 0 }
  }
  async close(): Promise<void> {}
}

async function start() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-lifecycle-'))
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime: new QuietRuntime(),
    bootstrapDefaultWorld: true,
  })
  servers.push(server)
  const address = await server.start()
  return { origin: address.origin, server, stateRoot }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function defaultWorld(origin: string): Promise<{ world: World; characterId: string }> {
  const workspaces = await json(origin, '/api/workspaces')
  const workspaceId = workspaces.body.items[0].id as string
  const worlds = await json(origin, `/api/workspaces/${workspaceId}/worlds`)
  const world = worlds.body.items[0] as World
  const snapshot = await json(origin, `/api/worlds/${world.id}/snapshot`)
  return { world, characterId: snapshot.body.employees[0].id as string }
}

describe('world archive and restore over HTTP', () => {
  it('hides an archived world from the default list, shows it in the archived view and restores it', async () => {
    const { origin } = await start()
    const { world } = await defaultWorld(origin)

    const archived = await json(origin, `/api/worlds/${world.id}/archive`, send('POST', {}))
    expect(archived.response.status).toBe(200)
    expect(archived.body.world.status).toBe('archived')

    const active = await json(origin, `/api/workspaces/${world.workspaceId}/worlds`)
    expect((active.body.items as World[]).map((item) => item.id)).not.toContain(world.id)

    const archivedList = await json(origin, `/api/workspaces/${world.workspaceId}/worlds?status=archived`)
    expect((archivedList.body.items as World[]).map((item) => item.id)).toEqual([world.id])

    const all = await json(origin, `/api/workspaces/${world.workspaceId}/worlds?status=all`)
    expect((all.body.items as World[]).map((item) => item.id)).toContain(world.id)

    const restored = await json(origin, `/api/worlds/${world.id}/restore`, send('POST', {}))
    expect(restored.response.status).toBe(200)
    expect(restored.body.world.status).toBe('active')
    const afterRestore = await json(origin, `/api/workspaces/${world.workspaceId}/worlds`)
    expect((afterRestore.body.items as World[]).map((item) => item.id)).toContain(world.id)
  })

  it('keeps conversations and characters readable while archived and intact after restore', async () => {
    const { origin, server } = await start()
    const { world, characterId } = await defaultWorld(origin)
    const turn = await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '归档之前先聊一句',
      employeeIds: [characterId],
    }))
    expect(turn.response.status).toBe(200)
    const sessionsBefore = server.store.listSessions(world.id).length
    const messagesBefore = server.store.listSessions(world.id)
      .reduce((total, session) => total + server.store.listMessages(session.id).length, 0)
    expect(messagesBefore).toBeGreaterThan(0)

    await json(origin, `/api/worlds/${world.id}/archive`, send('POST', {}))

    const sessions = await json(origin, `/api/worlds/${world.id}/sessions`)
    expect(sessions.response.status).toBe(200)
    expect((sessions.body.items as unknown[]).length).toBe(sessionsBefore)
    expect(server.store.listEmployees(world.id).some((item) => item.id === characterId)).toBe(true)

    await json(origin, `/api/worlds/${world.id}/restore`, send('POST', {}))
    const messagesAfter = server.store.listSessions(world.id)
      .reduce((total, session) => total + server.store.listMessages(session.id).length, 0)
    expect(messagesAfter).toBe(messagesBefore)
  })
})

describe('an archived world starts no work', () => {
  it('closes every entry point that could begin agent work', async () => {
    const { origin, server } = await start()
    const { world, characterId } = await defaultWorld(origin)
    const schedule = await json(origin, `/api/worlds/${world.id}/schedules`, send('POST', {
      employeeId: characterId,
      title: '每日巡检',
      prompt: '检查一下今天的进度',
      kind: 'once',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      permissionMode: 'read-only',
    }))
    expect(schedule.response.status).toBe(201)
    const scheduleId = schedule.body.item.id as string
    const task = await json(origin, `/api/worlds/${world.id}/tasks`, send('POST', {
      title: '归档前建立的任务',
      description: '用于验证归档后的执行拒绝。',
      priority: 'normal',
    }))
    expect(task.response.status).toBe(201)
    const taskId = task.body.task.id as string
    const secondCharacterId = server.store.recruitEmployee({
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: 'core.butler',
      blueprintVersion: 1,
      displayName: '助手',
    }).id

    await json(origin, `/api/worlds/${world.id}/archive`, send('POST', {}))

    // 1. direct / group chat
    const chat = await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '继续干活',
      employeeIds: [characterId],
    }))
    expect(chat.response.status).toBe(409)
    expect(chat.body.error.code).toBe('world_archived')

    const group = await json(origin, `/api/worlds/${world.id}/group-sessions`, send('POST', {
      employeeIds: [characterId, secondCharacterId],
    }))
    expect(group.response.status).toBe(409)

    // 2. queued conversation turns
    const queued = await json(origin, `/api/worlds/${world.id}/chat-queue`, send('POST', {
      prompt: '排一个队',
      employeeIds: [characterId],
    }))
    expect(queued.response.status).toBe(409)

    // 3. peer (character-to-character) collaboration
    const peer = await json(origin, `/api/worlds/${world.id}/peer-conversations`, send('POST', {
      initiatorId: characterId,
      participantIds: [secondCharacterId],
      purpose: '一起讨论一下',
    }))
    expect(peer.response.status).toBe(409)

    // 4. work-system tasks: creation and execution
    const newTask = await json(origin, `/api/worlds/${world.id}/tasks`, send('POST', {
      title: '归档后的任务',
      description: '不应当被接受。',
      priority: 'normal',
    }))
    expect(newTask.response.status).toBe(409)
    const execute = await json(origin, `/api/tasks/${taskId}/execute`, send('POST', {
      employeeIds: [characterId, secondCharacterId],
    }))
    expect(execute.response.status).toBe(409)

    // 5. scheduled tasks: creation and manual run
    const newSchedule = await json(origin, `/api/worlds/${world.id}/schedules`, send('POST', {
      employeeId: characterId,
      title: '归档后的计划',
      prompt: '不应当被接受',
      kind: 'once',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      permissionMode: 'read-only',
    }))
    expect(newSchedule.response.status).toBe(409)
    const runNow = await json(origin, `/api/worlds/${world.id}/schedules/${scheduleId}/run`, send('POST', {}))
    expect(runNow.response.status).toBe(409)

    // 6. world interactions (assign-task, start-meeting, ...)
    const interaction = await json(origin, `/api/worlds/${world.id}/interactions`, send('POST', {
      action: 'assign-task',
      entityId: characterId,
      prompt: '去做点事',
    }))
    expect(interaction.response.status).toBe(409)

    // 7. resuming a paused turn through an approval decision
    const approval = server.store.createApprovalRequest({
      workspaceId: world.workspaceId,
      worldId: world.id,
      characterId,
      subjectType: 'skill-action',
      subjectId: 'skill-action-1',
      risk: 'write-local',
      summary: '归档前挂起的审批',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const decided = await json(origin, `/api/approvals/${approval.id}/decision`, send('POST', { decision: 'approved' }))
    expect(decided.response.status).toBe(409)

    // 8. recruiting new characters into an archived world
    const recruit = await json(origin, `/api/worlds/${world.id}/recruit`, send('POST', {
      blueprintId: 'core.butler',
      blueprintVersion: 1,
    }))
    expect(recruit.response.status).toBe(409)

    // No work was created behind any of those refusals.
    expect(server.store.listActiveWorldWork(world.id)).toEqual([])

    // And the same chat succeeds again once the world is restored.
    await json(origin, `/api/worlds/${world.id}/restore`, send('POST', {}))
    const afterRestore = await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '恢复之后继续',
      employeeIds: [characterId],
    }))
    expect(afterRestore.response.status).toBe(200)
  })

  it('keeps the ambient scheduler and the ambient executor away from an archived world', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-world-lifecycle-ambient-'))
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '公司', templateId: 'cyber-company' })
    const settings = new AmbientLifeSettingsService(store)
    settings.update(world.id, { enabled: true })
    expect(settings.listEnabled().map((item) => item.worldId)).toEqual([world.id])

    store.archiveWorld({ worldId: world.id })

    // The scheduler simply never visits an archived world.
    expect(settings.listEnabled()).toEqual([])
    const ticked: string[] = []
    const scheduler = new AmbientLifeScheduler({
      settings,
      service: {
        async tick(worldId: string) {
          ticked.push(worldId)
          return { worldId, generatedAt: new Date().toISOString(), decisions: [], plans: [], skippedCharacterIds: [], persistedPlanIds: [] }
        },
      },
    })
    await scheduler.runOnce()
    expect(ticked).toEqual([])
    await scheduler.close()

    // A direct executor call still fails closed rather than quietly running.
    const executor = new AmbientLifeExecutor({
      store,
      simulationStore: { saveActionPlan: () => { throw new Error('unreachable') } } as never,
    })
    expect(() => executor.start({
      worldId: world.id,
      generatedAt: new Date().toISOString(),
      decisions: [],
      plans: [],
      skippedCharacterIds: [],
      persistedPlanIds: [],
    })).toThrowError(/归档/)
  })

  it('parks conversation turns queued before the archive instead of dispatching them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-world-lifecycle-queue-'))
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '公司', templateId: 'cyber-company' })
    store.saveBlueprint({
      schemaVersion: 1,
      id: 'queue-engineer',
      version: 1,
      worldTemplateId: 'cyber-company',
      displayName: '小陈',
      role: '软件工程师',
      summary: '交付可靠的软件。',
      persona: '先澄清验收标准。',
      requestedSkills: [],
      requestedCapabilities: [],
      createdAt: '2026-08-19T00:00:00.000Z',
    })
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'queue-engineer',
      blueprintVersion: 1,
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '与小陈对话',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
    const entry = store.enqueueConversationTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      workTurnId: turn.id,
      employeeIds: [employee.id],
      conversationKind: 'direct',
    })

    store.archiveWorld({ worldId: world.id })

    const dispatched: string[] = []
    const queue = new ConversationQueueService({
      store,
      orchestrator: { interruptWorkTurn: async () => undefined } as unknown as ConversationOrchestrator,
      runner: async (claimed) => { dispatched.push(claimed.id) },
      pollIntervalMs: 10_000,
    })
    expect(await queue.dispatchOnce()).toBe(0)
    expect(dispatched).toEqual([])
    await queue.close()

    // The entry stays parked exactly as it was and resumes on restore.
    expect(store.getConversationQueueEntry(entry.id)?.status).toBe('queued')
    expect(store.listWorldAgentRuns(world.id)).toEqual([])
  })
})

describe('permanent world deletion over HTTP', () => {
  it('requires the typed world name and then removes the world and its files', async () => {
    const { origin, server, stateRoot } = await start()
    const { world } = await defaultWorld(origin)
    const worldRootPath = join(stateRoot, 'worlds', encodeURIComponent(world.id))
    await expect(access(worldRootPath)).resolves.toBeUndefined()

    const wrong = await json(origin, `/api/worlds/${world.id}`, send('DELETE', { confirmName: '不是这个名字' }))
    expect(wrong.response.status).toBe(422)
    expect(wrong.body.error.code).toBe('world_name_confirmation_mismatch')
    expect(server.store.getWorld(world.id)).toBeDefined()
    await expect(access(worldRootPath)).resolves.toBeUndefined()

    const deleted = await json(origin, `/api/worlds/${world.id}`, send('DELETE', { confirmName: world.name }))
    expect(deleted.response.status).toBe(200)
    expect(deleted.body.deleted).toBe(true)
    expect(server.store.getWorld(world.id)).toBeUndefined()
    await expect(access(worldRootPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to delete a world with a WorkTurn still running', async () => {
    const { origin, server } = await start()
    const { world } = await defaultWorld(origin)
    const session = server.store.listSessions(world.id)[0]!
    const turn = server.store.createWorkTurn({
      workspaceId: world.workspaceId,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'chat',
    })
    server.store.startWorkTurn(turn.id)

    const blocked = await json(origin, `/api/worlds/${world.id}`, send('DELETE', { confirmName: world.name }))
    expect(blocked.response.status).toBe(409)
    expect(blocked.body.error.code).toBe('world_has_active_work')
    expect(server.store.getWorld(world.id)).toBeDefined()

    server.store.completeWorkTurn(turn.id)
    const deleted = await json(origin, `/api/worlds/${world.id}`, send('DELETE', { confirmName: world.name }))
    expect(deleted.response.status).toBe(200)
  })

  it('never removes the workspace-wide installed package library', async () => {
    const { origin, server, stateRoot } = await start()
    const { world } = await defaultWorld(origin)
    // The global library lives beside the worlds, not inside one. Seed a file
    // there so a deletion that reached too far would be caught.
    const libraryRoot = join(stateRoot, 'packages', 'installed')
    await mkdir(libraryRoot, { recursive: true })
    const libraryFile = join(libraryRoot, 'library-marker.txt')
    await writeFile(libraryFile, 'workspace asset', 'utf8')
    const installedBefore = server.store.listInstalledPackages(world.workspaceId).length

    const deleted = await json(origin, `/api/worlds/${world.id}`, send('DELETE', { confirmName: world.name }))
    expect(deleted.response.status).toBe(200)

    await expect(access(libraryFile)).resolves.toBeUndefined()
    expect(server.store.listInstalledPackages(world.workspaceId)).toHaveLength(installedBefore)
    // Blueprints are workspace assets too and must outlive any single world.
    expect(server.store.getBlueprint('core.butler', 1)).toBeDefined()
  })

  it('finishes a deletion interrupted between the database commit and the file removal', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-lifecycle-crash-'))
    const store = await SqliteStore.open(join(stateRoot, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '公司', templateId: 'cyber-company' })
    const survivor = store.createWorld({ workspaceId: workspace.id, name: '研究室', templateId: 'cyber-company' })
    const roots = new WorldRootService(stateRoot)
    await roots.ensure(world.id)
    await roots.ensure(survivor.id)
    const lifecycle = new WorldLifecycleService({ store, roots })

    // Simulate the crash: the marker is written and the records are gone, but
    // the process died before the directory could be removed.
    await roots.markPendingDelete(world.id)
    store.deleteWorld({ worldId: world.id, confirmationName: world.name })
    await expect(access(join(stateRoot, 'worlds', encodeURIComponent(world.id)))).resolves.toBeUndefined()

    const swept = await lifecycle.sweepInterrupted()
    expect(swept).toEqual([world.id])
    await expect(access(join(stateRoot, 'worlds', encodeURIComponent(world.id))))
      .rejects.toMatchObject({ code: 'ENOENT' })
    // A surviving world is never touched, marker or no marker.
    await expect(access(join(stateRoot, 'worlds', encodeURIComponent(survivor.id)))).resolves.toBeUndefined()
    expect(store.getWorld(survivor.id)).toBeDefined()
  })

  it('leaves the world fully usable when the delete is refused after the marker is written', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-lifecycle-refused-'))
    const store = await SqliteStore.open(join(stateRoot, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '公司', templateId: 'cyber-company' })
    const roots = new WorldRootService(stateRoot)
    await roots.ensure(world.id)
    const lifecycle = new WorldLifecycleService({ store, roots })

    await roots.markPendingDelete(world.id)
    await roots.clearPendingDelete(world.id)
    expect(await lifecycle.sweepInterrupted()).toEqual([])
    expect(store.getWorld(world.id)).toBeDefined()
    expect(await readdir(join(stateRoot, 'worlds', encodeURIComponent(world.id))))
      .not.toContain('.pending-delete')
  })
})
