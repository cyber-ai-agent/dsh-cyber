import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { CyberPackageManifest, EmployeeBlueprint } from '@dsh-cyber/contracts'

import { SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'lifecycle-engineer',
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName: '小陈',
    role: '软件工程师',
    summary: '交付可靠的软件。',
    persona: '先澄清验收标准，再实现和验证。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-19T00:00:00.000Z',
  }
}

function manifest(): CyberPackageManifest {
  return {
    schemaVersion: 1,
    id: '@cyber/library-example',
    version: '1.0.0',
    kind: 'skill',
    displayName: '工作区技能库',
    summary: '验证世界删除不会波及全局包库。',
    license: 'PolyForm-Noncommercial-1.0.0',
    publisher: 'DSH Cyber',
    capabilities: ['workspace:read'],
    dataEgress: [],
    files: [{ path: 'SKILL.md', sha256: 'b'.repeat(64) }],
  }
}

async function scenario() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-lifecycle-'))
  const path = join(root, 'cyber.sqlite')
  const store = await SqliteStore.open(path)
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '赛博公司', templateId: 'cyber-company' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'lifecycle-engineer',
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
  return { root, path, store, workspace, world, employee, session }
}

describe('world archive and restore', () => {
  it('keeps an archived world out of the default list and brings it back on restore', async () => {
    const { store, workspace, world } = await scenario()

    expect(store.listWorlds(workspace.id).map((item) => item.id)).toEqual([world.id])

    const archived = store.archiveWorld({ worldId: world.id })
    expect(archived.status).toBe('archived')
    expect(store.listWorlds(workspace.id)).toEqual([])
    expect(store.listWorlds(workspace.id, true).map((item) => item.id)).toEqual([world.id])

    const restored = store.restoreWorld({ worldId: world.id })
    expect(restored.status).toBe('active')
    expect(store.listWorlds(workspace.id).map((item) => item.id)).toEqual([world.id])
  })

  it('destroys nothing: characters, conversations and knowledge survive archive and a restart', async () => {
    const { store, path, workspace, world, employee, session } = await scenario()
    store.appendMessage({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '归档前写下的一句话',
    })
    const messagesBefore = store.listMessages(session.id).length
    const employeesBefore = store.listEmployees(world.id).length
    const revisionsBefore = store.listEmployeeRevisions(employee.id).length

    store.archiveWorld({ worldId: world.id })

    // Same process, right after archiving.
    expect(store.listEmployees(world.id)).toHaveLength(employeesBefore)
    expect(store.listSessions(world.id).map((item) => item.id)).toContain(session.id)
    expect(store.listMessages(session.id)).toHaveLength(messagesBefore)

    // And after a process restart: the archive must be durable, not in-memory.
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.getWorld(world.id)?.status).toBe('archived')
    expect(reopened.listEmployees(world.id)).toHaveLength(employeesBefore)
    expect(reopened.listEmployeeRevisions(employee.id)).toHaveLength(revisionsBefore)
    expect(reopened.listMessages(session.id).at(-1)?.content).toBe('归档前写下的一句话')

    const restored = reopened.restoreWorld({ worldId: world.id })
    expect(restored.status).toBe('active')
    expect(reopened.listMessages(session.id)).toHaveLength(messagesBefore)
  })

  it('refuses to start any work in an archived world', async () => {
    const { store, workspace, world, employee, session } = await scenario()
    const runnable = store.createWorkTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'chat',
    })

    store.archiveWorld({ worldId: world.id })

    expect(() => store.createWorkTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'chat',
    })).toThrowError(/archived/i)

    expect(() => store.createAgentRun({
      workspaceId: workspace.id,
      worldId: world.id,
      turnId: runnable.id,
      sessionId: session.id,
      employeeId: employee.id,
      ordinal: 1,
    })).toThrowError(/archived/i)

    expect(() => store.enqueueConversationTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      workTurnId: runnable.id,
      employeeIds: [employee.id],
      conversationKind: 'direct',
    })).toThrowError(/archived/i)

    // Restoring makes the world workable again.
    store.restoreWorld({ worldId: world.id })
    expect(store.createWorkTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'chat',
    }).status).toBe('queued')
  })
})

