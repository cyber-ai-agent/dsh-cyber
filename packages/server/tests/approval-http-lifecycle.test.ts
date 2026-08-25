import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, ApprovalRequestView, World } from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import { createCyberServer, type CyberServer } from '../src/index.js'
import { CharacterSkillAdapterRegistry, type CharacterSkillAdapter } from '../src/skills/skill-adapter.js'

const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

class QuietRuntime implements AgentRuntimePort {
  readonly prompts: string[] = []

  async runTurn(request: AgentTurnRequest) {
    this.prompts.push(request.prompt)
    return { agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`, finalResponse: '好的。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}

const TEST_SKILL = 'test.external-switch'

/**
 * Minimal adapter with a real external side effect, so the approval gate is
 * exercised exactly as a shipped integration would exercise it.
 */
class SwitchAdapter implements CharacterSkillAdapter {
  readonly id = 'test.switch'
  readonly executed: CharacterSkillAction[] = []
  readonly descriptors = [{
    id: TEST_SKILL,
    displayName: '外部开关',
    summary: '切换一个真实设备。',
    adapterId: 'test.switch',
    risks: ['external-side-effect' as const],
    supportsScheduling: false,
    persistentApproval: 'forbidden' as const,
    kind: 'integration' as const,
    recommendedByDefault: false,
  }]

  propose(context: { worldId: string; characterId: string; prompt: string; grantedSkillIds: string[]; now: Date }) {
    if (!context.prompt.includes('关灯')) return []
    if (!context.grantedSkillIds.includes(TEST_SKILL)) return []
    return [{
      skillId: TEST_SKILL,
      adapterId: this.id,
      action: 'switch.turn_off',
      target: 'light.kitchen',
      label: '关闭厨房灯',
      risk: 'external-side-effect' as const,
      authorization: 'explicit-user-request' as const,
      parameters: { entityId: 'light.kitchen' },
    }]
  }

  async execute(action: CharacterSkillAction) {
    this.executed.push(action)
    return { status: 'executed' as const, detail: '厨房灯已关闭' }
  }
}

async function start(adapter: SwitchAdapter, runtime: QuietRuntime) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-approval-http-'))
  const registry = new CharacterSkillAdapterRegistry()
  registry.register(adapter)
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime,
    skillRegistry: registry,
  })
  servers.push(server)
  const address = await server.start()
  return { origin: address.origin, server }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function bootstrap(origin: string, server: CyberServer): Promise<{ world: World; characterId: string }> {
  const workspace = await json(origin, '/api/workspaces', post({ name: '本地实例' }))
  const workspaceId = workspace.body.workspace.id as string
  const created = await json(origin, `/api/workspaces/${workspaceId}/worlds`, post({ name: '我的世界', templateId: 'personal-world' }))
  const world = created.body.world as World

  // A grant must be a subset of what the blueprint requested, so the fixture
  // declares the request. Everything the approval gate touches after this runs
  // over HTTP.
  server.store.saveBlueprint({
    schemaVersion: 1,
    id: 'test-operator',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '阿开',
    role: '设备管家',
    summary: '负责真实设备操作的角色。',
    persona: '你负责真实设备操作，只在获得授权后执行。',
    requestedSkills: [TEST_SKILL],
    requestedCapabilities: [],
    createdAt: '2026-08-24T00:00:00.000Z',
  })
  const recruited = await json(origin, `/api/worlds/${world.id}/recruit`, post({
    blueprintId: 'test-operator',
    blueprintVersion: 1,
    skillGrants: [TEST_SKILL],
  }))
  expect(recruited.response.status).toBeLessThan(300)
  return { world, characterId: recruited.body.employee.id as string }
}

async function chat(origin: string, worldId: string, characterId: string, prompt: string) {
  return json(origin, `/api/worlds/${worldId}/chat`, post({ prompt, employeeIds: [characterId] }))
}

describe('approval gate over the HTTP surface', () => {
  it('drives propose to approve to execute entirely through the API a client can call', async () => {
    const adapter = new SwitchAdapter()
    const runtime = new QuietRuntime()
    const { origin, server } = await start(adapter, runtime)
    const { world, characterId } = await bootstrap(origin, server)

    // --- propose -------------------------------------------------------
    const turn = await chat(origin, world.id, characterId, '帮我关灯')
    expect(turn.response.status).toBe(200)
    expect(turn.body.waitingForApproval).toBe(true)
    expect(turn.body.replies).toEqual([])
    // Nothing may reach the device before a human decides.
    expect(adapter.executed).toHaveLength(0)

    // --- the pending decision must be reachable and legible -------------
    const pending = await json(origin, `/api/worlds/${world.id}/approvals?status=pending`)
    expect(pending.response.status).toBe(200)
    const items = pending.body.items as ApprovalRequestView[]
    expect(items).toHaveLength(1)
    const view = items[0]!
    expect(view.request).toMatchObject({ status: 'pending', risk: 'external-side-effect', worldId: world.id })
    // A one-line summary is not enough to consent to a real side effect.
    expect(view.subject).toMatchObject({
      adapterId: 'test.switch',
      skillId: TEST_SKILL,
      action: 'switch.turn_off',
      target: 'light.kitchen',
      parameters: { entityId: 'light.kitchen' },
    })
    expect(view.characterName).toBeDefined()

    // --- approve --------------------------------------------------------
    const decided = await json(origin, `/api/approvals/${view.request.id}/decision`, post({ decision: 'approved', scope: 'once' }))
    expect(decided.response.status).toBe(200)
    expect(decided.body.request.status).toBe('approved')

    // --- execute --------------------------------------------------------
    expect(adapter.executed).toHaveLength(1)
    expect(adapter.executed[0]).toMatchObject({ action: 'switch.turn_off', target: 'light.kitchen' })
    const actions = await json(origin, `/api/worlds/${world.id}/skill-actions`)
    expect((actions.body.items as CharacterSkillAction[]).map((item) => item.status)).toEqual(['executed'])
    // The turn resumes and the character answers with the real outcome.
    expect(runtime.prompts.at(-1)).toContain('厨房灯已关闭')

    // The decision is single use.
    const replayed = await json(origin, `/api/approvals/${view.request.id}/decision`, post({ decision: 'approved', scope: 'once' }))
    expect(replayed.response.status).toBe(409)
    expect(adapter.executed).toHaveLength(1)
    expect((await json(origin, `/api/worlds/${world.id}/approvals?status=pending`)).body.items).toEqual([])
  })

  it('never touches the device when the user rejects', async () => {
    const adapter = new SwitchAdapter()
    const { origin, server } = await start(adapter, new QuietRuntime())
    const { world, characterId } = await bootstrap(origin, server)

    await chat(origin, world.id, characterId, '帮我关灯')
    const pending = await json(origin, `/api/worlds/${world.id}/approvals?status=pending`)
    const view = (pending.body.items as ApprovalRequestView[])[0]!

    const decided = await json(origin, `/api/approvals/${view.request.id}/decision`, post({ decision: 'rejected', scope: 'once' }))
    expect(decided.response.status).toBe(200)
    expect(decided.body.request.status).toBe('rejected')
    expect(adapter.executed).toEqual([])
    const actions = await json(origin, `/api/worlds/${world.id}/skill-actions`)
    expect((actions.body.items as CharacterSkillAction[]).every((item) => item.status !== 'executed')).toBe(true)
  })

  it('refuses a persistent scope for a skill that forbids one', async () => {
    const adapter = new SwitchAdapter()
    const { origin, server } = await start(adapter, new QuietRuntime())
    const { world, characterId } = await bootstrap(origin, server)

    await chat(origin, world.id, characterId, '帮我关灯')
    const pending = await json(origin, `/api/worlds/${world.id}/approvals?status=pending`)
    const view = (pending.body.items as ApprovalRequestView[])[0]!

    // 'forbidden' means every call needs a fresh decision, forever.
    const decided = await json(origin, `/api/approvals/${view.request.id}/decision`, post({ decision: 'approved', scope: 'world' }))
    expect(decided.response.status).toBeGreaterThanOrEqual(400)
    expect(adapter.executed).toEqual([])
  })
})
