import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentRuntimePort, AgentTurnRequest, EmployeeBlueprint, JsonObject } from '@dsh-cyber/contracts'
import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { createBuiltinIntegrationRegistry } from '../src/integrations/builtin-integration-registry.js'
import { IntegrationService } from '../src/integrations/integration-service.js'
import type { McpClientConnection, McpClientFactory, McpConnectSpec } from '../src/integrations/mcp-client.js'
import { MCP_INTEGRATION_ID } from '../src/integrations/mcp-provider.js'
import { CharacterSkillRuntime } from '../src/services/character-skill-runtime.js'
import { CredentialManager } from '../src/services/credential-manager.js'
import { ModelCredentialService } from '../src/services/model-credential-service.js'
import { TurnAwareApprovalContinuationService } from '../src/services/turn-aware-approval-continuation-service.js'
import { WorldPackageInstanceService } from '../src/services/world-package-instance-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'
import { WorldRuntimeContextComposer } from '../src/services/world-runtime-context-composer.js'
import { McpSkillAdapter, mcpSkillId } from '../src/skills/mcp-skill-adapter.js'
import { CharacterSkillAdapterRegistry, type CharacterSkillAdapter, type CharacterSkillMatchContext } from '../src/skills/skill-adapter.js'
import { SqliteSkillActionRepository } from '../src/skills/sqlite-skill-action-repository.js'

const roots: string[] = []
const resources = new Set<{ close(): void }>()
const skillId = mcpSkillId('calendar', 'lookup_issue')
const credential = 'mcp-fixture-private-connection-value'
const password = 'mcp-fixture-private-password-value'
const opaqueBytes = 'MCP_OPAQUE_IMAGE_BYTES'

