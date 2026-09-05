import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { CYBER_SCHEMA_VERSION, WORKSPACE_PREFERENCES_LIMITS, type EmployeeBlueprint } from '@dsh-cyber/contracts'

import {
  DatabaseCorruptError,
  SecretPersistenceError,
  SqliteStore,
  WorkSystemRepository,
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
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '工程师私聊',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
    })

    expect(store.getWorld(world.id)?.administratorEmployeeId).toBeUndefined()
    // A recruited character starts with the file grants its runtime permission
    // mode implies. An empty set was what made world.files.* unenforceable:
    // the owner could see and revoke a permission nothing was ever checking.
    expect(store.getWorldCharacterAuthority(world.id, employee.id))
      .toMatchObject({ role: 'member', permissionGrants: ['world.files.read'] })
    expect(revision.runtimePermissionMode).toBe('read-only')
    expect(revision.revision).toBe(2)
    expect(store.getEmployee(employee.id)?.currentRevision).toBe(2)
    expect(store.listEmployeeRevisions(employee.id)).toHaveLength(2)
    expect(store.getWorkspaceSnapshot(workspace.id).worlds).toHaveLength(1)
    expect(store.getWorldSnapshot(world.id)).toMatchObject({
      employees: [expect.objectContaining({ id: employee.id })],
      dossiers: [expect.objectContaining({ employee: expect.objectContaining({ id: employee.id }) })],
      sessionParticipants: expect.arrayContaining([expect.objectContaining({ sessionId: session.id, participantId: employee.id, kind: 'employee' })]),
    })
  })

  it('keeps actionable employee health separate from derived presence', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '角色健康工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '角色健康世界', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint())
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
    })

    expect(employee).toMatchObject({ presence: 'available', health: 'healthy', status: 'available' })
    expect(() => store.setEmployeeStatus(employee.id, 'working', 'system')).toThrow('derived from durable work')
    expect(store.setEmployeeHealth(employee.id, 'blocked', {
      errorCode: 'model_credentials_missing',
      detail: '请在设置中补充模型凭据',
    })).toMatchObject({ presence: 'available', health: 'blocked', status: 'blocked' })

    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.getEmployee(employee.id)).toMatchObject({
      presence: 'available',
      health: 'blocked',
      healthErrorCode: 'model_credentials_missing',
      status: 'blocked',
    })
    expect(reopened.setEmployeeHealth(employee.id, 'healthy')).toMatchObject({
      presence: 'available', health: 'healthy', status: 'available',
    })
  })

  it('keeps administrator authority inside one world and allows an explicit same-world handoff', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '管理员隔离工作区' })
    const firstWorld = store.createWorld({ workspaceId: workspace.id, name: '第一世界', templateId: 'cyber-company' })
    const secondWorld = store.createWorld({ workspaceId: workspace.id, name: '第二世界', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint())
    store.saveBlueprint(blueprint({ id: 'reviewer', displayName: '审阅员' }))
    const firstAdministrator = store.recruitEmployee({
      workspaceId: workspace.id, worldId: firstWorld.id, blueprintId: 'software-engineer', blueprintVersion: 1,
    })
    const successor = store.recruitEmployee({
      workspaceId: workspace.id, worldId: firstWorld.id, blueprintId: 'reviewer', blueprintVersion: 1,
    })
    const otherWorldAdministrator = store.recruitEmployee({
      workspaceId: workspace.id, worldId: secondWorld.id, blueprintId: 'software-engineer', blueprintVersion: 1,
    })

    // Legacy APIs remain readable for old databases, but new recruits no
    // longer receive administrator identity implicitly.
    store.setWorldAdministrator(firstWorld.id, firstAdministrator.id)
    store.setWorldAdministrator(secondWorld.id, otherWorldAdministrator.id)

    expect(store.isWorldAdministrator(firstWorld.id, firstAdministrator.id)).toBe(true)
    expect(store.canManageEmployee(firstAdministrator.id, successor.id)).toBe(true)
    expect(store.canManageEmployee(firstAdministrator.id, otherWorldAdministrator.id)).toBe(false)
    expect(() => store.setWorldAdministrator(firstWorld.id, otherWorldAdministrator.id)).toThrow('same world')
    expect(store.setWorldAdministrator(firstWorld.id, successor.id).administratorEmployeeId).toBe(successor.id)
    expect(store.isWorldAdministrator(firstWorld.id, firstAdministrator.id)).toBe(false)
    expect(store.canManageEmployee(firstAdministrator.id, successor.id)).toBe(false)
    expect(store.canManageEmployee(successor.id, firstAdministrator.id)).toBe(true)
    expect(store.isWorldAdministrator(secondWorld.id, otherWorldAdministrator.id)).toBe(true)

    store.archiveEmployee(successor.id)
    expect(store.getWorld(firstWorld.id)?.administratorEmployeeId).toBe(firstAdministrator.id)
    expect(store.canManageEmployee(firstAdministrator.id, successor.id)).toBe(false)

    store.archiveEmployee(firstAdministrator.id)
    expect(store.getWorld(firstWorld.id)?.administratorEmployeeId).toBeUndefined()
  })

  it('limits capability grants while allowing skills learned after blueprint creation', async () => {
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
    expect(store.reviseEmployee({
      employeeId: employee.id,
      reason: 'attempt skill escalation',
      skillGrants: ['shell-access'],
    })).toMatchObject({ skillGrants: ['shell-access'], capabilityGrants: ['workspace:read'] })
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
    expect(reopened.getEmployeeRevision(employee.id, 3)).toMatchObject({
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
    expect(reopened.doctor()).toMatchObject({ ok: true, schemaVersion: CYBER_SCHEMA_VERSION })
  })

  it('returns the latest message of one sender without loading the full transcript', async () => {
    const { store } = await testDatabase()
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
      title: '最近提问预览',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    expect(store.latestMessageBySender(session.id, 'owner')).toBeUndefined()
    store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '第一条提问',
    })
    store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '收到。',
    })
    store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '第二条更长的提问',
    })
    expect(store.latestMessageBySender(session.id, 'owner')).toMatchObject({
      senderKind: 'owner',
      content: '第二条更长的提问',
      sequence: 3,
    })
    store.close()
  })

  it('pages chat messages and searches history without materializing the full transcript', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '消息分页工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '消息分页世界', templateId: 'cyber-company' })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '分页会话',
      participants: [{ participantId: 'owner', kind: 'owner' }],
    })
    for (let index = 1; index <= 45; index += 1) {
      store.appendMessage({
        sessionId: session.id,
        senderId: 'owner',
        senderKind: 'owner',
        kind: 'user',
        content: `历史消息 ${index}`,
      })
    }

    const latest = store.listMessagesPage(session.id, { limit: 20, chatOnly: true })
    expect(latest.items.map((item) => item.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 26))
    expect(latest.total).toBe(45)
    expect(latest.hasMore).toBe(true)
    expect(latest.nextBefore).toBe(26)

    const older = store.listMessagesPage(session.id, { limit: 20, beforeSequence: latest.nextBefore, chatOnly: true })
    expect(older.items.map((item) => item.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 6))
    expect(older.hasMore).toBe(true)

    const firstHistoryPage = store.listMessagesPage(session.id, { limit: 20, page: 1, chatOnly: true })
    expect(firstHistoryPage.items.map((item) => item.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 26))
    expect(firstHistoryPage.hasMore).toBe(true)
    const secondHistoryPage = store.listMessagesPage(session.id, { limit: 20, page: 2, chatOnly: true })
    expect(secondHistoryPage.items.map((item) => item.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 6))

    const search = store.listMessagesPage(session.id, { limit: 20, search: '消息 4', page: 1, chatOnly: true })
    expect(search.items.map((item) => item.content)).toEqual(expect.arrayContaining(['历史消息 4', '历史消息 40', '历史消息 41', '历史消息 45']))
    expect(search.total).toBe(7)

    const day = latest.items[0]!.createdAt.slice(0, 10)
    const dateFiltered = store.listMessagesPage(session.id, { limit: 20, date: day, page: 1, chatOnly: true })
    expect(dateFiltered.total).toBe(45)
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
    expect(exported.schemaVersion).toBe(CYBER_SCHEMA_VERSION)
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
    const preferenceSchema = store.database.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_preferences'`,
    ).get() as { sql: string }
    expect(preferenceSchema.sql).toContain(`left_pane_width >= ${WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.minimum}`)
    expect(preferenceSchema.sql).toContain(`left_pane_width <= ${WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.maximum}`)
    expect(preferenceSchema.sql).toContain(`right_pane_width >= ${WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.minimum}`)
    expect(preferenceSchema.sql).toContain(`right_pane_width <= ${WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.maximum}`)
    expect(() => store.updateWorkspacePreferences({ workspaceId: workspace.id, rightPaneWidth: 761 }))
      .toThrow('300 到 760')
    store.updateWorkspacePreferences({
      workspaceId: workspace.id,
      locale: 'ja-JP',
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
      locale: 'ja-JP',
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
    expect(store.resolveWorkspaceDefaultProfile(workspace.id)?.id).toBe(defaultModel.id)
    store.saveModelAssignment({ workspaceId: workspace.id, scope: 'world', scopeId: world.id, modelProfileId: worldModel.id })
    expect(store.resolveModelProfile(workspace.id, world.id, employee.id)?.id).toBe(worldModel.id)
    store.saveModelAssignment({ workspaceId: workspace.id, scope: 'employee', scopeId: employee.id, modelProfileId: employeeModel.id })
    expect(store.resolveModelProfile(workspace.id, world.id, employee.id)?.id).toBe(employeeModel.id)
    expect(store.listModelAssignments(workspace.id)).toHaveLength(2)
    expect(store.clearModelAssignment(workspace.id, 'employee', employee.id)).toBe(true)
    expect(store.resolveModelProfile(workspace.id, world.id, employee.id)?.id).toBe(worldModel.id)
    store.clearModelAssignment(workspace.id, 'world', world.id)
    store.saveModelAssignment({ workspaceId: workspace.id, scope: 'workspace', scopeId: workspace.id, modelProfileId: employeeModel.id })
    expect(store.resolveWorkspaceDefaultProfile(workspace.id)?.id).toBe(employeeModel.id)
  })

  it('falls back to the default when a legacy assignment points to a missing profile', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '模型回退工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '回退世界', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint())
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
    })
    const fallback = store.saveModelProfile({
      workspaceId: workspace.id,
      displayName: '回退模型',
      providerKind: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-chat',
      api: 'openai-completions',
      isDefault: true,
      settings: {},
    })

    // This simulates a legacy/corrupt database opened with foreign-key checks
    // disabled. Normal deletes still remove assignments through ON DELETE CASCADE.
    store.database.exec('PRAGMA foreign_keys = OFF')
    store.database.prepare(
      `INSERT INTO model_assignments (workspace_id, scope, scope_id, model_profile_id, updated_at)
       VALUES (?, 'employee', ?, ?, ?)`,
    ).run(workspace.id, employee.id, 'missing-model-profile', new Date().toISOString())
    store.database.exec('PRAGMA foreign_keys = ON')

    expect(store.resolveModelProfile(workspace.id, world.id, employee.id)?.id).toBe(fallback.id)
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
      DROP TABLE model_providers;
      DROP TABLE workspace_preferences;
      DROP TABLE local_assets;
      DROP TABLE runtime_update_transactions;
      DROP TABLE employee_relationships;
      DROP TABLE employee_daily_journals;
      DROP TABLE agent_run_context_snapshots;
      DROP TABLE IF EXISTS employee_memory_index_fts;
      DROP TABLE employee_memory_index;
      DROP TABLE employee_milestones;
      DROP TABLE employee_skill_revisions;
      DROP TABLE skill_evidence;
      DROP TABLE employee_profile_revisions;
      DROP TABLE world_theme_bindings;
      DROP TABLE world_object_states;
      DROP TABLE world_entity_states;
      DROP TABLE world_runtime_snapshots;
      DROP TABLE model_interaction_logs;
      DROP TABLE task_schedule_runs;
      DROP TABLE task_schedules;
      DROP TABLE approval_policies;
      DROP TABLE world_permission_requests;
      DROP TABLE world_authority_changes;
      DROP TABLE world_character_authorities;
      DROP TABLE skill_actions;
      DROP TABLE approval_requests;
      DROP TABLE world_package_instances;
      DROP TABLE owner_runtime_access_grants;
      DROP TABLE growth_evidence;
      DROP TABLE reviews;
      DROP TABLE deliverables;
      DROP TABLE task_runs;
      DROP TABLE task_assignments;
      DROP TABLE task_plan_steps;
      DROP TABLE task_plan_revisions;
      DROP TABLE work_tasks;
      DROP TABLE completion_jobs;
      DROP TABLE agent_runs;
      DROP TABLE conversation_queue_entries;
      DROP TABLE work_turns;
      DROP TABLE task_collaboration_steps;
      DROP TABLE task_collaboration_plans;
      ALTER TABLE work_sessions DROP COLUMN collaboration_mode;
      DROP INDEX worlds_administrator_idx;
      ALTER TABLE worlds DROP COLUMN administrator_employee_id;
      ALTER TABLE employee_blueprints DROP COLUMN embodiment_json;
      DROP INDEX employee_instances_world_health_idx;
      ALTER TABLE employee_instances DROP COLUMN health_detail;
      ALTER TABLE employee_instances DROP COLUMN health_error_code;
      ALTER TABLE employee_instances DROP COLUMN health;
      ALTER TABLE employee_revisions DROP COLUMN runtime_permission_mode;
      DELETE FROM schema_migrations WHERE version > 2;
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const migrated = await SqliteStore.open(databasePath)
    stores.push(migrated)
    expect((await readdir(directory)).some((file) => file.startsWith('cyber.sqlite.pre-migration-v2-') && file.endsWith('.sqlite'))).toBe(true)
    expect(migrated.listWorkspaces()[0]?.name).toBe('迁移前工作区')
    expect(migrated.database.prepare(`PRAGMA foreign_key_list(world_permission_requests)`).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'work_turns' }),
        expect.objectContaining({ table: 'skill_actions' }),
      ]),
    )
    expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.doctor()).toMatchObject({
      ok: true,
      schemaVersion: CYBER_SCHEMA_VERSION,
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
        modelInteractionLogs: 0,
      },
    })
  })

  it('backfills the employee memory index when an existing database is migrated forward', async () => {
    const { directory, path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '记忆迁移工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '记忆世界', templateId: 'personal-world' })
    store.saveBlueprint(blueprint({ id: 'memory.worker', worldTemplateId: 'personal-world' }))
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'memory.worker',
      blueprintVersion: 1,
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const evidence = store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '我不喜欢长篇大论。',
      metadata: {},
    })
    const privateMilestone = store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'reflection',
      title: '[private] 私聊记忆',
      summary: '用户偏好简洁回答。',
      sourceMessageIds: [evidence.id],
      actorId: 'system',
    })
    const taskMilestone = store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'task',
      title: '[task] 任务经历',
      summary: '交付了结算脚本的重试修复。',
      sourceMessageIds: [evidence.id],
      actorId: 'system',
    })
    const joinedMilestoneId = store.listEmployeeMilestones(employee.id)
      .find((milestone) => milestone.category === 'joined')?.id
    expect(joinedMilestoneId).toBeDefined()
    store.close()

    // Rewind the file to the schema shipped before the memory index existed,
    // keeping every milestone that database already held.
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      DROP INDEX work_tasks_source_message_idx;
      DROP INDEX work_tasks_source_work_turn_idx;
      ALTER TABLE work_tasks DROP COLUMN source_message_id;
      ALTER TABLE work_tasks DROP COLUMN source_work_turn_id;
      DROP TABLE agent_run_context_snapshots;
      DROP TABLE IF EXISTS employee_memory_index_fts;
      DROP TABLE employee_memory_index;
      ALTER TABLE employee_milestones DROP COLUMN origin;
      DROP INDEX model_profiles_provider_model_idx;
      ALTER TABLE model_profiles DROP COLUMN provider_id;
      ALTER TABLE model_profiles DROP COLUMN origin;
      ALTER TABLE model_profiles DROP COLUMN capabilities_json;
      ALTER TABLE model_profiles DROP COLUMN probed_at;
      DROP TABLE model_providers;
      DELETE FROM schema_migrations WHERE version > 36;
      PRAGMA user_version = 36;
    `)
    legacy.close()

    const migrated = await SqliteStore.open(path)
    stores.push(migrated)
    expect((await readdir(directory)).some((file) => file.startsWith('cyber.sqlite.pre-migration-v36-'))).toBe(true)
    expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.doctor()).toMatchObject({ ok: true, schemaVersion: CYBER_SCHEMA_VERSION })

    // Every pre-existing milestone is indexed, and the private one keeps its
    // isolation scope instead of quietly becoming group-visible.
    expect(migrated.getEmployeeMemoryIndexEntry(privateMilestone.id)).toMatchObject({
      scope: 'private',
      summary: '用户偏好简洁回答。',
      sourceMessageIds: [evidence.id],
    })
    expect(migrated.getEmployeeMemoryIndexEntry(taskMilestone.id)?.scope).toBe('task')
    expect(migrated.getEmployeeMemoryIndexEntry(joinedMilestoneId!)?.scope).toBe('group')
    expect(migrated.listEmployeeMemoryIndex(employee.id, ['group', 'task']).map((entry) => entry.memoryId))
      .not.toContain(privateMilestone.id)
    expect(migrated.searchEmployeeMemoryIndex({
      employeeId: employee.id,
      query: '简洁回答',
      scopes: ['group', 'task'],
    }).map((hit) => hit.entry.memoryId)).not.toContain(privateMilestone.id)
  })

  it('adds the agent run context snapshot table forward-safely, touching nothing that already existed', async () => {
    const { directory, path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '快照迁移工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '快照世界', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint({ id: 'snapshot.worker', worldTemplateId: 'cyber-company' }))
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'snapshot.worker',
      blueprintVersion: 1,
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const turn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat',
    })
    const run = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, turnId: turn.id,
      sessionId: session.id, employeeId: employee.id, ordinal: 1,
    })
    const message = store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '迁移前就存在的消息。',
      metadata: {},
    })
    store.close()

    // Rewind the file to the schema shipped before context snapshots existed,
    // keeping every row that database already held.
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      DROP INDEX work_tasks_source_message_idx;
      DROP INDEX work_tasks_source_work_turn_idx;
      ALTER TABLE work_tasks DROP COLUMN source_message_id;
      ALTER TABLE work_tasks DROP COLUMN source_work_turn_id;
      DROP TABLE agent_run_context_snapshots;
      DROP INDEX model_profiles_provider_model_idx;
      ALTER TABLE model_profiles DROP COLUMN provider_id;
      ALTER TABLE model_profiles DROP COLUMN origin;
      ALTER TABLE model_profiles DROP COLUMN capabilities_json;
      ALTER TABLE model_profiles DROP COLUMN probed_at;
      DROP TABLE model_providers;
      DELETE FROM schema_migrations WHERE version > 38;
      PRAGMA user_version = 38;
    `)
    legacy.close()

    const migrated = await SqliteStore.open(path)
    stores.push(migrated)
    expect((await readdir(directory)).some((file) => file.startsWith('cyber.sqlite.pre-migration-v38-'))).toBe(true)
    expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.doctor()).toMatchObject({ ok: true, schemaVersion: CYBER_SCHEMA_VERSION })

    // Additive only: nothing that predated the migration was rewritten, and the
    // new table starts empty rather than backfilling invented context records.
    expect(migrated.getAgentRun(run.id)).toMatchObject({ id: run.id, status: 'queued' })
    expect(migrated.listMessages(session.id).map((row) => row.content)).toEqual(['迁移前就存在的消息。'])
    expect(migrated.getAgentRunContextSnapshot(run.id)).toBeUndefined()
    expect(
      migrated.database.prepare('SELECT COUNT(*) AS count FROM agent_run_context_snapshots').get(),
    ).toMatchObject({ count: 0 })

    // And a run recorded after the migration is readable and prunes with its run.
    migrated.saveAgentRunContextSnapshot({
      agentRunId: run.id,
      snapshot: {
        snapshotVersion: 1,
        envelopeVersion: 1,
        stablePrefixHash: 'prefix-hash',
        structureHash: 'structure-hash',
        totalTokenEstimate: 11,
        layers: [{
          id: `identity:${employee.id}`,
          kind: 'stable-identity',
          revision: '1',
          contentHash: 'c1',
          tokenEstimate: 11,
          sourceRefs: [{ kind: 'message', id: message.id }],
        }],
        cache: { stablePrefixTokens: 11, volatileTokens: 0, prefixReused: false },
      },
    })
    expect(migrated.getAgentRunContextSnapshot(run.id)).toMatchObject({ stablePrefixHash: 'prefix-hash' })

    // Snapshots are a child of the run, so retention prunes them by cascade and
    // cannot leave an orphaned context record behind.
    migrated.completeAgentRun(migrated.startAgentRun(run.id).id)
    migrated.pruneHistory({ before: '2999-01-01T00:00:00.000Z' })
    expect(migrated.getAgentRunContextSnapshot(run.id)).toBeUndefined()
    expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
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

  it('records, lists, filters, pages and clears model interaction logs without leaking prompt text', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '日志工作区' })
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
      skillGrants: ['coding'],
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '与 小刘 对话',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })

    const success = store.recordModelInteraction({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      employeeId: employee.id,
      source: 'turn',
      modelId: 'deepseek-chat',
      provider: 'DeepSeek',
      status: 'success',
      promptMessageCount: 3,
      promptCharCount: 842,
      responseCharCount: 156,
      toolCallCount: 2,
      durationMs: 3_420,
      tokensPrompt: 1_204,
      tokensCompletion: 312,
      tokensTotal: 1_516,
    })
    expect(success.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(success.workspaceId).toBe(workspace.id)
    expect(success.worldId).toBe(world.id)
    expect(success.sessionId).toBe(session.id)
    expect(success.employeeId).toBe(employee.id)
    expect(success.createdAt).toBeTruthy()

    // 真实场景两次交互时间不同；这里稍作延迟保证 created_at 排序稳定
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))

    const failed = store.recordModelInteraction({
      workspaceId: workspace.id,
      source: 'discovery',
      modelId: '-',
      provider: 'https://models.example.test/v1',
      status: 'failed',
      errorCode: 'model_catalog_timeout',
      errorMessage: '模型服务响应超时，请检查地址或稍后重试。',
      promptMessageCount: 0,
      promptCharCount: 0,
      durationMs: 12_000,
    })
    expect(failed.errorCode).toBe('model_catalog_timeout')
    expect(failed.tokensTotal).toBeUndefined()

    // 列表：默认按时间倒序
    const all = store.listModelInteractions(workspace.id, { page: 1, pageSize: 20 })
    expect(all.total).toBe(2)
    expect(all.items.map((item) => item.id)).toEqual([failed.id, success.id])
    expect(all.modelIds).toEqual(['-', 'deepseek-chat'])

    // 状态筛选
    const failures = store.listModelInteractions(workspace.id, { page: 1, pageSize: 20, status: 'failed' })
    expect(failures.total).toBe(1)
    expect(failures.items[0]?.id).toBe(failed.id)

    // 模型筛选
    const modelFiltered = store.listModelInteractions(workspace.id, { page: 1, pageSize: 20, modelId: 'deepseek-chat' })
    expect(modelFiltered.total).toBe(1)
    expect(modelFiltered.items[0]?.id).toBe(success.id)

    // 分页
    const paged = store.listModelInteractions(workspace.id, { page: 2, pageSize: 1 })
    expect(paged.total).toBe(2)
    expect(paged.items.map((item) => item.id)).toEqual([success.id])

    // 详情
    expect(store.getModelInteraction(success.id)).toMatchObject({
      id: success.id,
      modelId: 'deepseek-chat',
      status: 'success',
      durationMs: 3_420,
    })
    expect(store.getModelInteraction('missing-id')).toBeUndefined()

    // 日志内容不含 prompt 明文（字段只存摘要统计）
    const stored = store.getModelInteraction(success.id)!
    expect(JSON.stringify(stored)).not.toContain('秘密提示词')
    expect(stored.promptCharCount).toBe(842)

    // 重启后日志仍在
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.listModelInteractions(workspace.id, { page: 1, pageSize: 20 }).total).toBe(2)
    expect(reopened.doctor().counts.modelInteractionLogs).toBe(2)

    // 清空
    expect(reopened.clearModelInteractions(workspace.id)).toBe(2)
    expect(reopened.listModelInteractions(workspace.id, { page: 1, pageSize: 20 }).total).toBe(0)
  })

  it('rejects invalid model interaction log input', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '校验工作区' })

    expect(() => store.recordModelInteraction({
      workspaceId: workspace.id,
      source: 'turn',
      modelId: 'deepseek-chat',
      provider: 'DeepSeek',
      status: 'success',
      promptMessageCount: -1,
      promptCharCount: 10,
      durationMs: 5,
    })).toThrow('prompt message count must be a non-negative integer')

    expect(() => store.recordModelInteraction({
      workspaceId: workspace.id,
      source: 'turn',
      modelId: '  ',
      provider: 'DeepSeek',
      status: 'success',
      promptMessageCount: 1,
      promptCharCount: 10,
      durationMs: 5,
    })).toThrow('model id cannot be empty')

    expect(() => store.recordModelInteraction({
      workspaceId: workspace.id,
      source: 'turn',
      modelId: 'deepseek-chat',
      provider: 'DeepSeek',
      status: 'success',
      promptMessageCount: 1,
      promptCharCount: 10,
      durationMs: -1,
    })).toThrow('duration must be a non-negative integer')

    expect(() => store.recordModelInteraction({
      workspaceId: workspace.id,
      source: 'turn',
      modelId: 'deepseek-chat',
      provider: 'DeepSeek',
      status: 'success',
      promptMessageCount: 1,
      promptCharCount: 10,
      durationMs: 5,
      tokensTotal: -2,
    })).toThrow('tokens total must be a non-negative integer')
  })

  it('records knowledge extraction telemetry as summaries without model content', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '知识模型日志' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '知识世界', templateId: 'cyber-company' })
    const log = store.recordModelInteraction({
      workspaceId: workspace.id,
      worldId: world.id,
      source: 'knowledge',
      modelId: 'knowledge-extractor',
      provider: '本地模型',
      status: 'success',
      promptMessageCount: 1,
      promptCharCount: 520,
      responseCharCount: 240,
      durationMs: 900,
      tokensPrompt: 120,
      tokensCompletion: 70,
      tokensTotal: 190,
    })
    expect(log.source).toBe('knowledge')
    expect(JSON.stringify(log)).not.toContain('原始提示词')
    expect(store.listModelInteractions(workspace.id, { page: 1, pageSize: 20 }).items).toEqual([
      expect.objectContaining({ id: log.id, source: 'knowledge', tokensTotal: 190 }),
    ])
  })

  it('persists strict conversation runtime lifecycles and recovers stale work after restart', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: 'Runtime lifecycle' })
    const world = store.createWorld({ workspaceId: workspace.id, name: 'Company', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint())
    const employee = store.recruitEmployee({
      workspaceId: workspace.id, worldId: world.id, blueprintId: 'software-engineer', blueprintVersion: 1,
    })
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: 'Lifecycle' })
    const completedTurn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id,
      interactionKind: 'chat', clientTurnId: 'client-1',
    })
    expect(() => store.completeWorkTurn(completedTurn.id)).toThrow('Illegal work turn transition')
    store.startWorkTurn(completedTurn.id)
    const completedRun = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id,
      turnId: completedTurn.id, employeeId: employee.id, ordinal: 1,
    })
    store.startAgentRun(completedRun.id)
    store.completeAgentRun(completedRun.id, 'runtime-session-1')
    store.completeWorkTurn(completedTurn.id)

    const staleTurn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'task',
    })
    store.startWorkTurn(staleTurn.id)
    const staleRun = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id,
      turnId: staleTurn.id, employeeId: employee.id, ordinal: 1,
    })
    store.startAgentRun(staleRun.id)
    const queuedTurn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat',
    })
    const queuedRun = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id,
      turnId: queuedTurn.id, employeeId: employee.id, ordinal: 1,
    })
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.getAgentRun(completedRun.id)).toMatchObject({ status: 'completed', runtimeSessionId: 'runtime-session-1' })
    expect(reopened.recoverConversationRuntimeAfterRestart()).toEqual({ turnsFailed: 1, runsFailed: 1 })
    expect(reopened.getWorkTurn(staleTurn.id)).toMatchObject({ status: 'interrupted', errorCode: 'service-restarted' })
    expect(reopened.getAgentRun(staleRun.id)).toMatchObject({ status: 'failed', errorCode: 'service-restarted' })
    expect(reopened.getWorkTurn(queuedTurn.id)).toMatchObject({ status: 'queued' })
    expect(reopened.getAgentRun(queuedRun.id)).toMatchObject({ status: 'queued' })
    expect(reopened.recoverConversationRuntimeAfterRestart()).toEqual({ turnsFailed: 0, runsFailed: 0 })
  })
  it('never guesses historical milestone origin from title and removes only an explicitly stamped legacy row', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '事迹工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '赛博公司', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint())
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'software-engineer',
      blueprintVersion: 1,
    })
    const recruitedEvent = store.listWorldDomainEvents(world.id)
      .find((event) => event.type === 'employee.recruited')!
    // Before migration this row is indistinguishable from user-authored data:
    // same title/category/evidence shape and no origin column.
    const legacy = store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'task',
      title: '完成一次真实对话',
      summary: '旧投影按每一轮对话写入的事迹。',
      sourceEventIds: [recruitedEvent.id],
    })
    store.close()
    stores.splice(stores.indexOf(store), 1)

    // Rewind past both 37 (memory index) and 38 (origin) so the upgrade replays
    // the whole stack the way a 36 database in the field would.
    const downgraded = new DatabaseSync(path)
    downgraded.exec(`
      DROP INDEX work_tasks_source_message_idx;
      DROP INDEX work_tasks_source_work_turn_idx;
      ALTER TABLE work_tasks DROP COLUMN source_message_id;
      ALTER TABLE work_tasks DROP COLUMN source_work_turn_id;
      DROP TABLE agent_run_context_snapshots;
      ALTER TABLE employee_milestones DROP COLUMN origin;
      DROP TABLE employee_memory_index;
      DROP INDEX model_profiles_provider_model_idx;
      ALTER TABLE model_profiles DROP COLUMN provider_id;
      ALTER TABLE model_profiles DROP COLUMN origin;
      ALTER TABLE model_profiles DROP COLUMN capabilities_json;
      ALTER TABLE model_profiles DROP COLUMN probed_at;
      DROP TABLE model_providers;
      DELETE FROM schema_migrations WHERE version > 36;
      PRAGMA user_version = 36;
    `)
    downgraded.close()

    const migrated = await SqliteStore.open(path)
    stores.push(migrated)
    expect(migrated.doctor()).toMatchObject({ ok: true, schemaVersion: CYBER_SCHEMA_VERSION })
    expect(migrated.getEmployeeMemoryIndexEntry(legacy.id)).toBeDefined()
    expect(migrated.listEmployeeMilestones(employee.id).find((item) => item.id === legacy.id))
      .toMatchObject({ origin: 'authored' })

    // Durable user data that collides with the retired generator's display copy.
    const authored = migrated.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'task',
      title: '完成一次真实对话',
      summary: '老板亲手记下的里程碑，不能被清理删掉。',
      sourceEventIds: [recruitedEvent.id],
    })
    const joined = migrated.listEmployeeMilestones(employee.id).find((item) => item.category === 'joined')
    expect(joined).toMatchObject({ origin: 'authored' })

    // Once provenance is explicit, cleanup uses only that structural identity.
    migrated.database.prepare("UPDATE employee_milestones SET origin = 'legacy-conversation-projection' WHERE id = ?").run(legacy.id)
    expect(migrated.removeLegacyConversationMilestones(employee.id)).toBe(1)
    const remaining = migrated.listEmployeeMilestones(employee.id)
    expect(remaining.map((item) => item.id)).toContain(authored.id)
    expect(remaining.map((item) => item.id)).not.toContain(legacy.id)
    // The retrieval index is a projection of the milestone, never a second copy
    // that outlives it.
    expect(migrated.getEmployeeMemoryIndexEntry(legacy.id)).toBeUndefined()
    expect(migrated.removeLegacyConversationMilestones(employee.id)).toBe(0)
  })

  it('backfills provider connections without collapsing duplicate legacy model profiles', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '重复模型迁移工作区' })
    const base = {
      workspaceId: workspace.id,
      providerKind: 'openai-compatible-local' as const,
      baseUrl: 'http://127.0.0.1:9/v1',
      modelId: 'same-model',
      api: 'openai-completions' as const,
      settings: {},
    }
    const first = store.saveModelProfile({ ...base, displayName: '重复模型 A', credentialEnvName: 'MODEL_KEY_A' })
    const second = store.saveModelProfile({ ...base, displayName: '重复模型 A（副本）', credentialEnvName: 'MODEL_KEY_A' })
    const third = store.saveModelProfile({ ...base, displayName: '重复模型 B', credentialEnvName: 'MODEL_KEY_B' })
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    store.close()
    stores.splice(stores.indexOf(store), 1)

    // Rewind only the provider migration, keeping the duplicate legacy rows
    // that v39 allowed so the forward migration must preserve them.
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      DROP INDEX work_tasks_source_message_idx;
      DROP INDEX work_tasks_source_work_turn_idx;
      ALTER TABLE work_tasks DROP COLUMN source_message_id;
      ALTER TABLE work_tasks DROP COLUMN source_work_turn_id;
      DROP INDEX model_profiles_provider_model_idx;
      ALTER TABLE model_profiles DROP COLUMN provider_id;
      ALTER TABLE model_profiles DROP COLUMN origin;
      ALTER TABLE model_profiles DROP COLUMN capabilities_json;
      ALTER TABLE model_profiles DROP COLUMN probed_at;
      DROP TABLE model_providers;
      DELETE FROM schema_migrations WHERE version > 39;
      PRAGMA user_version = 39;
    `)
    legacy.close()

    const migrated = await SqliteStore.open(path)
    stores.push(migrated)
    expect(migrated.doctor()).toMatchObject({ ok: true, schemaVersion: CYBER_SCHEMA_VERSION })
    expect(migrated.listModelProfiles(workspace.id)).toHaveLength(3)
    expect(migrated.database.prepare('SELECT COUNT(*) AS count FROM model_providers WHERE workspace_id = ?').get(workspace.id))
      .toMatchObject({ count: 2 })
    const links = migrated.database
      .prepare('SELECT id, provider_id FROM model_profiles WHERE workspace_id = ? ORDER BY id')
      .all(workspace.id) as Array<{ id: string; provider_id: string | null }>
    expect(links.filter((row) => row.provider_id !== null)).toHaveLength(2)
    expect(links.filter((row) => row.provider_id === null)).toHaveLength(1)

    const recoveryPath = join(path, '..', 'recovery.json')
    await exportReadonlyRecovery(path, recoveryPath)
    const recovery = JSON.parse(await readFile(recoveryPath, 'utf8')) as { tables?: { model_providers?: unknown[] } }
    expect(recovery.tables?.model_providers).toHaveLength(2)
  })

  it('adds the task source link after v40 without rewriting existing tasks', async () => {
    const { directory, path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '任务来源迁移工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '任务来源世界', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint({ id: 'source.worker', worldTemplateId: 'cyber-company' }))
    const employee = store.recruitEmployee({
      workspaceId: workspace.id, worldId: world.id, blueprintId: 'source.worker', blueprintVersion: 1,
    })
    const session = store.createSession({
      workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '私聊',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
    })
    const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
    const message = store.appendMessage({
      sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '请整理本周周报。', metadata: { workTurnId: turn.id },
    })
    const legacyTask = new WorkSystemRepository(store.database).createTask({
      workspaceId: workspace.id, worldId: world.id, title: '迁移前的任务', description: '在来源关联存在之前创建。', priority: 'normal', createdBy: 'owner',
    })
    store.close()
    stores.splice(stores.indexOf(store), 1)

    // Rewind only the source-link migration, keeping every row the file held.
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      DROP INDEX work_tasks_source_message_idx;
      DROP INDEX work_tasks_source_work_turn_idx;
      ALTER TABLE work_tasks DROP COLUMN source_message_id;
      ALTER TABLE work_tasks DROP COLUMN source_work_turn_id;
      DELETE FROM schema_migrations WHERE version > 40;
      PRAGMA user_version = 40;
    `)
    legacy.close()

    const migrated = await SqliteStore.open(path)
    stores.push(migrated)
    expect((await readdir(directory)).some((file) => file.startsWith('cyber.sqlite.pre-migration-v40-'))).toBe(true)
    expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.doctor()).toMatchObject({ ok: true, schemaVersion: CYBER_SCHEMA_VERSION })

    // Additive only: the task that predates the migration reads back exactly
    // as it was and gains no invented source. One task per turn is a database
    // rule (a unique index), not something the process has to remember.
    const repository = new WorkSystemRepository(migrated.database)
    expect(repository.getTask(legacyTask.id)).toEqual(legacyTask)
    expect(migrated.database.prepare(
      `SELECT "unique" AS isUnique, partial FROM pragma_index_list('work_tasks') WHERE name = 'work_tasks_source_work_turn_idx'`,
    ).get()).toMatchObject({ isUnique: 1, partial: 0 })
    const source = {
      workspaceId: workspace.id, worldId: world.id, workTurnId: turn.id,
      title: '整理本周周报', description: '把本周的会议纪要整理成一页周报。', priority: 'normal' as const, createdBy: 'owner',
    }
    const linked = repository.createTaskFromSource(source)
    expect(linked).toMatchObject({ created: true, task: { sourceWorkTurnId: turn.id, sourceMessageId: message.id } })
    expect(repository.createTaskFromSource(source)).toEqual({ created: false, task: linked.task })
    expect(repository.listTasks(world.id).map((task) => task.id).sort()).toEqual([legacyTask.id, linked.task.id].sort())
  })
})

