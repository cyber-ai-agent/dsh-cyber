import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorldArtifactRepository } from '@dsh-cyber/persistence'

import { ServiceError } from '../src/services/service-error.js'
import { WorldArtifactService } from '../src/services/world-artifact-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'
import { WorkspaceFileService } from '../src/services/workspace-file-service.js'

const stores: Array<{ close(): void }> = []
const rootsToRemove: string[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of rootsToRemove.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('WorldArtifactService', () => {
  it('publishes the exact run manifest, survives a registry retry, and serves project tree/file previews', async () => {
    const fixture = await createFixture()
    const { root, service, run, store } = fixture
    const project = join(root.filesPath, 'site')
    await mkdir(join(project, 'assets'), { recursive: true })
    await writeFile(join(project, 'index.html'), '<!doctype html><h1>safe</h1>')
    await writeFile(join(project, 'assets', 'data.json'), '{"ok":true}\n')
    const manifestPath = join(root.dshArtifactsPath, `${run.id}.json`)
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      artifacts: [{ path: 'site', title: '安全站点', kind: 'project', entrypoint: 'index.html' }],
    }))

    const context = {
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      employeeId: fixture.employee.id,
      sessionId: fixture.session.id,
      workTurnId: fixture.turn.id,
      agentRunId: run.id,
      workspacePath: root.filesPath,
    }
    const first = await service.publishAgentRun(context)
    expect(first.artifactRefs).toHaveLength(1)
    const artifactId = first.artifactRefs![0]!
    expect(service.list(fixture.world.id)).toHaveLength(1)
    expect(service.get(fixture.world.id, artifactId).versions).toHaveLength(1)

    const tree = await service.preview(fixture.world.id, artifactId)
    expect(tree.contentType).toBe('application/json; charset=utf-8')
    expect(tree.body.toString('utf8')).toContain('index.html')
    const selected = await service.preview(fixture.world.id, artifactId, undefined, 'index.html')
    expect(selected.isHtml).toBe(true)
    expect(selected.body.toString('utf8')).toContain('<h1>safe</h1>')

    // Simulate a process dying after the atomic move but before the registry
    // commit. The deterministic run/path id lets retry register the same tree.
    expect(store.database.prepare('DELETE FROM world_artifacts WHERE world_id = ? AND id = ?').run(fixture.world.id, artifactId).changes).toBe(1)
    const retry = await service.publishAgentRun(context)
    expect(retry.artifactRefs).toEqual([artifactId])
    expect(service.get(fixture.world.id, artifactId).versions).toHaveLength(1)
  })

  it('rejects traversal, .dsh sources, and a workspace outside the current world files root', async () => {
    const fixture = await createFixture()
    const { root, service, run } = fixture
    const manifestPath = join(root.dshArtifactsPath, `${run.id}.json`)
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, artifacts: [{ path: '../secret.txt', title: '越界', kind: 'other' }] }))
    await expect(service.publishAgentRun({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      employeeId: fixture.employee.id,
      sessionId: fixture.session.id,
      workTurnId: fixture.turn.id,
      agentRunId: run.id,
      workspacePath: root.filesPath,
    })).rejects.toMatchObject<ServiceError>({ code: 'artifact_path_invalid' })

    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, artifacts: [{ path: '.dsh/secret.json', title: '控制文件', kind: 'data' }] }))
    await expect(service.publishAgentRun({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      employeeId: fixture.employee.id,
      sessionId: fixture.session.id,
      workTurnId: fixture.turn.id,
      agentRunId: run.id,
      workspacePath: root.filesPath,
    })).rejects.toMatchObject<ServiceError>({ code: 'artifact_path_invalid' })

    const outside = await mkdtemp(join(tmpdir(), 'dsh-artifact-outside-'))
    rootsToRemove.push(outside)
    await expect(service.publishAgentRun({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      employeeId: fixture.employee.id,
      sessionId: fixture.session.id,
      workTurnId: fixture.turn.id,
      agentRunId: run.id,
      workspacePath: outside,
    })).rejects.toMatchObject<ServiceError>({ code: 'artifact_workspace_invalid' })

    await expect(service.publishAgentRun({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      employeeId: fixture.employee.id,
      sessionId: fixture.session.id,
      workTurnId: fixture.turn.id,
      agentRunId: run.id,
      workspacePath: root.restrictedFilesPath,
    })).resolves.toEqual({ messageMetadata: { artifactCount: 0, completionOutcome: 'no-artifact' } })
  })

  it('auto-registers only real world files changed inside the AgentRun window when no manifest exists', async () => {
    const fixture = await createFixture()
    const oldFile = join(fixture.root.filesPath, 'existing.md')
    const generatedFile = join(fixture.root.filesPath, 'analysis.md')
    await writeFile(oldFile, '# existing\n')
    await utimes(oldFile, new Date('2026-08-20T00:00:00.000Z'), new Date('2026-08-20T00:00:00.000Z'))
    await writeFile(generatedFile, '# generated analysis\n')
    const contribution = await fixture.service.publishAgentRun({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      employeeId: fixture.employee.id,
      sessionId: fixture.session.id,
      workTurnId: fixture.turn.id,
      agentRunId: fixture.run.id,
      workspacePath: fixture.root.filesPath,
      runStartedAt: new Date(Date.now() - 5_000).toISOString(),
      runCompletedAt: new Date(Date.now() + 5_000).toISOString(),
    })
    expect(contribution).toMatchObject({
      artifactRefs: [expect.any(String)],
      messageMetadata: { artifactCount: 1, completionOutcome: 'artifacts-published', artifactDiscovery: 'run-window' },
    })
    const artifacts = fixture.service.list(fixture.world.id)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ title: 'analysis.md', kind: 'markdown' })
    expect(fixture.service.get(fixture.world.id, artifacts[0]!.id).versions[0]).toMatchObject({ sourceRelativePath: 'analysis.md', agentRunId: fixture.run.id })
    expect((await fixture.service.preview(fixture.world.id, artifacts[0]!.id)).body.toString('utf8')).toContain('generated analysis')
  })

  it('honors an explicit empty manifest and reports an honest no-artifact outcome', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.root.filesPath, 'temporary.md'), '# not published\n')
    await writeFile(join(fixture.root.dshArtifactsPath, `${fixture.run.id}.json`), JSON.stringify({ schemaVersion: 1, artifacts: [] }))
    const contribution = await fixture.service.publishAgentRun({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      employeeId: fixture.employee.id,
      sessionId: fixture.session.id,
      workTurnId: fixture.turn.id,
      agentRunId: fixture.run.id,
      workspacePath: fixture.root.filesPath,
      runStartedAt: new Date(Date.now() - 5_000).toISOString(),
      runCompletedAt: new Date(Date.now() + 5_000).toISOString(),
    })
    expect(contribution).toEqual({ messageMetadata: { artifactCount: 0, completionOutcome: 'no-artifact' } })
    expect(fixture.service.list(fixture.world.id)).toEqual([])
  })

  it('keeps the publication seam hidden from the normal workspace file list', async () => {
    const fixture = await createFixture()
    const listing = await new WorkspaceFileService(fixture.root.filesPath).list('')
    expect(listing.items.some((item) => item.name === '.dsh')).toBe(false)
  })

  it('publishes Browser screenshots from managed cache without writing world/files', async () => {
    const fixture = await createFixture()
    const bytes = Buffer.from('browser-png-bytes')
    const publication = await fixture.service.publishBrowserScreenshot({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      bytes,
      title: '网页截图',
      createdById: fixture.employee.id,
      workTurnId: fixture.turn.id,
      agentRunId: fixture.run.id,
      idempotencyKey: 'browser-screenshot:test-1',
    })
    expect(publication.artifact.kind).toBe('image')
    expect(publication.version.relativePath).toContain('exports/artifacts/')
    expect((await fixture.service.preview(fixture.world.id, publication.artifact.id)).body).toEqual(bytes)
    expect(await readdir(join(fixture.root.cachePath, 'browser-screenshots'))).toEqual([])
    await expect(readFile(join(fixture.root.filesPath, 'browser-screenshots', 'test-1.png'))).rejects.toThrow()
  })

  it('removes only the published version directory and keeps the workspace source', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.root.filesPath, 'report.md'), '# source\n')
    const publication = await fixture.service.publishFromWorkspace({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      sourceRelativePath: 'report.md',
      title: '报告',
      kind: 'markdown',
      createdByKind: 'owner',
      createdById: 'local-user',
    })
    const publishedPath = join(fixture.root.rootPath, ...publication.version.relativePath.split('/'))

    await fixture.service.remove(fixture.world.id, publication.artifact.id)

    expect(fixture.service.list(fixture.world.id)).toEqual([])
    await expect(readFile(publishedPath, 'utf8')).rejects.toThrow()
    await expect(readFile(join(fixture.root.filesPath, 'report.md'), 'utf8')).resolves.toContain('# source')
  })
})

async function createFixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-artifact-service-'))
  rootsToRemove.push(stateRoot)
  const { SqliteStore } = await import('@dsh-cyber/persistence')
  const store = await SqliteStore.open(join(stateRoot, 'data.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '安全世界', templateId: 'personal-world' })
  store.saveBlueprint({
    schemaVersion: 1,
    id: 'artifact-worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '产物工',
    role: '工程师',
    summary: '测试角色',
    persona: '只生成测试产物。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-25T00:00:00.000Z',
  })
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'artifact-worker', blueprintVersion: 1 })
  const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '产物测试', participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }] })
  const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
  store.startWorkTurn(turn.id)
  const run = store.createAgentRun({ workspaceId: workspace.id, worldId: world.id, turnId: turn.id, sessionId: session.id, employeeId: employee.id, ordinal: 1 })
  store.startAgentRun(run.id)
  const roots = new WorldRootService(stateRoot)
  const root = await roots.ensure(world.id)
  const service = new WorldArtifactService({ repository: new WorldArtifactRepository(store.database), roots })
  return { stateRoot, store, workspace, world, employee, session, turn, run, roots, root, service }
}
