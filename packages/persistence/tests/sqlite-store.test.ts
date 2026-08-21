import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'

import {
  DatabaseCorruptError,
  SecretPersistenceError,
  SqliteStore,
  exportReadonlyRecovery,
} from '../src/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function testDatabase(): Promise<{ directory: string; path: string; store: SqliteStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-'))
  const path = join(directory, 'cyber.sqlite')
  const store = await SqliteStore.open(path)
  stores.push(store)
  return { directory, path, store }
}

function blueprint(overrides: Partial<EmployeeBlueprint> = {}): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'software-engineer',
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName: '小刘',
    role: '软件工程师',
    summary: '交付可靠的软件。',
    persona: '先澄清验收标准，再实现和验证。',
    requestedSkills: ['coding', 'testing'],
    requestedCapabilities: ['workspace:read'],
    createdAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  }
}

describe('SqliteStore', () => {
  it('starts with an empty organization and persists recruited employee revisions', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const world = store.createWorld({
      workspaceId: workspace.id,
      name: '赛博公司',
      templateId: 'cyber-company',
    })
    expect(store.listEmployees(world.id)).toEqual([])

    store.saveBlueprint(blueprint())
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
      skillGrants: ['coding'],
    })
    const revision = store.reviseEmployee({
      employeeId: employee.id,
      reason: '完成首轮能力评估',
      skillGrants: ['coding', 'testing'],
    })

    expect(revision.revision).toBe(2)
    expect(store.getEmployee(employee.id)?.currentRevision).toBe(2)
    expect(store.listEmployeeRevisions(employee.id)).toHaveLength(2)
    expect(store.getWorkspaceSnapshot(workspace.id).worlds).toHaveLength(1)
    expect(store.getWorldSnapshot(world.id).employees).toHaveLength(1)
  })

  it('limits initial and revised employee capability grants to the approved blueprint request', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: 'Grant boundary' })
    const world = store.createWorld({ workspaceId: workspace.id, name: 'Company', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint())
    expect(() => store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
      capabilityGrants: ['workspace:write'],
    })).toThrow('not requested by the blueprint')

    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
      capabilityGrants: ['workspace:read'],
    })
    expect(() => store.reviseEmployee({
      employeeId: employee.id,
      reason: 'attempt escalation',
      capabilityGrants: ['workspace:read', 'workspace:write'],
    })).toThrow('not requested by the blueprint')
    expect(() => store.reviseEmployee({
      employeeId: employee.id,
      reason: 'attempt skill escalation',
      skillGrants: ['shell-access'],
    })).toThrow('not requested by the blueprint')
    expect(store.reviseEmployee({
      employeeId: employee.id,
      reason: 'revoke all grants',
      skillGrants: [],
      capabilityGrants: [],
    })).toMatchObject({ skillGrants: [], capabilityGrants: [] })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.getEmployeeRevision(employee.id, 2)).toMatchObject({
      skillGrants: [],
      capabilityGrants: [],
    })
    expect(() => reopened.saveBlueprint(blueprint({ summary: 'changed without a version bump' })))
      .toThrow('identity is immutable')
  })

  it('persists direct and group session history across restart', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const world = store.createWorld({
      workspaceId: workspace.id,
      name: '赛博公司',
      templateId: 'cyber-company',
    })
    store.saveBlueprint(blueprint())
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '登录性能优化',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '@小刘 排查登录性能',
    })
    store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '收到，我先建立基线。',
    })
    store.bindEmployeeAgentSession(employee.id, 'harness-session-1')
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.listMessages(session.id).map((message) => message.content)).toEqual([
      '@小刘 排查登录性能',
      '收到，我先建立基线。',
    ])
    expect(reopened.getEmployee(employee.id)?.agentSessionId).toBe('harness-session-1')
    expect(reopened.doctor()).toMatchObject({ ok: true, schemaVersion: 10 })
  })

  it('writes every domain event and cloud-sync outbox entry atomically', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const world = store.createWorld({
      workspaceId: workspace.id,
      name: '赛博公司',
      templateId: 'cyber-company',
    })
    store.appendDomainEvent({
      workspaceId: workspace.id,
      worldId: world.id,
      type: 'task.started',
      actorId: 'employee-1',
      actorKind: 'employee',
      payload: { taskId: 'task-1', status: 'working' },
    })
    const doctor = store.doctor()
    expect(doctor.counts.events).toBe(3)
    expect(doctor.counts.outbox).toBe(3)
  })

  it('rejects secrets in event payloads while keeping message content out of event payloads', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const world = store.createWorld({
      workspaceId: workspace.id,
      name: '赛博公司',
      templateId: 'cyber-company',
    })
    expect(() =>
      store.appendDomainEvent({
        workspaceId: workspace.id,
        worldId: world.id,
        type: 'task.started',
        actorId: 'employee-1',
        actorKind: 'employee',
        payload: { api_token: 'must-not-persist' },
      }),
    ).toThrow(SecretPersistenceError)
    expect(store.doctor().counts.events).toBe(2)
  })

  it('creates verified backups and portable JSON exports', async () => {
    const { directory, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '赛博公司' })
    const world = store.createWorld({
      workspaceId: workspace.id,
      name: '赛博公司',
      templateId: 'cyber-company',
    })
    store.saveBlueprint(blueprint())
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '导出验收',
      participants: [{ participantId: employee.id, kind: 'employee' }],
    })
    store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '世界内记录',
    })
    const backupPath = join(directory, 'backup.sqlite')
    const exportPath = join(directory, 'export.json')
    await store.backup(backupPath)
    await store.exportJson(exportPath)

    expect((await stat(backupPath)).size).toBeGreaterThan(0)
    const backupStore = await SqliteStore.open(backupPath, { readOnly: true })
    stores.push(backupStore)
    expect(backupStore.getWorkspace(workspace.id)?.name).toBe('赛博公司')
    const exported = JSON.parse(await readFile(exportPath, 'utf8')) as any
    expect(exported.format).toBe('dsh-cyber-export')
    expect(exported.schemaVersion).toBe(10)
    expect(exported.workspaces[0].worlds[0].world.id).toBe(world.id)
    expect(exported.workspaces[0].worlds[0].employees[0].employee.id).toBe(employee.id)
    expect(exported.workspaces[0].worlds[0].sessions[0].messages[0].content).toBe('世界内记录')
  })

  it('preserves corrupt input and supports best-effort read-only recovery export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-corrupt-'))
    const databasePath = join(directory, 'cyber.sqlite')
    await writeFile(databasePath, 'not a sqlite database', 'utf8')

    let thrown: unknown
    try {
      await SqliteStore.open(databasePath)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DatabaseCorruptError)
    const corruptError = thrown as DatabaseCorruptError
    expect(corruptError.preservedCopyPath).toBeTruthy()
    expect(await readFile(databasePath, 'utf8')).toBe('not a sqlite database')
    expect(await readFile(corruptError.preservedCopyPath!, 'utf8')).toBe('not a sqlite database')

    const recoveryPath = join(directory, 'recovery.json')
    const report = await exportReadonlyRecovery(databasePath, recoveryPath)
    expect(report.errors.length).toBeGreaterThan(0)
    expect((await stat(recoveryPath)).size).toBeGreaterThan(0)
  })

  it('persists evidence-backed employee growth dossiers and relationships', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const world = store.createWorld({
      workspaceId: workspace.id,
      name: '赛博公司',
      templateId: 'cyber-company',
    })
    store.saveBlueprint(blueprint())
    store.saveBlueprint(blueprint({ id: 'reviewer', displayName: '老周', role: '架构师' }))
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
    })
    const colleague = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'reviewer',
      blueprintVersion: 1,
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'meeting',
      title: '发布复盘',
      participants: [
        { participantId: employee.id, kind: 'employee' },
        { participantId: colleague.id, kind: 'employee' },
      ],
    })
    const message = store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '完成回归测试，并提交验证报告。',
    })
    const taskEvent = store.appendDomainEvent({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      type: 'task.completed',
      actorId: employee.id,
      actorKind: 'employee',
      payload: { employeeId: employee.id, result: 'passed' },
    })
    store.reviseEmployeeProfile({
      employeeId: employee.id,
      birthday: '05-24',
      background: '负责可靠的软件交付与自动化测试。',
      personalityTraits: ['严谨', '务实'],
      appearance: { avatar: 'avatars/xiaoliu.png', palette: 'violet' },
      reason: '完成入职建档',
    })
    const evidence = store.recordSkillEvidence({
      employeeId: employee.id,
      skillId: 'release-verification',
      kind: 'test',
      outcome: 'passed',
      summary: '回归测试全部通过。',
      sourceEventIds: [taskEvent.id],
      sourceMessageIds: [message.id],
      artifactRefs: ['artifacts/release-report.md'],
    })
    store.reviseEmployeeSkill({
      employeeId: employee.id,
      skillId: 'release-verification',
      status: 'verified',
      evidenceIds: [evidence.id],
      reason: '通过发布回归与同伴评审。',
    })
    store.writeEmployeeJournal({
      employeeId: employee.id,
      localDate: '2026-08-19',
      summary: '完成发布回归，学会了发布验收流程。',
      highlights: ['完成回归', '提交报告'],
      sourceEventIds: [taskEvent.id],
      sourceMessageIds: [message.id],
    })
    store.recordEmployeeInteraction({
      employeeId: employee.id,
      colleagueId: colleague.id,
      sessionId: session.id,
      kind: 'review',
    })
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    const dossier = reopened.getEmployeeDossier(employee.id)
    expect(dossier.profile).toMatchObject({ birthday: '05-24', personalityTraits: ['严谨', '务实'] })
    expect(dossier.skills).toEqual([
      expect.objectContaining({ skillId: 'release-verification', status: 'verified' }),
    ])
    expect(dossier.evidence[0]).toMatchObject({ outcome: 'passed' })
    expect(dossier.milestones.map((item) => item.category)).toContain('skill')
    expect(dossier.milestones.map((item) => item.category)).toContain('joined')
    expect(dossier.journals[0]).toMatchObject({ localDate: '2026-08-19', revision: 1 })
    expect(dossier.relationships[0]).toMatchObject({ colleagueId: colleague.id, reviewCount: 1 })
  })

  it('persists appearance, skin and safe model settings without storing credentials', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '个性化工作区' })
    store.updateWorkspacePreferences({
      workspaceId: workspace.id,
      colorScheme: 'dark',
      skinId: 'cyber-graphite',
      backgroundAssetRef: 'backgrounds/night-office.webp',
      backgroundFit: 'cover',
      backgroundOpacity: 0.28,
      interfaceDensity: 'compact',
      motion: 'reduced',
      leftPaneWidth: 304,
      rightPaneWidth: 560,
    })
    const model = store.saveModelProfile({
      workspaceId: workspace.id,
      displayName: '公司 sub2api',
      providerKind: 'openai-compatible-local',
      baseUrl: 'http://172.16.1.125:11434/v1/',
      modelId: 'qwen3.5:9b',
      api: 'openai-completions',
      credentialEnvName: 'SUB2API_API_KEY',
      isDefault: true,
      settings: { providerId: 'custom-local', temperature: 0.3 },
    })
    const updatedModel = store.saveModelProfile({
      ...model,
      displayName: '公司 sub2api（主线路）',
      modelId: 'qwen3.5',
      settings: { ...model.settings, contextWindow: 128_000 },
    })
    expect(updatedModel.id).toBe(model.id)
    expect(store.listModelProfiles(workspace.id)).toHaveLength(1)
    expect(() =>
      store.saveModelProfile({
        ...model,
        displayName: '危险配置',
        settings: { apiKey: 'must-not-persist' },
      }),
    ).toThrow(SecretPersistenceError)
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.getWorkspacePreferences(workspace.id)).toMatchObject({
      colorScheme: 'dark',
      backgroundAssetRef: 'backgrounds/night-office.webp',
      motion: 'reduced',
      rightPaneWidth: 560,
    })
    expect(reopened.listModelProfiles(workspace.id)).toEqual([
      expect.objectContaining({
        id: model.id,
        displayName: '公司 sub2api（主线路）',
        baseUrl: 'http://172.16.1.125:11434/v1',
        modelId: 'qwen3.5',
        credentialEnvName: 'SUB2API_API_KEY',
        isDefault: true,
      }),
    ])
  })

  it('deletes model profiles, clears routes, and promotes a fallback default', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '模型删除工作区' })
    const primary = store.saveModelProfile({
      workspaceId: workspace.id,
      displayName: 'A 主模型',
      providerKind: 'openai-compatible-local',
      baseUrl: 'http://192.168.10.8:8080/v1',
      modelId: 'primary',
      api: 'openai-completions',
      isDefault: true,
      settings: {},
    })
    const fallback = store.saveModelProfile({
      workspaceId: workspace.id,
      displayName: 'B 备用模型',
      providerKind: 'openai-compatible-remote',
      baseUrl: 'https://models.example.com/v1',
      modelId: 'fallback',
      api: 'openai-completions',
      isDefault: false,
      settings: {},
    })
    store.saveModelAssignment({ workspaceId: workspace.id, scope: 'workspace', scopeId: workspace.id, modelProfileId: primary.id })

    expect(store.deleteModelProfile(workspace.id, primary.id)).toBe(true)
    expect(store.listModelAssignments(workspace.id)).toEqual([])
    expect(store.listModelProfiles(workspace.id)).toEqual([expect.objectContaining({ id: fallback.id, isDefault: true })])
    expect(store.deleteModelProfile(workspace.id, primary.id)).toBe(false)
    expect(() => store.saveModelProfile({
      workspaceId: workspace.id,
      displayName: '公网明文接口',
      providerKind: 'openai-compatible-local',
      baseUrl: 'http://203.0.113.10/v1',
      modelId: 'unsafe',
      api: 'openai-completions',
      settings: {},
    })).toThrow(/private-network/)
  })

  it('resolves model assignments from employee to world to workspace defaults', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '模型路由工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '研发世界', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint())
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
    })
    const defaultModel = store.saveModelProfile({
      workspaceId: workspace.id,
      displayName: '默认模型',
      providerKind: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      api: 'openai-completions',
      isDefault: true,
      settings: {},
    })
    const worldModel = store.saveModelProfile({
      workspaceId: workspace.id,
      displayName: '世界模型',
      providerKind: 'openai-compatible-remote',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-5.6-luna',
      api: 'openai-responses',
      isDefault: false,
      settings: {},
    })
    const employeeModel = store.saveModelProfile({
      workspaceId: workspace.id,
      displayName: '员工模型',
      providerKind: 'openai-compatible-local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'qwen3:14b',
      api: 'openai-completions',
      isDefault: false,
      settings: {},
    })

    expect(store.resolveModelProfile(workspace.id, world.id, employee.id)?.id).toBe(defaultModel.id)
    store.saveModelAssignment({ workspaceId: workspace.id, scope: 'world', scopeId: world.id, modelProfileId: worldModel.id })
    expect(store.resolveModelProfile(workspace.id, world.id, employee.id)?.id).toBe(worldModel.id)
    store.saveModelAssignment({ workspaceId: workspace.id, scope: 'employee', scopeId: employee.id, modelProfileId: employeeModel.id })
    expect(store.resolveModelProfile(workspace.id, world.id, employee.id)?.id).toBe(employeeModel.id)
    expect(store.listModelAssignments(workspace.id)).toHaveLength(2)
    expect(store.clearModelAssignment(workspace.id, 'employee', employee.id)).toBe(true)
    expect(store.resolveModelProfile(workspace.id, world.id, employee.id)?.id).toBe(worldModel.id)
  })

  it('migrates an existing v2 database forward without losing workspace data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-migration-'))
    const databasePath = join(directory, 'cyber.sqlite')
    const seeded = await SqliteStore.open(databasePath)
    seeded.createWorkspace({ name: '迁移前工作区' })
    seeded.close()
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP TABLE model_assignments;
      DROP TABLE model_profiles;
      DROP TABLE workspace_preferences;
      DROP TABLE local_assets;
      DROP TABLE runtime_update_transactions;
      DROP TABLE employee_relationships;
      DROP TABLE employee_daily_journals;
      DROP TABLE employee_milestones;
      DROP TABLE employee_skill_revisions;
      DROP TABLE skill_evidence;
      DROP TABLE employee_profile_revisions;
      DROP TABLE world_theme_bindings;
      DROP TABLE world_object_states;
      DROP TABLE world_entity_states;
      DROP TABLE world_runtime_snapshots;
      DELETE FROM schema_migrations WHERE version > 2;
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const migrated = await SqliteStore.open(databasePath)
    stores.push(migrated)
    expect(migrated.listWorkspaces()[0]?.name).toBe('迁移前工作区')
    expect(migrated.doctor()).toMatchObject({
      ok: true,
      schemaVersion: 10,
      counts: {
        installedPackages: 0,
        packageTransactions: 0,
        runtimeUpdates: 0,
        employeeProfiles: 0,
        modelProfiles: 0,
        modelAssignments: 0,
        localAssets: 0,
        worldRuntimeSnapshots: 0,
        worldEntityStates: 0,
        worldObjectStates: 0,
        worldThemeBindings: 0,
      },
    })
  })

  it('persists audited runtime update transitions and rejects skipped stages', async () => {
    const { path, store } = await testDatabase()
    const verified = store.beginRuntimeUpdate({
      candidateRoot: join(path, '..', 'candidate-runtime'),
      version: '0.1.0-rc.7',
      contractId: 'dsh-cyber-runtime-v1',
      report: { packageVersions: true, isolatedProfile: true },
    })

    expect(() =>
      store.transitionRuntimeUpdate({
        transactionId: verified.id,
        status: 'activated',
        report: { activated: true },
      }),
    ).toThrow('cannot transition from verified to activated')

    const contractTested = store.transitionRuntimeUpdate({
      transactionId: verified.id,
      status: 'contract-tested',
      report: { turns: 2, stableSession: true },
    })
    const canary = store.transitionRuntimeUpdate({
      transactionId: verified.id,
      status: 'canary-passed',
      report: { events: ['message_start', 'message_end'], healthy: true },
    })
    expect(contractTested.status).toBe('contract-tested')
    expect(canary.status).toBe('canary-passed')

    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.getRuntimeUpdateTransaction(verified.id)).toMatchObject({
      status: 'canary-passed',
      version: '0.1.0-rc.7',
      report: { events: ['message_start', 'message_end'], healthy: true },
    })
    expect(reopened.doctor().counts.runtimeUpdates).toBe(1)
  })
})
