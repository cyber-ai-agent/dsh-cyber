import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeuristicGroupTurnPlanner } from '@dsh-cyber/orchestration'
import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'
import { createCyberServer, type CyberServer } from '../src/index.js'
import { WorldPackageInstanceService } from '../src/services/world-package-instance-service.js'

const servers: CyberServer[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const privateError = '401 provider Authorization=secret-fixture-value /private/preparation.json'
class FailureRuntime implements AgentRuntimePort {
  calls: AgentTurnRequest[] = []
  constructor(readonly mode: string) {}
  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    if (this.mode === 'throw') throw new Error(privateError)
    request.onEvent?.({ kind: 'turn.failed', source: 'fixture', sourceSessionId: 'fixture', failed: true, metadata: { failure: 'provider-authentication', statusCode: 401 } })
    return { agentSessionId: 'fixture', finalResponse: '', eventCount: 1 }
  }
  async close() {}
}

async function getJson(origin: string, path: string) {
  const response = await fetch(origin + path)
  expect(response.ok).toBe(true)
  return response.json()
}

describe('accepted conversation failure feedback', () => {
  it.each(['direct', 'group'].flatMap((kind) => ['event', 'throw', 'preparation'].map((mode) => ({ kind, mode }))))('persists one $kind notice for $mode failure and never replays the accepted turn', async ({ kind, mode }) => {
    const root = await mkdtemp(join(tmpdir(), 'cyber-failure-feedback-'))
    roots.push(root)
    const runtime = new FailureRuntime(mode)
    const server = await createCyberServer({ stateRoot: root, workspacePath: root, port: 0, bootstrapDefaultWorld: true, runtime, groupTurnPlanner: new HeuristicGroupTurnPlanner() })
    servers.push(server)
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const employee = server.store.listEmployees(world.id)[0]!
    const employeeIds = [employee.id]
    if (kind === 'group') employeeIds.push(server.store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName: '另一位角色' }).id)
    const unrelated = server.store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '无关会话' })
    const origin = (await server.start()).origin
    if (mode === 'preparation') vi.spyOn(WorldPackageInstanceService.prototype, 'listRuntimePackages').mockRejectedValue(new Error(privateError))
    const request = { employeeIds, prompt: '大家聊聊这条消息', collaborationMode: 'discussion', queueMode: 'normal', clientTurnId: `accepted-${kind}-${mode}` }
    const submit = () => fetch(`${origin}/api/worlds/${world.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
    const accepted = await submit()
    expect(accepted.status).toBe(202)
    const receipt = await accepted.json() as { session: { id: string }; workTurnId: string }
    await vi.waitFor(() => expect(server.store.getWorkTurn(receipt.workTurnId)?.status).toBe('failed'), { timeout: 10_000 })
    const readTranscript = () => getJson(origin, `/api/sessions/${receipt.session.id}/messages?view=chat`)
    const first = await readTranscript()
    const notices = first.items.filter((message: any) => message.kind === 'system')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ sessionId: receipt.session.id, metadata: { control: 'failure', status: 'failed', workTurnId: receipt.workTurnId, clientTurnId: request.clientTurnId } })
    expect(notices[0].content).toContain(mode === 'preparation' ? '处理消息时发生错误' : 'API 密钥被模型服务拒绝')
    expect(first.items.filter((message: any) => message.kind === 'user')).toHaveLength(1)
    expect(JSON.stringify(first)).not.toContain('secret-fixture-value')
    const failureQueue = await getJson(origin, `/api/worlds/${world.id}/chat-queue?status=failed`)
    expect(JSON.stringify(failureQueue)).not.toContain('secret-fixture-value')
    expect((await getJson(origin, `/api/worlds/${world.id}/chat-queue`)).items).toHaveLength(0)
    expect((await getJson(origin, `/api/sessions/${unrelated.id}/messages?view=chat`)).items).toHaveLength(0)
    const calls = runtime.calls.length
    expect(calls).toBe(mode === 'preparation' ? 0 : employeeIds.length)
    expect((await submit()).status).toBe(202)
    expect((await readTranscript()).items).toEqual(first.items)
    expect(runtime.calls).toHaveLength(calls)
    expect(server.store.listTurnAgentRuns(receipt.workTurnId)).toHaveLength(calls)
  })
})