describe('world trace watermark', () => {
  it('changes when a run changes status inside a single clock tick', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-'))
    // A frozen clock turns "the two writes landed in the same millisecond" from
    // a race that reproduces about once in six runs into a certainty. Real
    // runs hit it whenever a turn fails immediately: `startAgentRun` and
    // `failAgentRun` then carry the same timestamp.
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'), { clock: () => '2026-09-05T00:00:00.000Z' })
    stores.push(store)
    const workspace = store.createWorkspace({ name: '水位工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '水位世界', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint({ id: 'watermark.worker', worldTemplateId: 'cyber-company' }))
    const employee = store.recruitEmployee({
      workspaceId: workspace.id, worldId: world.id, blueprintId: 'watermark.worker', blueprintVersion: 1,
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
    })
    const turn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat',
    })
    const run = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, turnId: turn.id,
      sessionId: session.id, employeeId: employee.id, ordinal: 1,
    })

    store.startAgentRun(run.id)
    const whileRunning = store.worldTraceWatermark(world.id)
    store.failAgentRun(run.id, 'model-timeout')

    // The watermark is what the trace read model uses to decide whether its
    // cached projection is still good. If it does not move here, the user
    // keeps seeing a run that says it is running after it has failed.
    expect(store.worldTraceWatermark(world.id)).not.toBe(whileRunning)
  })

  it('stays byte-identical when nothing changed', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '稳定工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '稳定世界', templateId: 'cyber-company' })
    expect(store.worldTraceWatermark(world.id)).toBe(store.worldTraceWatermark(world.id))
  })
})
