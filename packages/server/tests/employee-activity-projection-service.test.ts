import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { EmployeeActivityProjectionService } from '../src/services/employee-activity-projection-service.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('EmployeeActivityProjectionService', () => {
  it('backfills completed conversations into evidence-linked milestones and daily journals idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-employee-activity-'))
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
    const workspace = store.createWorkspace({ name: '档案投影测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '赛博公司', templateId: 'cyber-company' })
    const blueprint = BUILTIN_BLUEPRINTS.find((item) => item.id === 'core.butler') ?? BUILTIN_BLUEPRINTS[0]!
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '查询天气',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const prompt = store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '查询明天的天气',
    })
    const tool = store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'tool-call',
      content: '调用工具：web_search',
      metadata: { traceTurnId: 'turn-1', toolName: 'web_search' },
    })
    const result = store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'tool-result',
      content: '工具执行完成',
      metadata: { traceTurnId: 'turn-1', toolName: 'web_search', failed: false },
    })
    const reply = store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '已经查到天气并给出可靠来源。',
      metadata: { traceTurnId: 'turn-1' },
    })
    const completed = store.appendDomainEvent({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      type: 'turn.completed',
      actorId: employee.id,
      actorKind: 'employee',
      payload: { traceTurnId: 'turn-1' },
    })

    const projection = new EmployeeActivityProjectionService(store)
    projection.project(employee.id)
    projection.project(employee.id)

    const dossier = store.getEmployeeDossier(employee.id)
    const projected = dossier.milestones.filter((item) => item.sourceEventIds.includes(completed.id))
    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({
      title: '完成一次有工具证据的任务',
      sourceMessageIds: [prompt.id, tool.id, result.id, reply.id],
    })
    expect(projected[0]?.summary).toContain('web_search')
    expect(dossier.journals).toHaveLength(1)
    expect(dossier.journals[0]?.sourceEventIds).toContain(completed.id)
    expect(dossier.journals[0]?.highlights[0]).toContain('查询明天的天气')
  })
})
