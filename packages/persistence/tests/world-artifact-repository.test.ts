import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  type EmployeeBlueprint,
} from '@dsh-cyber/contracts'

import { SqliteStore, WorldArtifactRepository } from '../src/index.js'

const stores: SqliteStore[] = []
const sha256 = (value: string): string => (value === 'v2' || value === 'b' ? 'b' : 'a').repeat(64)

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function database(): Promise<SqliteStore> {
  const directory = await fsMkdtemp(join(tmpdir(), 'dsh-cyber-artifacts-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  return store
}

function blueprint(id: string, displayName: string): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName,
    role: '工程师',
    summary: '负责交付',
    persona: '严谨交付',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-25T00:00:00.000Z',
  }
}

describe('WorldArtifactRepository', () => {
  it('publishes immutable versions, preserves provenance, and retries by idempotency key', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '产物工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '产物世界', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint('artifact-engineer', '小刘'))
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'artifact-engineer',
      blueprintVersion: 1,
    })
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '交付' })
    const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
    const run = store.createAgentRun({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      turnId: turn.id,
      employeeId: employee.id,
      ordinal: 1,
    })
    const repository = new WorldArtifactRepository(store.database)

    const first = repository.publish({
      workspaceId: workspace.id,
      worldId: world.id,
      title: '架构说明',
      description: '第一版',
      kind: 'markdown',
      relativePath: 'artifacts/architecture/v1.md',
      byteLength: 12,
      sha256: sha256('v1'),
      sourceRelativePath: 'dist/architecture.md',
      createdByKind: 'employee',
      createdById: employee.id,
      employeeId: employee.id,
      sessionId: session.id,
      workTurnId: turn.id,
      agentRunId: run.id,
      idempotencyKey: 'run-1:architecture.md',
      createdAt: '2026-08-25T00:01:00.000Z',
    })
    expect(first.created).toBe(true)
    expect(first.artifact).toMatchObject({ worldId: world.id, currentVersion: 1, createdById: employee.id })
    expect(first.version).toMatchObject({
      artifactId: first.artifact.id,
      version: 1,
      sourceRelativePath: 'dist/architecture.md',
      employeeId: employee.id,
      sessionId: session.id,
      workTurnId: turn.id,
      agentRunId: run.id,
      idempotencyKey: 'run-1:architecture.md',
    })

    const retry = repository.publish({
      workspaceId: workspace.id,
      worldId: world.id,
      artifactId: first.artifact.id,
      title: '架构说明',
      kind: 'markdown',
      relativePath: 'artifacts/architecture/v1.md',
      byteLength: 12,
      sha256: sha256('v1'),
      sourceRelativePath: 'dist/architecture.md',
      createdByKind: 'employee',
      createdById: employee.id,
      employeeId: employee.id,
      sessionId: session.id,
      workTurnId: turn.id,
      agentRunId: run.id,
      idempotencyKey: 'run-1:architecture.md',
    })
    expect(retry.created).toBe(false)
    expect(retry.version).toEqual(first.version)

    const second = repository.createVersion({
      workspaceId: workspace.id,
      worldId: world.id,
      artifactId: first.artifact.id,
      relativePath: 'artifacts/architecture/v2.md',
      byteLength: 24,
      sha256: sha256('v2'),
      sourceRelativePath: 'dist/architecture.md',
      employeeId: employee.id,
      sessionId: session.id,
      workTurnId: turn.id,
      agentRunId: run.id,
    })
    expect(second.created).toBe(true)
    expect(second.artifact.currentVersion).toBe(2)
    expect(repository.list(world.id, { query: '架构', kind: 'markdown', employeeId: employee.id })).toEqual([
      expect.objectContaining({ id: first.artifact.id }),
    ])
    expect(repository.listVersions(world.id, first.artifact.id).map((version) => version.version)).toEqual([1, 2])
    expect(repository.getVersion(world.id, first.artifact.id, 1)).toEqual(first.version)
    expect(store.doctor().counts).toMatchObject({ worldArtifacts: 1, worldArtifactVersions: 2 })
  })

  it('keeps registry and provenance world-scoped and rejects unsafe cross-world writes', async () => {
    const store = await database()
    const workspaceA = store.createWorkspace({ name: 'A' })
    const workspaceB = store.createWorkspace({ name: 'B' })
    const worldA = store.createWorld({ workspaceId: workspaceA.id, name: '世界 A', templateId: 'cyber-company' })
    const worldB = store.createWorld({ workspaceId: workspaceB.id, name: '世界 B', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint('cross-world', '角色'))
    const employeeA = store.recruitEmployee({ workspaceId: workspaceA.id, worldId: worldA.id, blueprintId: 'cross-world', blueprintVersion: 1 })
    const employeeB = store.recruitEmployee({ workspaceId: workspaceB.id, worldId: worldB.id, blueprintId: 'cross-world', blueprintVersion: 1 })
    const repository = new WorldArtifactRepository(store.database)
    const artifact = repository.publish({
      workspaceId: workspaceA.id,
      worldId: worldA.id,
      title: '仅 A 可见',
      kind: 'data',
      relativePath: 'exports/a.json',
      byteLength: 1,
      sha256: sha256('a'),
      createdByKind: 'owner',
      createdById: 'owner',
    })

    expect(repository.list(worldB.id)).toEqual([])
    expect(repository.get(worldB.id, artifact.artifact.id)).toBeUndefined()
    expect(() => repository.publish({
      workspaceId: workspaceB.id,
      worldId: worldB.id,
      artifactId: artifact.artifact.id,
      title: '越界',
      kind: 'data',
      relativePath: 'exports/b.json',
      byteLength: 1,
      sha256: sha256('b'),
      createdByKind: 'employee',
      createdById: employeeB.id,
    })).toThrow(/artifact not found/i)
    expect(() => repository.publish({
      workspaceId: workspaceA.id,
      worldId: worldA.id,
      title: '错误来源',
      kind: 'data',
      relativePath: 'exports/b.json',
      byteLength: 1,
      sha256: sha256('b'),
      createdByKind: 'owner',
      createdById: 'owner',
      employeeId: employeeB.id,
    })).toThrow(/outside this world/i)
  })

})

async function fsMkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(prefix)
}
