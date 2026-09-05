import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorldArtifactRepository } from '@dsh-cyber/persistence'

import { AgentRunFileEvidenceService } from '../src/services/agent-run-file-evidence.js'
import { WorldArtifactService } from '../src/services/world-artifact-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'

const stores: Array<{ close(): void }> = []
const rootsToRemove: string[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of rootsToRemove.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('AgentRun file evidence', () => {
  it('binds a file to the run that wrote it inside the host-observed bracket', async () => {
    const fixture = await createFixture()
    const bracket = await fixture.evidence.begin({
      worldId: fixture.world.id,
      agentRunId: fixture.run.id,
      workspacePath: fixture.root.filesPath,
    })
    await writeFile(join(fixture.root.filesPath, 'analysis.md'), '# generated analysis\n')
    const record = await fixture.evidence.complete(bracket)

    expect(record?.files).toHaveLength(1)
    expect(record?.files[0]).toMatchObject({ path: 'analysis.md', change: 'created', exclusive: true })
    expect(record?.truncated).toBe(false)

    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.messageMetadata).toMatchObject({
      artifactCount: 1,
      completionOutcome: 'artifacts-published',
      artifactDiscovery: 'host-evidence',
      artifactEvidence: 'host-observed',
    })
    const artifactId = contribution.artifactRefs![0]!
    const view = await fixture.service.describe(fixture.world.id, artifactId)
    expect(view.evidence).toEqual([expect.objectContaining({ version: 1, grade: 'host-observed', proven: true })])
  })

  it('never reports a text-only reply as a landed file, and does not fall back to the time window', async () => {
    const fixture = await createFixture()
    // A file that already existed before the run. The old time-window scan
    // registered exactly this kind of file as if the run had produced it.
    const stale = join(fixture.root.filesPath, 'stale.md')
    await writeFile(stale, '# written before the run\n')
    const bracket = await fixture.evidence.begin({
      worldId: fixture.world.id,
      agentRunId: fixture.run.id,
      workspacePath: fixture.root.filesPath,
    })
    const record = await fixture.evidence.complete(bracket)
    expect(record?.files).toEqual([])

    const contribution = await fixture.service.publishAgentRun({
      ...fixture.context(),
      runStartedAt: new Date(Date.now() - 60_000).toISOString(),
      runCompletedAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(contribution).toEqual({
      messageMetadata: { artifactCount: 0, completionOutcome: 'text-only', artifactDiscovery: 'host-evidence', artifactEvidence: 'none' },
    })
    expect(fixture.service.list(fixture.world.id)).toEqual([])
  })

  it('does not call a run text-only when the host saw writes it could not publish', async () => {
    const fixture = await createFixture()
    const bracket = await fixture.evidence.begin({ worldId: fixture.world.id, agentRunId: fixture.run.id, workspacePath: fixture.root.filesPath })
    const target = join(fixture.root.filesPath, 'draft.md')
    await writeFile(target, '# will be deleted before publication\n')
    const record = await fixture.evidence.complete(bracket)
    expect(record?.files).toHaveLength(1)
    await rm(target)

    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.messageMetadata).toMatchObject({
      artifactCount: 0,
      completionOutcome: 'no-artifact',
      artifactFailureCount: 1,
      artifactFailures: [{ path: 'draft.md', code: 'artifact_source_not_found' }],
    })
    expect(contribution.messageMetadata?.completionOutcome).not.toBe('text-only')
  })

  it('marks two runs writing the same file name in overlapping windows as unproven', async () => {
    const fixture = await createFixture()
    const secondRun = fixture.store.createAgentRun({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      turnId: fixture.turn.id,
      sessionId: fixture.session.id,
      employeeId: fixture.employee.id,
      ordinal: 2,
    })
    fixture.store.startAgentRun(secondRun.id)

    const first = await fixture.evidence.begin({ worldId: fixture.world.id, agentRunId: fixture.run.id, workspacePath: fixture.root.filesPath })
    const second = await fixture.evidence.begin({ worldId: fixture.world.id, agentRunId: secondRun.id, workspacePath: fixture.root.filesPath })
    await writeFile(join(fixture.root.filesPath, 'report.md'), '# written by one of two runs\n')
    const firstRecord = await fixture.evidence.complete(first)
    const secondRecord = await fixture.evidence.complete(second)

    expect(firstRecord?.files[0]).toMatchObject({ path: 'report.md', exclusive: false })
    expect(firstRecord?.files[0]?.concurrentRunIds).toContain(secondRun.id)
    expect(secondRecord?.files[0]).toMatchObject({ path: 'report.md', exclusive: false })
    expect(secondRecord?.files[0]?.concurrentRunIds).toContain(fixture.run.id)

    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.messageMetadata).toMatchObject({
      artifactCount: 1,
      artifactEvidence: 'shared-window',
      unprovenArtifactCount: 1,
    })
    const view = await fixture.service.describe(fixture.world.id, contribution.artifactRefs![0]!)
    expect(view.evidence?.[0]).toMatchObject({ grade: 'shared-window', proven: false })
  })

  it('reports a bounded scan of a large workspace instead of silently truncating it', async () => {
    const fixture = await createFixture({ maxEntries: 4 })
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(fixture.root.filesPath, `existing-${index}.md`), `# ${index}\n`)
    }
    const bracket = await fixture.evidence.begin({ worldId: fixture.world.id, agentRunId: fixture.run.id, workspacePath: fixture.root.filesPath })
    await writeFile(join(fixture.root.filesPath, 'summary.md'), '# summary\n')
    const record = await fixture.evidence.complete(bracket)
    expect(record?.truncated).toBe(true)
    expect(record?.scannedEntries).toBe(4)
    expect(record?.entryLimit).toBe(4)

    await writeManifest(fixture, [{ path: 'summary.md', title: '摘要', kind: 'markdown' }])
    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.messageMetadata).toMatchObject({
      artifactCount: 1,
      artifactDiscovery: 'manifest',
      artifactEvidence: 'manifest-declared',
      evidenceScanTruncated: true,
    })
    const view = await fixture.service.describe(fixture.world.id, contribution.artifactRefs![0]!)
    expect(view.evidence?.[0]).toMatchObject({ grade: 'manifest-declared', proven: false })
  })

  it('reports an unproven time-window candidate set that exceeds the bound instead of failing the whole run', async () => {
    const fixture = await createFixture()
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(fixture.root.filesPath, `bulk-${index}.md`), `# ${index}\n`)
    }
    const contribution = await fixture.service.publishAgentRun({
      ...fixture.context(),
      runStartedAt: new Date(Date.now() - 60_000).toISOString(),
      runCompletedAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(contribution.messageMetadata).toMatchObject({
      artifactCount: 0,
      completionOutcome: 'no-artifact',
      artifactDiscovery: 'run-window',
      discoveryTruncated: true,
      discoveryCandidateCount: 40,
    })
    expect(fixture.service.list(fixture.world.id)).toEqual([])
  })

  it('publishes the manifest entries that exist and reports the ones that fail', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.root.filesPath, 'good.md'), '# good\n')
    await writeManifest(fixture, [
      { path: 'good.md', title: '可用文件', kind: 'markdown' },
      { path: 'missing.md', title: '缺失文件', kind: 'markdown' },
    ])

    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.artifactRefs).toHaveLength(1)
    expect(contribution.messageMetadata).toMatchObject({
      artifactCount: 1,
      artifactFailureCount: 1,
      artifactFailures: [{ path: 'missing.md', code: 'artifact_source_not_found' }],
    })
    expect(fixture.service.list(fixture.world.id)).toHaveLength(1)
  })

  it('still refuses a whole manifest that tries to escape the world workspace', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.root.filesPath, 'good.md'), '# good\n')
    await writeManifest(fixture, [
      { path: 'good.md', title: '可用文件', kind: 'markdown' },
      { path: '../secret.txt', title: '越界', kind: 'other' },
    ])
    await expect(fixture.service.publishAgentRun(fixture.context())).rejects.toMatchObject({ code: 'artifact_path_invalid' })
  })

  it('recovers idempotently when post-processing crashed after registering part of the manifest', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.root.filesPath, 'first.md'), '# first\n')
    await writeFile(join(fixture.root.filesPath, 'second.md'), '# second\n')
    await writeManifest(fixture, [
      { path: 'first.md', title: '第一份', kind: 'markdown' },
      { path: 'second.md', title: '第二份', kind: 'markdown' },
      { path: 'third.md', title: '第三份', kind: 'markdown' },
    ])

    // The third file does not exist yet: the first pass registers two of three.
    const partial = await fixture.service.publishAgentRun(fixture.context())
    expect(partial.artifactRefs).toHaveLength(2)

    // Crash simulation: the registry row of the second publication is lost
    // after its bytes were already moved into the immutable exports area.
    const lost = partial.artifactRefs![1]!
    expect(fixture.store.database.prepare('DELETE FROM world_artifacts WHERE world_id = ? AND id = ?').run(fixture.world.id, lost).changes).toBe(1)

    await writeFile(join(fixture.root.filesPath, 'third.md'), '# third\n')
    const recovered = await fixture.service.publishAgentRun(fixture.context())
    expect(recovered.artifactRefs).toHaveLength(3)
    expect(new Set(recovered.artifactRefs)).toEqual(new Set([...partial.artifactRefs!, recovered.artifactRefs!.find((id) => !partial.artifactRefs!.includes(id))!]))
    expect(fixture.service.list(fixture.world.id)).toHaveLength(3)
    for (const artifactId of recovered.artifactRefs!) {
      expect(fixture.service.get(fixture.world.id, artifactId).versions).toHaveLength(1)
    }
  })

  it('keeps an owner publication out of the run attribution grades', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.root.filesPath, 'manual.md'), '# manual\n')
    const publication = await fixture.service.publishFromWorkspace({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      sourceRelativePath: 'manual.md',
      title: '手动发布',
      kind: 'markdown',
      createdByKind: 'owner',
      createdById: 'local-user',
    })
    const view = await fixture.service.describe(fixture.world.id, publication.artifact.id)
    expect(view.evidence?.[0]).toMatchObject({ grade: 'owner-published', proven: false })
  })

  it('does not treat a file that changed after the run as the observed content', async () => {
    const fixture = await createFixture()
    const bracket = await fixture.evidence.begin({ worldId: fixture.world.id, agentRunId: fixture.run.id, workspacePath: fixture.root.filesPath })
    const target = join(fixture.root.filesPath, 'draft.md')
    await writeFile(target, '# observed content\n')
    await fixture.evidence.complete(bracket)
    // Something rewrote the workspace file between the run ending and the
    // completion job publishing it.
    await writeFile(target, '# rewritten after the run\n')
    await utimes(target, new Date(), new Date())

    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.messageMetadata).toMatchObject({ artifactCount: 1, artifactEvidence: 'shared-window' })
    const view = await fixture.service.describe(fixture.world.id, contribution.artifactRefs![0]!)
    expect(view.evidence?.[0]).toMatchObject({ grade: 'shared-window', proven: false, contentMatchesObservation: false })
  })

  it('does not call a project directory host-observed when its bytes were replaced after the run', async () => {
    const fixture = await createFixture()
    const bracket = await fixture.evidence.begin({ worldId: fixture.world.id, agentRunId: fixture.run.id, workspacePath: fixture.root.filesPath })
    const project = join(fixture.root.filesPath, 'site')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'index.html'), '<!doctype html><h1>observed</h1>')
    const record = await fixture.evidence.complete(bracket)
    expect(record?.files).toEqual([expect.objectContaining({ path: 'site/index.html', exclusive: true })])

    await writeManifest(fixture, [{ path: 'site', title: '站点', kind: 'project', entrypoint: 'index.html' }])
    // The bracket is closed. The completion job publishes later, so anything
    // may still rewrite the directory in between.
    await writeFile(join(project, 'index.html'), '<!doctype html><h1>replaced after the run</h1>')
    await utimes(join(project, 'index.html'), new Date(), new Date())

    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.messageMetadata).toMatchObject({ artifactCount: 1, artifactEvidence: 'shared-window' })
    const view = await fixture.service.describe(fixture.world.id, contribution.artifactRefs![0]!)
    expect(view.evidence?.[0]).toMatchObject({ grade: 'shared-window', proven: false, contentMatchesObservation: false })
    expect(view.evidence?.[0]?.proven).toBe(false)
  })

  it('does not call a project directory host-observed when it carries a file no bracket ever covered', async () => {
    const fixture = await createFixture()
    const bracket = await fixture.evidence.begin({ worldId: fixture.world.id, agentRunId: fixture.run.id, workspacePath: fixture.root.filesPath })
    const project = join(fixture.root.filesPath, 'site')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'index.html'), '<!doctype html><h1>observed</h1>')
    await fixture.evidence.complete(bracket)

    await writeManifest(fixture, [{ path: 'site', title: '站点', kind: 'project', entrypoint: 'index.html' }])
    // Every observed file still holds the observed bytes, but the tree the user
    // will read is not the tree the host saw land.
    await writeFile(join(project, 'smuggled.js'), 'console.log("never observed")\n')

    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.messageMetadata).toMatchObject({ artifactCount: 1, artifactEvidence: 'shared-window' })
    const view = await fixture.service.describe(fixture.world.id, contribution.artifactRefs![0]!)
    expect(view.evidence?.[0]).toMatchObject({ grade: 'shared-window', proven: false, contentMatchesObservation: false })
  })

  it('still proves a project directory the run wrote whole and nobody touched afterwards', async () => {
    const fixture = await createFixture()
    const bracket = await fixture.evidence.begin({ worldId: fixture.world.id, agentRunId: fixture.run.id, workspacePath: fixture.root.filesPath })
    const project = join(fixture.root.filesPath, 'site')
    await mkdir(join(project, 'assets'), { recursive: true })
    await writeFile(join(project, 'index.html'), '<!doctype html><h1>observed</h1>')
    await writeFile(join(project, 'assets', 'data.json'), '{"ok":true}\n')
    await fixture.evidence.complete(bracket)
    await writeManifest(fixture, [{ path: 'site', title: '站点', kind: 'project', entrypoint: 'index.html' }])

    const contribution = await fixture.service.publishAgentRun(fixture.context())
    expect(contribution.messageMetadata).toMatchObject({ artifactCount: 1, artifactEvidence: 'host-observed' })
    const view = await fixture.service.describe(fixture.world.id, contribution.artifactRefs![0]!)
    expect(view.evidence?.[0]).toMatchObject({ grade: 'host-observed', proven: true, contentMatchesObservation: true })
  })
})