afterEach(async () => {
  for (const resource of resources) resource.close()
  resources.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('MCP result to final conversation reply', () => {
  it('carries text and structured values through approval into the actual saved assistant reply', async () => {
    const fixture = await setup(successfulResult())
    const pending = await fixture.continuations.direct(request(fixture))
    const approval = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')[0]!

    expect(pending.waitingForApproval).toBe(true)
    expect(fixture.clients.calls).toHaveLength(0)
    expect(fixture.agent.calls).toHaveLength(0)
    // The production adapter still requires a one-time approval for every call.
    expect(fixture.skills.allowedApprovalScopes(skillId)).toEqual(['once'])

    const decided = await fixture.continuations.decideApproval(approval.id, 'approved', 'once', 'owner')
    const action = fixture.store.getSkillAction(approval.subjectId)!
    expect(action).toMatchObject({ status: 'executed', executionState: 'settled', workTurnId: pending.workTurnId })
    expect(fixture.clients.calls).toHaveLength(1)
    expect(fixture.clients.calls[0]).toMatchObject({ name: 'lookup_issue', args: { title: 'appointment lookup' } })
    expect(fixture.agent.calls).toHaveLength(1)
    const reply = savedReply(fixture, pending.session.id, pending.workTurnId)
    expect(decided.continuation?.replies[0]?.content).toBe(reply.content)
    expectSuccessValues(reply.content)
    expectSanitizedEvidence(action.detail, fixture.agent.calls[0]!.prompt, reply.content)
    expect(fixture.integrations.resolveMcpPayload(String(action.parameters.payloadRef))).toBeUndefined()
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('completed')
    expect(fixture.store.listTurnAgentRuns(pending.workTurnId)).toEqual([
      expect.objectContaining({ ordinal: 1, status: 'completed' }),
    ])

    await expect(fixture.continuations.decideApproval(approval.id, 'approved', 'once', 'owner'))
      .rejects.toMatchObject({ code: 'approval_already_decided' })
    await fixture.continuations.recover()
    expect(fixture.clients.calls).toHaveLength(1)
    expect(fixture.agent.calls).toHaveLength(1)
  })

  it('reloads settled MCP evidence from SQLite after restart without executing the approved action again', async () => {
    const fixture = await setup(successfulResult())
    const pending = await fixture.continuations.direct(request(fixture))
    const approval = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')[0]!
    // Model the process-death seam after tool settlement but before chat resumes.
    await fixture.skills.decideApproval(approval.id, 'approved', 'once', 'owner')
    const persisted = fixture.store.getSkillAction(approval.subjectId)!
    expect(persisted.status).toBe('executed')
    expect(fixture.clients.calls).toHaveLength(1)
    expect(fixture.agent.calls).toHaveLength(0)
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('waiting-approval')

    closeResource(fixture.integrations)
    closeResource(fixture.modelCredentials)
    closeResource(fixture.store)
    // Any accidental replay now fails instead of providing the original values.
    fixture.clients.result = new Error('A settled MCP action must not run again')
    const store = track(await SqliteStore.open(join(fixture.root, 'data', 'dsh-cyber.sqlite')))
    const integrations = track(await IntegrationService.open(fixture.root, createBuiltinIntegrationRegistry(fixture.clients)))
    const restarted = await attachRuntime(fixture.root, store, integrations, fixture.clients, fixture)
    expect(restarted.store.getSkillAction(approval.subjectId)?.detail).toBe(persisted.detail)

    await restarted.continuations.recover()
    const reply = savedReply(restarted, pending.session.id, pending.workTurnId)
    expectSuccessValues(reply.content)
    expectSanitizedEvidence(persisted.detail, restarted.agent.calls[0]!.prompt, reply.content)
    expect(restarted.store.getSkillAction(approval.subjectId)?.status).toBe('executed')
    expect(restarted.store.getWorkTurn(pending.workTurnId)?.status).toBe('completed')
    expect(fixture.clients.calls).toHaveLength(1)
    expect(restarted.agent.calls).toHaveLength(1)
    await restarted.continuations.recover()
    expect(fixture.clients.calls).toHaveLength(1)
    expect(restarted.agent.calls).toHaveLength(1)
  })

  it('persists isError as failed and delivers its error evidence rather than a success reply', async () => {
    const fixture = await setup({
      isError: true,
      content: [{ type: 'text', text: 'Lookup refused: quota_exhausted for this workspace.' }],
      structuredContent: { issueId: 42, error: 'quota_exhausted' },
    })
    const pending = await fixture.continuations.direct(request(fixture))
    const approval = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')[0]!
    const decided = await fixture.continuations.decideApproval(approval.id, 'approved', 'once', 'owner')

    expect(decided.action.status).toBe('failed')
    expect(fixture.store.getSkillAction(approval.subjectId)).toMatchObject({ status: 'failed', executionState: 'settled' })
    expect(fixture.clients.calls).toHaveLength(1)
    const reply = savedReply(fixture, pending.session.id, pending.workTurnId)
    const result = JSON.parse(reply.content)
    expect(result.status).toBe('failed')
    expect(result.evidence).toContain('quota_exhausted')
    expect(result.evidence).toContain('42')
    expect(decided.continuation?.replies[0]?.content).toBe(reply.content)
    expect(hostFacts(fixture.agent.calls[0]!.prompt)).not.toContain('：已执行')
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('completed')
    await fixture.continuations.recover()
    expect(fixture.clients.calls).toHaveLength(1)
  })

  it('keeps a thrown transport outcome unknown in the final reply and never retries it', async () => {
    const fixture = await setup(new Error('Connection closed before receipt'))
    const pending = await fixture.continuations.direct(request(fixture))
    const approval = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')[0]!
    const decided = await fixture.continuations.decideApproval(approval.id, 'approved', 'once', 'owner')

    expect(decided.action.status).toBe('outcome-unknown')
    expect(fixture.store.getSkillAction(approval.subjectId)).toMatchObject({ status: 'outcome-unknown', executionState: 'settled' })
    const reply = savedReply(fixture, pending.session.id, pending.workTurnId)
    expect(JSON.parse(reply.content).status).toBe('outcome-unknown')
    expect(decided.continuation?.replies[0]?.content).toBe(reply.content)
    expect(hostFacts(fixture.agent.calls[0]!.prompt)).not.toContain('：已执行')
    expect(hostFacts(fixture.agent.calls[0]!.prompt)).not.toContain('：执行失败')
    await fixture.skills.executeReadyAction(approval.subjectId)
    await fixture.continuations.recover()
    expect(await fixture.continuations.continueIfReady(pending.workTurnId)).toBeUndefined()
    expect(fixture.clients.calls).toHaveLength(1)
    expect(fixture.agent.calls).toHaveLength(1)
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('completed')
  })

  it('also carries MCP values through the fresh direct path with an isolated exact-target harness', async () => {
    const fixture = await setup({ content: [{ type: 'text', text: 'Policy priming result' }] }, true)
    const priming = await fixture.continuations.direct(request(fixture, 'prime exact target'))
    const approval = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')[0]!
    await fixture.continuations.decideApproval(approval.id, 'approved', 'character', 'owner')
    expect(fixture.store.getWorkTurn(priming.workTurnId)?.status).toBe('completed')
    expect(fixture.store.listWorldApprovalPolicies(fixture.worldId)).toHaveLength(1)

    fixture.clients.result = successfulResult()
    const direct = await fixture.continuations.direct(request(fixture, 'fresh direct lookup'))
    expect(direct.waitingForApproval).toBe(false)
    expect(direct.workTurnId).not.toBe(priming.workTurnId)
    const [action] = fixture.store.listWorldSkillActions(fixture.worldId).filter((item) => item.workTurnId === direct.workTurnId)
    expect(action).toMatchObject({ status: 'executed', authorization: 'preapproved-policy', executionState: 'settled' })
    const reply = savedReply(fixture, direct.session.id, direct.workTurnId)
    expect(direct.replies[0]?.content).toBe(reply.content)
    expectSuccessValues(reply.content)
    expectSanitizedEvidence(action!.detail, fixture.agent.calls.at(-1)!.prompt, reply.content)
    expect(fixture.clients.calls).toHaveLength(2)
    expect(fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')).toEqual([])
  })
})

function successfulResult() {
  return {
    content: [
      // The returned date is beyond the former 300-character line limit.
      { type: 'text', text: `${'Calendar availability context. '.repeat(20)}Available date: 2026-10-12` },
      { type: 'text', text: `Connection diagnostic: ${credential}` },
      { type: 'image', mimeType: 'image/png', data: opaqueBytes.repeat(1_000) },
    ],
    structuredContent: { issueId: 42, password },
  }
}

function expectSuccessValues(content: string) {
  const result = JSON.parse(content)
  expect(result.status).toBe('executed')
  expect(result.evidence).toContain('2026-10-12')
  expect(result.evidence).toContain('issueId')
  expect(result.evidence).toMatch(/issueId["']?\s*[:=：]\s*42/)
}

function expectSanitizedEvidence(...values: Array<string | undefined>) {
  for (const value of values) {
    expect(value).toBeDefined()
    expect(value).not.toContain(credential)
    expect(value).not.toContain(password)
    expect(value).not.toContain(opaqueBytes)
    expect(value!.length).toBeLessThan(16_000)
  }
}

function hostFacts(prompt: string): string {
  return prompt.split('[已授权角色技能的真实执行结果]')[1]?.split('只能根据以上持久化事实')[0] ?? ''
}

/**
 * A deterministic data-path probe, not a model-compliance test. Its answer is
 * computed only from the received host status and quoted external evidence;
 * it has no fixture values, MCP-client access, or database access to fall back to.
 */
class PromptDerivedRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    const facts = hostFacts(request.prompt)
    const status = facts.includes('：结果未知') ? 'outcome-unknown'
      : facts.includes('：执行失败') ? 'failed'
      : facts.includes('：已执行') ? 'executed' : 'missing-status'
    const evidence = request.prompt.split('\n').filter((line) => line.startsWith('> ')).map((line) => line.slice(2)).join('\n')
    return {
      agentSessionId: `agent-${request.agent.id}`,
      finalResponse: JSON.stringify({ status, evidence }),
      eventCount: 0,
    }
  }
  async close() {}
}

class ResultMcpClientFactory implements McpClientFactory {
  readonly calls: Array<{ spec: McpConnectSpec; name: string; args: JsonObject }> = []
  constructor(public result: unknown) {}
  async connect(spec: McpConnectSpec): Promise<McpClientConnection> {
    return {
      listTools: async () => [{ name: 'lookup_issue', inputSchema: { type: 'object' } }],
      callTool: async (name, args) => {
        this.calls.push({ spec, name, args })
        if (this.result instanceof Error) throw this.result
        return this.result
      },
      close: async () => undefined,
    }
  }
}

/**
 * Test-only seam for the fresh direct branch. Production MCP descriptors remain
 * approval-forbidden; this wrapper delegates proposal, preflight, and execution
 * unchanged and primes a real exact-target policy through the approval service.
 */
class ExactTargetMcpHarness implements CharacterSkillAdapter {
  readonly id: string
  constructor(readonly delegate: McpSkillAdapter) { this.id = delegate.id }
  get descriptors(): readonly CharacterSkillDescriptor[] {
    return this.delegate.descriptors.map((descriptor) => ({ ...descriptor, persistentApproval: 'exact-target' as const }))
  }
  propose(context: CharacterSkillMatchContext) { return this.delegate.propose(context) }
  preflight(action: CharacterSkillAction) { return this.delegate.preflight(action) }
  execute(action: CharacterSkillAction) { return this.delegate.execute(action) }
  discard(action: CharacterSkillAction) { return this.delegate.discard(action) }
}

interface FixtureIds { workspaceId: string; worldId: string; employeeId: string }
type Fixture = Awaited<ReturnType<typeof setup>>

async function setup(result: unknown, exactTargetHarness = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-continuation-')); roots.push(root)
  const store = track(await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite')))
  const workspace = store.createWorkspace({ name: 'MCP 结果测试工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: 'MCP 结果测试世界', templateId: 'personal-world' })
  const clients = new ResultMcpClientFactory(result)
  const integrations = track(await IntegrationService.open(root, createBuiltinIntegrationRegistry(clients)))
  const connection = await integrations.save({
    workspaceId: workspace.id, integrationId: MCP_INTEGRATION_ID, enabled: true, credential,
    config: { service: 'calendar', mode: 'remote', endpoint: 'http://127.0.0.1:3900/mcp' },
  })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1, id: 'mcp-result-worker', version: 1, worldTemplateId: 'personal-world',
    displayName: '结果测试员', role: '测试员', summary: '验证 MCP 结果传递', persona: '根据真实结果回复',
    requestedSkills: [skillId], requestedCapabilities: [], createdAt: '2026-10-08T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({
    workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1,
    skillGrants: [skillId],
  })
  store.reviseEmployee({ employeeId: employee.id, reason: 'Grant the fixture MCP connection', connectionGrants: [connection.id] })
  return attachRuntime(root, store, integrations, clients, {
    workspaceId: workspace.id, worldId: world.id, employeeId: employee.id,
  }, exactTargetHarness)
}

async function attachRuntime(
  root: string, store: SqliteStore, integrations: IntegrationService, clients: ResultMcpClientFactory,
  ids: FixtureIds, exactTargetHarness = false,
) {
  const modelCredentials = track(await ModelCredentialService.open(root))
  const credentials = new CredentialManager({ modelCredentials, integrations, listModelReferences: () => [], environment: {} })
  const mcp = new McpSkillAdapter({
    store, integrations, clients, credentials,
    connectionGrantsFor: (characterId) => {
      const employee = store.getEmployee(characterId)
      return employee === undefined ? [] : store.getEmployeeRevision(employee.id, employee.currentRevision)?.connectionGrants ?? []
    },
  })
  await mcp.refresh()
  const registry = new CharacterSkillAdapterRegistry()
  registry.register(exactTargetHarness ? new ExactTargetMcpHarness(mcp) : mcp)
  const skills = new CharacterSkillRuntime(store, {
    registry, actions: new SqliteSkillActionRepository(store),
    redactText: (value, workspaceId) => credentials.redactText(value, workspaceId),
    redactJson: (value, workspaceId) => credentials.redactJson(value, workspaceId),
  })
  const agent = new PromptDerivedRuntime()
  const orchestrator = new ConversationOrchestrator({ store, runtime: agent, workspacePath: root })
  const continuations = new TurnAwareApprovalContinuationService({
    store, orchestrator, skills, settings: new WorldRuntimeContextComposer(),
    worldPackages: new WorldPackageInstanceService(store, new WorldRootService(root)),
  })
  return { ...ids, root, store, integrations, modelCredentials, clients, skills, agent, continuations }
}

function request(fixture: FixtureIds, title = 'appointment lookup') {
  const prompt = `/mcp calendar.lookup_issue ${JSON.stringify({ title })}`
  return {
    workspaceId: fixture.workspaceId, worldId: fixture.worldId, employeeId: fixture.employeeId,
    prompt, skillPrompt: prompt, transformedPrompt: prompt,
  }
}

function savedReply(fixture: Fixture, sessionId: string, workTurnId: string) {
  const replies = fixture.store.listMessages(sessionId).filter((message) => message.kind === 'assistant' && message.metadata.workTurnId === workTurnId)
  expect(replies).toHaveLength(1)
  expect(replies[0]?.metadata.source).toBe('runtime-final-response')
  return replies[0]!
}

function track<T extends { close(): void }>(resource: T): T { resources.add(resource); return resource }
function closeResource(resource: { close(): void }) { resource.close(); resources.delete(resource) }