describe('permanent world deletion', () => {
  it('requires the world name to be re-typed exactly', async () => {
    const { store, world } = await scenario()

    expect(() => store.deleteWorld({ worldId: world.id, confirmationName: '赛博' }))
      .toThrowError(/confirmation/i)
    expect(store.getWorld(world.id)).toBeDefined()

    store.deleteWorld({ worldId: world.id, confirmationName: '赛博公司' })
    expect(store.getWorld(world.id)).toBeUndefined()
  })

  it('refuses to delete a world that still has a running WorkTurn', async () => {
    const { store, workspace, world, session } = await scenario()
    const turn = store.createWorkTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'chat',
    })
    store.startWorkTurn(turn.id)

    expect(store.hasActiveWorldWork(world.id)).toBe(true)
    expect(() => store.deleteWorld({ worldId: world.id, confirmationName: world.name }))
      .toThrowError(/work in flight/i)
    expect(store.getWorld(world.id)).toBeDefined()

    store.completeWorkTurn(turn.id)
    expect(store.hasActiveWorldWork(world.id)).toBe(false)
    store.deleteWorld({ worldId: world.id, confirmationName: world.name })
    expect(store.getWorld(world.id)).toBeUndefined()
  })

  it('removes every record the world owned', async () => {
    const { store, workspace, world, employee, session } = await scenario()
    store.appendMessage({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '删除前的消息',
    })
    const turn = store.createWorkTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'chat',
    })
    store.startWorkTurn(turn.id)
    store.completeWorkTurn(turn.id)

    store.deleteWorld({ worldId: world.id, confirmationName: world.name })

    const count = (table: string, column: string, value: string) =>
      Number((store.database.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`)
        .get(value) as { total: number }).total)
    expect(count('worlds', 'id', world.id)).toBe(0)
    expect(count('work_sessions', 'world_id', world.id)).toBe(0)
    expect(count('messages', 'session_id', session.id)).toBe(0)
    expect(count('work_turns', 'world_id', world.id)).toBe(0)
    expect(count('employee_instances', 'world_id', world.id)).toBe(0)
    expect(count('employee_revisions', 'employee_id', employee.id)).toBe(0)
    expect(count('domain_events', 'world_id', world.id)).toBe(0)
    // The workspace itself is untouched and still records the deletion.
    expect(store.getWorkspace(workspace.id)).toBeDefined()
    expect(store.listDomainEvents(workspace.id).some((event) => event.type === 'world.deleted')).toBe(true)
  })

  it('never deletes the globally installed package library', async () => {
    const { root, store, workspace, world } = await scenario()
    const pack = manifest()
    const transaction = store.beginPackageInstall({
      workspaceId: workspace.id,
      manifest: pack,
      approvedCapabilities: pack.capabilities,
    })
    store.markPackageInstallStaged(transaction.id)
    const installed = store.completePackageInstall({
      transactionId: transaction.id,
      manifest: pack,
      installedPath: join(root, 'packages', 'installed', 'library-example', '1.0.0'),
    })
    const instance = store.createWorldPackageInstance({
      workspaceId: workspace.id,
      worldId: world.id,
      packageId: pack.id,
      packageVersion: pack.version,
      packageKind: pack.kind,
      contentDigest: 'c'.repeat(64),
      originPath: 'source/packages/library-example/origin',
      overridesPath: 'source/packages/library-example/overrides',
    })
    expect(store.listWorldPackageInstances(world.id)).toHaveLength(1)

    store.deleteWorld({ worldId: world.id, confirmationName: world.name })

    // The world's private instance is gone...
    expect(store.getWorldPackageInstance(instance.id)).toBeUndefined()
    // ...but the workspace-wide library it was instantiated from survives.
    // The library is a workspace asset; deleting one world must never take it.
    expect(store.listInstalledPackages(workspace.id).map((item) => item.packageId)).toEqual([pack.id])
    expect(store.getActivePackage(workspace.id, pack.id)?.version).toBe(installed.version)
  })
})
