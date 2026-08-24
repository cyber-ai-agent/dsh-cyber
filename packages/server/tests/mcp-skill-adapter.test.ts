import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EmployeeBlueprint, JsonObject } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { createBuiltinIntegrationRegistry } from '../src/integrations/builtin-integration-registry.js'
import type { McpClientConnection, McpClientFactory, McpToolDefinition } from '../src/integrations/mcp-client.js'
import { MCP_INTEGRATION_ID } from '../src/integrations/mcp-provider.js'
import { IntegrationService } from '../src/integrations/integration-service.js'
import { CharacterSkillRuntime } from '../src/services/character-skill-runtime.js'
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
    const skillId = mcpSkillId('github.create_issue')
    const blueprint: EmployeeBlueprint = {
      schemaVersion: 1, id: 'test.mcp-worker', version: 1, worldTemplateId: 'personal-world',
      displayName: 'MCP 测试员', role: '测试员', summary: '验证 MCP 权限链', persona: '只执行明确批准的工具',
      requestedSkills: [skillId], requestedCapabilities: [], createdAt: '2026-08-25T00:00:00.000Z',
    }
    store.saveBlueprint(blueprint)
    const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1, skillGrants: [skillId] })
    const clients = new FakeMcpClientFactory([{
      name: 'github.create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    }])
    const integrations = await IntegrationService.open(root, createBuiltinIntegrationRegistry(clients))
    await integrations.save({ workspaceId: workspace.id, integrationId: MCP_INTEGRATION_ID, config: { endpoint: 'http://127.0.0.1:3900/mcp' }, enabled: true, credential: 'private-bearer' })
    const adapter = new McpSkillAdapter({ store, integrations, clients })
    const registry = new CharacterSkillAdapterRegistry(); registry.register(adapter); await adapter.refresh(); registry.refresh(adapter)
    expect(registry.list()).toEqual([expect.objectContaining({ id: skillId, adapterId: 'builtin.mcp', risks: ['external-side-effect'] })])
    const runtime = new CharacterSkillRuntime(store, { registry, actions: new SqliteSkillActionRepository(store) })

    const denied = await registry.propose({ worldId: world.id, characterId: employee.id, prompt: '/mcp github.create_issue {"title":"secret subject"}', grantedSkillIds: [], now: new Date() })
    expect(denied).toEqual([])
    const prepared = await runtime.prepare(world.id, employee.id, '/mcp github.create_issue {"title":"secret subject","body":"secret body"}', new Date('2026-08-25T01:00:00.000Z'))
    expect(prepared.actions[0]).toMatchObject({ status: 'waiting-for-approval', skillId, target: 'mcp:github.create_issue' })
    expect(JSON.stringify(prepared.actions[0]!.parameters)).not.toContain('secret subject')
    expect(clients.calls).toHaveLength(0)
    const approval = runtime.listApprovalRequests(world.id, 'pending')[0]!
    const result = await runtime.decideApproval(approval.id, 'approved', 'once', 'owner', new Date('2026-08-25T01:01:00.000Z'))
    expect(result.action).toMatchObject({ status: 'executed', detail: expect.stringContaining('原始结果未持久化') })
    expect(clients.calls).toEqual([{ name: 'github.create_issue', args: { title: 'secret subject', body: 'secret body' } }])
    expect(JSON.stringify(result.action)).not.toContain('secret body')
    expect(await readFile(join(root, 'integrations', 'connections.json'), 'utf8')).not.toContain('private-bearer')
    expect(await readFile(join(root, 'credentials', 'integration-credentials.json'), 'utf8')).not.toContain('secret subject')
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

class FakeMcpClientFactory implements McpClientFactory {
  readonly calls: Array<{ name: string; args: JsonObject }> = []
  constructor(readonly tools: McpToolDefinition[]) {}
  async connect(): Promise<McpClientConnection> {
    return {
      listTools: async () => this.tools,
      callTool: async (name, args) => { this.calls.push({ name, args }); return { content: [{ type: 'text', text: 'sensitive remote result' }], structuredContent: { issueId: 42 } } },
      close: async () => undefined,
    }
  }
}