describe('CharacterProfileRuntime run bracket', () => {
  it('brackets every run it forwards, including a turn the inner runtime failed', async () => {
    const calls: Array<{ kind: 'begin' | 'complete'; agentRunId: string }> = []
    const evidence = {
      async begin(input: { worldId: string; agentRunId: string; workspacePath: string }) {
        calls.push({ kind: 'begin', agentRunId: input.agentRunId })
        return { worldId: input.worldId, agentRunId: input.agentRunId, workspacePath: input.workspacePath, startedAtMs: 0, baseline: new Map(), truncated: false, scannedEntries: 0 }
      },
      async complete(bracket: { agentRunId: string } | undefined) {
        if (bracket !== undefined) calls.push({ kind: 'complete', agentRunId: bracket.agentRunId })
        return undefined
      },
    }
    const { CharacterProfileRuntime } = await import('../src/services/character-profile-runtime.js')
    const store = {
      getEmployee: () => undefined,
      getEmployeeRevision: () => undefined,
      getEmployeeProfile: () => undefined,
      getWorld: () => undefined,
    }
    const failing = {
      async runTurn() { throw new Error('inner turn failed') },
      async close() {},
    }
    const runtime = new CharacterProfileRuntime(failing, store, undefined, undefined, undefined, undefined, undefined, undefined, evidence)
    await expect(runtime.runTurn({
      agent: { id: 'character-1', workspaceId: 'workspace-1', worldId: 'world-1', blueprintId: 'core.butler', blueprintVersion: 1, displayName: '管家', role: '世界管家', status: 'available', currentRevision: 1, createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z' },
      revision: { employeeId: 'character-1', revision: 1, persona: '基础设定', skillGrants: [], capabilityGrants: [], modelPolicy: {}, reason: '测试', createdAt: '2026-08-21T00:00:00.000Z' },
      conversationId: 'session-1',
      history: [],
      observedThroughSequence: 0,
      agentRunId: 'run-1',
      prompt: '写一份报告',
      workspacePath: '/tmp/world/files',
      permissionMode: 'workspace-write',
    })).rejects.toThrow('inner turn failed')

    expect(calls).toEqual([
      { kind: 'begin', agentRunId: 'run-1' },
      { kind: 'complete', agentRunId: 'run-1' },
    ])
  })
})

async function writeManifest(fixture: Awaited<ReturnType<typeof createFixture>>, artifacts: unknown[]): Promise<void> {
  await mkdir(fixture.root.dshArtifactsPath, { recursive: true })
  await writeFile(join(fixture.root.dshArtifactsPath, `${fixture.run.id}.json`), JSON.stringify({ schemaVersion: 1, artifacts }))
}

async function createFixture(limits?: { maxEntries?: number }) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-run-evidence-'))
  rootsToRemove.push(stateRoot)
  const { SqliteStore } = await import('@dsh-cyber/persistence')
  const store = await SqliteStore.open(join(stateRoot, 'data.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '证据世界', templateId: 'personal-world' })
  store.saveBlueprint({
    schemaVersion: 1,
    id: 'evidence-worker',
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
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'evidence-worker', blueprintVersion: 1 })
  const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '证据测试', participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }] })
  const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
  store.startWorkTurn(turn.id)
  const run = store.createAgentRun({ workspaceId: workspace.id, worldId: world.id, turnId: turn.id, sessionId: session.id, employeeId: employee.id, ordinal: 1 })
  store.startAgentRun(run.id)
  const roots = new WorldRootService(stateRoot)
  const root = await roots.ensure(world.id)
  const evidence = new AgentRunFileEvidenceService({ roots, ...(limits === undefined ? {} : { limits }) })
  const service = new WorldArtifactService({ repository: new WorldArtifactRepository(store.database), roots, evidence })
  return {
    stateRoot,
    store,
    workspace,
    world,
    employee,
    session,
    turn,
    run,
    roots,
    root,
    evidence,
    service,
    context: () => ({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: employee.id,
      sessionId: session.id,
      workTurnId: turn.id,
      agentRunId: run.id,
      workspacePath: root.filesPath,
    }),
  }
}
