import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EmployeeBlueprint, JsonObject } from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'
import { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { createBuiltinIntegrationRegistry } from '../src/integrations/builtin-integration-registry.js'
import type { McpClientConnection, McpClientFactory, McpConnectSpec, McpToolDefinition } from '../src/integrations/mcp-client.js'
import { MCP_INTEGRATION_ID } from '../src/integrations/mcp-provider.js'
import { IntegrationService } from '../src/integrations/integration-service.js'
import { CharacterSkillRuntime } from '../src/services/character-skill-runtime.js'
import type { CharacterSkillAdapter } from '../src/skills/skill-adapter.js'
import { CharacterSkillAdapterRegistry } from '../src/skills/skill-adapter.js'
import { McpSkillAdapter, mcpSkillId } from '../src/skills/mcp-skill-adapter.js'
import { SqliteSkillActionRepository } from '../src/skills/sqlite-skill-action-repository.js'

const roots: string[] = []
const stores: SqliteStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('MCP Skill Adapter V1', () => {
  it('discovers tools as skills and preserves Grant -> Approval -> Ledger before one call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-')); roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite')); stores.push(store)
    const workspace = store.createWorkspace({ name: 'MCP 测试工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: 'MCP 测试世界', templateId: 'personal-world' })
    const skillId = mcpSkillId('github', 'create_issue')
    const blueprint: EmployeeBlueprint = {
      schemaVersion: 1, id: 'test.mcp-worker', version: 1, worldTemplateId: 'personal-world',
      displayName: 'MCP 测试员', role: '测试员', summary: '验证 MCP 权限链', persona: '只执行明确批准的工具',
      requestedSkills: [skillId], requestedCapabilities: [], createdAt: '2026-08-25T00:00:00.000Z',
    }
    store.saveBlueprint(blueprint)
    const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1, skillGrants: [skillId] })
    const clients = new FakeMcpClientFactory([{
      endpoint: 'http://127.0.0.1:3900/mcp',
      tools: [{ name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }],
    }])
    const integrations = await IntegrationService.open(root, createBuiltinIntegrationRegistry(clients))
    await integrations.save({ workspaceId: workspace.id, integrationId: MCP_INTEGRATION_ID, config: { service: 'github', mode: 'remote', endpoint: 'http://127.0.0.1:3900/mcp' }, enabled: true, credential: 'private-bearer' })
    const adapter = new McpSkillAdapter({ store, integrations, clients })
    const registry = new CharacterSkillAdapterRegistry(); registry.register(adapter); await adapter.refresh(); registry.refresh(adapter)
    expect(registry.list()).toEqual([expect.objectContaining({ id: skillId, adapterId: 'builtin.mcp', risks: ['external-side-effect'] })])
    const runtime = new CharacterSkillRuntime(store, { registry, actions: new SqliteSkillActionRepository(store) })

    const denied = await registry.propose({ worldId: world.id, characterId: employee.id, prompt: '/mcp github.create_issue {"title":"secret subject"}', grantedSkillIds: [], now: new Date() })
    expect(denied).toEqual([])
    const session = store.createSession({
      workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: 'MCP 测试',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
    })
    const turn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat',
    })
    store.startWorkTurn(turn.id)
    const prepared = await runtime.prepare({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id,
      workTurnId: turn.id, characterId: employee.id,
      prompt: '/mcp github.create_issue {"title":"secret subject","body":"secret body"}',
    }, new Date('2026-08-25T01:00:00.000Z'))
    expect(prepared.actions[0]).toMatchObject({ status: 'waiting-for-approval', skillId, target: 'mcp:github.create_issue' })
    expect(JSON.stringify(prepared.actions[0]!.parameters)).not.toContain('secret subject')
    expect(clients.calls).toHaveLength(0)
    const approval = runtime.listApprovalRequests(world.id, 'pending')[0]!
    expect(approval).toMatchObject({ sessionId: session.id, workTurnId: turn.id })
    await expect(runtime.decideApproval(
      approval.id, 'approved', 'character', 'owner', new Date('2026-08-25T01:01:00.000Z'),
    )).rejects.toMatchObject({ code: 'persistent_approval_forbidden' })
    expect(clients.calls).toHaveLength(0)
    const result = await runtime.decideApproval(approval.id, 'approved', 'once', 'owner', new Date('2026-08-25T01:01:00.000Z'))
    expect(result.action).toMatchObject({ status: 'executed', detail: expect.stringContaining('原始结果未持久化') })
    expect(clients.calls).toEqual([{
      spec: { kind: 'remote', endpoint: 'http://127.0.0.1:3900/mcp', bearerToken: 'private-bearer' },
      name: 'create_issue',
      args: { title: 'secret subject', body: 'secret body' },
    }])
    expect(JSON.stringify(result.action)).not.toContain('secret body')
    expect(await readFile(join(root, 'integrations', 'connections.json'), 'utf8')).not.toContain('private-bearer')
    expect(await readFile(join(root, 'credentials', 'integration-credentials.json'), 'utf8')).not.toContain('secret subject')
    integrations.close()
  })

  it('supports several MCP services: targeted commands, bare disambiguation and per-service credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-multi-')); roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite')); stores.push(store)
    const workspace = store.createWorkspace({ name: 'MCP 多服务工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: 'MCP 多服务世界', templateId: 'personal-world' })

    const clients = new FakeMcpClientFactory([
      { endpoint: 'http://127.0.0.1:3900/mcp', tools: [{ name: 'create_issue', description: 'Open a GitHub issue', inputSchema: { type: 'object' } }] },
      { endpoint: 'http://127.0.0.1:3901/mcp', tools: [
        { name: 'create_issue', description: 'Open a Linear ticket', inputSchema: { type: 'object' } },
        { name: 'sync_board', description: 'Synchronize a board', inputSchema: { type: 'object' } },
      ] },
    ])
    const integrations = await IntegrationService.open(root, createBuiltinIntegrationRegistry(clients))
    const github = await integrations.save({ workspaceId: workspace.id, integrationId: MCP_INTEGRATION_ID, config: { service: 'github', mode: 'remote', endpoint: 'http://127.0.0.1:3900/mcp' }, enabled: true, credential: 'github-token' })
    await integrations.save({ workspaceId: workspace.id, integrationId: MCP_INTEGRATION_ID, config: { service: 'linear', mode: 'remote', endpoint: 'http://127.0.0.1:3901/mcp' }, enabled: true, credential: 'linear-token' })

    const blueprint: EmployeeBlueprint = {
      schemaVersion: 1, id: 'test.mcp-multi', version: 1, worldTemplateId: 'personal-world',
      displayName: 'MCP 多服务员', role: '测试员', summary: '验证多 MCP 服务', persona: '只执行明确批准的工具',
      requestedSkills: [mcpSkillId('github', 'create_issue'), mcpSkillId('linear', 'create_issue'), mcpSkillId('linear', 'sync_board')],
      requestedCapabilities: [], createdAt: '2026-08-25T00:00:00.000Z',
    }
    store.saveBlueprint(blueprint)
    const employee = store.recruitEmployee({
      workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1,
      skillGrants: [mcpSkillId('github', 'create_issue'), mcpSkillId('linear', 'create_issue'), mcpSkillId('linear', 'sync_board')],
    })

    const adapter = new McpSkillAdapter({ store, integrations, clients })
    await adapter.refresh()
    expect(adapter.descriptorsFor(workspace.id)).toEqual([
      expect.objectContaining({ id: 'mcp.github.create_issue' }),
      expect.objectContaining({ id: 'mcp.linear.create_issue' }),
      expect.objectContaining({ id: 'mcp.linear.sync_board' }),
    ])

    const granted = [mcpSkillId('github', 'create_issue'), mcpSkillId('linear', 'create_issue'), mcpSkillId('linear', 'sync_board')]
    const context = { worldId: world.id, characterId: employee.id, grantedSkillIds: granted, now: new Date() }

    // Bare `create_issue` is exposed by both granted services: ambiguous, no proposal.
    expect(await adapter.propose({ ...context, prompt: '/mcp create_issue {"a":1}' })).toEqual([])
    // Bare `sync_board` is unique to the linear service: resolves to it.
    const [sync] = await adapter.propose({ ...context, prompt: '/mcp sync_board {"a":1}' })
    expect(sync).toMatchObject({ skillId: 'mcp.linear.sync_board', target: 'mcp:linear.sync_board' })
    // Targeted command drives the github service even though the tool name is shared.
    const [githubIssue] = await adapter.propose({ ...context, prompt: '/mcp github.create_issue {"a":1}' })
    expect(githubIssue).toMatchObject({ skillId: 'mcp.github.create_issue', target: 'mcp:github.create_issue' })

    // Executing resolves each owning connection's endpoint and credential.
    await adapter.execute({ ...githubIssue, worldId: world.id, characterId: employee.id } as unknown as CharacterSkillAction)
    expect(clients.calls).toContainEqual({
      spec: { kind: 'remote', endpoint: 'http://127.0.0.1:3900/mcp', bearerToken: 'github-token' },
      name: 'create_issue',
      args: { a: 1 },
    })
    integrations.close()
  })

  it('discovers and executes through a launched local process spec without credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-local-')); roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite')); stores.push(store)
    const workspace = store.createWorkspace({ name: 'MCP 本机模式工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: 'MCP 本机模式世界', templateId: 'personal-world' })
    const skillId = mcpSkillId('playwright', 'browser_navigate')

    const clients = new FakeMcpClientFactory([{
      command: 'npx',
      tools: [{ name: 'browser_navigate', description: 'Navigate the browser', inputSchema: { type: 'object' } }],
    }])
    const integrations = await IntegrationService.open(root, createBuiltinIntegrationRegistry(clients))
    await integrations.save({
      workspaceId: workspace.id,
      integrationId: MCP_INTEGRATION_ID,
      config: { service: 'playwright', mode: 'local', command: 'npx', args: '@playwright/mcp@latest --port 8931' },
      enabled: true,
    })
    const adapter = new McpSkillAdapter({ store, integrations, clients })
    await adapter.refresh()
    expect(adapter.descriptorsFor(workspace.id)).toEqual([expect.objectContaining({ id: skillId })])

    // A legacy two-segment grant was rewritten by schema v53 to this exact
    // service-qualified id, so pre-multi-service characters keep working.
    const blueprint: EmployeeBlueprint = {
      schemaVersion: 1, id: 'test.mcp-local', version: 1, worldTemplateId: 'personal-world',
      displayName: 'MCP 本机员', role: '测试员', summary: '验证本机 MCP', persona: '只执行明确批准的工具',
      requestedSkills: [skillId], requestedCapabilities: [], createdAt: '2026-08-25T00:00:00.000Z',
    }
    store.saveBlueprint(blueprint)
    const employee = store.recruitEmployee({
      workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1,
      skillGrants: [skillId],
    })
    const [proposal] = await adapter.propose({
      worldId: world.id, characterId: employee.id, grantedSkillIds: [skillId], now: new Date(),
      prompt: '/mcp playwright.browser_navigate {"url":"https://example.com"}',
    })
    expect(proposal).toMatchObject({ skillId, target: 'mcp:playwright.browser_navigate' })
    const result = await adapter.execute({ ...proposal, worldId: world.id, characterId: employee.id } as unknown as CharacterSkillAction)
    expect(result.status).toBe('executed')
    // The local process is driven by command+args, never by a bearer credential.
    expect(clients.calls).toEqual([{
      spec: { kind: 'local', command: 'npx', args: ['@playwright/mcp@latest', '--port', '8931'] },
      name: 'browser_navigate',
      args: { url: 'https://example.com' },
    }])
    integrations.close()
  })

  it('stores arguments encrypted and supports deterministic cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-vault-')); roots.push(root)
    const clients = new FakeMcpClientFactory([])
    const service = await IntegrationService.open(root, createBuiltinIntegrationRegistry(clients))
    const reference = await service.storeMcpPayload({ password: 'never-persist-plain' }, new Date('2026-08-25T00:00:00.000Z'))
    expect(service.resolveMcpPayload(reference)).toEqual({ password: 'never-persist-plain' })
    await service.deleteMcpPayload(reference)
    expect(service.resolveMcpPayload(reference)).toBeUndefined()
    service.close()
  })
})

interface FakeService { endpoint?: string; command?: string; tools: McpToolDefinition[] }

class FakeMcpClientFactory implements McpClientFactory {
  readonly calls: Array<{ spec: McpConnectSpec; name: string; args: JsonObject }> = []
  constructor(readonly services: FakeService[]) {}
  async connect(spec: McpConnectSpec): Promise<McpClientConnection> {
    const service = this.services.find((item) =>
      spec.kind === 'remote' ? item.endpoint === spec.endpoint : item.command === spec.command,
    )
    const tools = service?.tools ?? []
    return {
      listTools: async () => tools,
      callTool: async (name, args) => {
        this.calls.push({ spec, name, args })
        return { content: [{ type: 'text', text: 'sensitive remote result' }], structuredContent: { issueId: 42 } }
      },
      close: async () => undefined,
    }
  }
}
