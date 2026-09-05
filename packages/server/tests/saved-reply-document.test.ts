import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'
import { WorldArtifactRepository } from '@dsh-cyber/persistence'

import { createCyberServer, type CyberServer } from '../src/index.js'
import { SavedReplyDocumentService } from '../src/services/saved-reply-document-service.js'
import type { ServiceError } from '../src/services/service-error.js'
import { WorldArtifactService } from '../src/services/world-artifact-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'

const stores: Array<{ close(): void }> = []
const rootsToRemove: string[] = []
const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const store of stores.splice(0)) store.close()
  for (const root of rootsToRemove.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('saving a chat reply as a document', () => {
  it('registers the reply as an owner-published document with no run attribution', async () => {
    const fixture = await createFixture()
    const reply = fixture.appendAssistantReply('# 会议纪要\n\n- 下周一复盘\n- 负责人：管家\n')

    const publication = await fixture.savedReplies.saveAssistantReply({ worldId: fixture.world.id, messageId: reply.id })

    expect(publication.created).toBe(true)
    expect(publication.artifact.kind).toBe('markdown')
    expect(publication.artifact.createdByKind).toBe('owner')
    expect(publication.artifact.title).toBe('会议纪要')
    // A saved reply is a thing the owner kept, never a thing a Run produced.
    expect(publication.version.agentRunId).toBeUndefined()
    expect(publication.version.workTurnId).toBeUndefined()
    expect(publication.version.employeeId).toBeUndefined()
    expect(publication.version.mimeType).toBe('text/markdown; charset=utf-8')

    const view = await fixture.artifacts.describe(fixture.world.id, publication.artifact.id)
    expect(view.evidence).toEqual([{ version: 1, grade: 'owner-published', proven: false }])
    // The World Trace answers "what did a run produce"; a kept reply is not an
    // answer to that question and must not appear as one.
    expect(fixture.artifacts.listRunProvenance(fixture.world.id)).toEqual([])
  })

  it('lists the saved document in the world and reads the original reply back', async () => {
    const fixture = await createFixture()
    const body = '# 周报\n\n本周完成三项调研。\n'
    const reply = fixture.appendAssistantReply(body)

    const publication = await fixture.savedReplies.saveAssistantReply({ worldId: fixture.world.id, messageId: reply.id })

    const listed = fixture.artifacts.list(fixture.world.id)
    expect(listed.map((artifact) => artifact.id)).toEqual([publication.artifact.id])
    expect(listed[0]?.title).toBe('周报')
    const preview = await fixture.artifacts.preview(fixture.world.id, publication.artifact.id)
    expect(preview.body.toString('utf8')).toBe(body)
    expect(preview.contentType).toBe('text/markdown; charset=utf-8')
    expect(publication.version.relativePath.endsWith('.md')).toBe(true)
  })

  it('refuses to save a reply that belongs to another world', async () => {
    const fixture = await createFixture()
    const foreign = fixture.createSecondWorld()
    const reply = fixture.appendAssistantReply('# 另一个世界的回复\n', foreign.sessionId)

    await expect(fixture.savedReplies.saveAssistantReply({ worldId: fixture.world.id, messageId: reply.id }))
      .rejects.toMatchObject<Partial<ServiceError>>({ code: 'artifact_reply_world_mismatch' })

    expect(fixture.artifacts.list(fixture.world.id)).toEqual([])
    expect(fixture.artifacts.list(foreign.worldId)).toEqual([])
  })

  it('refuses a row with no text and a row that is not a character reply', async () => {
    const fixture = await createFixture()
    const blank = fixture.appendAssistantReply('   \n')
    const ownerMessage = fixture.store.appendMessage({
      sessionId: fixture.session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '帮我写一份周报。',
    })

    await expect(fixture.savedReplies.saveAssistantReply({ worldId: fixture.world.id, messageId: blank.id }))
      .rejects.toMatchObject<Partial<ServiceError>>({ code: 'artifact_reply_empty' })
    await expect(fixture.savedReplies.saveAssistantReply({ worldId: fixture.world.id, messageId: ownerMessage.id }))
      .rejects.toMatchObject<Partial<ServiceError>>({ code: 'artifact_reply_not_assistant' })
    await expect(fixture.savedReplies.saveAssistantReply({ worldId: fixture.world.id, messageId: 'no-such-message' }))
      .rejects.toMatchObject<Partial<ServiceError>>({ code: 'artifact_reply_not_found' })
    expect(fixture.artifacts.list(fixture.world.id)).toEqual([])
  })

  it('keeps a repeated save of the same reply as one document', async () => {
    const fixture = await createFixture()
    const reply = fixture.appendAssistantReply('# 归档说明\n\n重复保存不应该产生第二份。\n')

    const first = await fixture.savedReplies.saveAssistantReply({ worldId: fixture.world.id, messageId: reply.id })
    const second = await fixture.savedReplies.saveAssistantReply({ worldId: fixture.world.id, messageId: reply.id })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.artifact.id).toBe(first.artifact.id)
    expect(second.version.version).toBe(1)
    expect(fixture.artifacts.list(fixture.world.id)).toHaveLength(1)
  })

  it('uses an owner-supplied name when one is given, and never a run grade', async () => {
    const fixture = await createFixture()
    const reply = fixture.appendAssistantReply('这段回复的第一行很长很长，长到不适合直接当作文件名使用，所以需要一个更短的名字。')

    const publication = await fixture.savedReplies.saveAssistantReply({
      worldId: fixture.world.id,
      messageId: reply.id,
      title: '调研结论',
    })

    expect(publication.artifact.title).toBe('调研结论')
    const view = await fixture.artifacts.describe(fixture.world.id, publication.artifact.id)
    expect(view.evidence?.[0]?.grade).toBe('owner-published')
    expect(view.evidence?.[0]?.proven).toBe(false)
  })
})

describe('saving a chat reply over HTTP', () => {
  it('publishes the stored reply and refuses browser-supplied provenance or body text', async () => {
    const { origin, server } = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const employee = server.store.listEmployees(world.id)[0]!
    const session = server.store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: 'HTTP 回复测试',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
    })
    const reply = server.store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '# 保存到世界\n\n这段文字只是回复，没有任何文件被执行生成。\n',
    })

    const forged = await post(`${origin}/api/worlds/${world.id}/artifacts/save-reply`, {
      messageId: reply.id,
      agentRunId: 'run-forged',
    })
    expect(forged.status).toBe(403)

    const fabricated = await post(`${origin}/api/worlds/${world.id}/artifacts/save-reply`, {
      messageId: reply.id,
      text: '# 浏览器伪造的正文\n',
    })
    expect(fabricated.status).toBe(403)

    const saved = await post(`${origin}/api/worlds/${world.id}/artifacts/save-reply`, { messageId: reply.id })
    expect(saved.status).toBe(201)
    const artifactId = (saved.body as { artifact: { id: string } }).artifact.id
    const described = await (await fetch(`${origin}/api/worlds/${world.id}/artifacts/${artifactId}`)).json() as {
      artifact: { createdByKind: string; title: string }
      evidence: Array<{ grade: string; proven: boolean }>
    }
    expect(described.artifact.createdByKind).toBe('owner')
    expect(described.evidence).toEqual([{ version: 1, grade: 'owner-published', proven: false }])
    const preview = await fetch(`${origin}/api/worlds/${world.id}/artifacts/${artifactId}/preview/1`)
    expect(await preview.text()).toContain('这段文字只是回复')

    const otherWorld = server.store.createWorld({ workspaceId: workspace.id, name: '隔离世界', templateId: 'personal-world' })
    const crossWorld = await post(`${origin}/api/worlds/${otherWorld.id}/artifacts/save-reply`, { messageId: reply.id })
    expect(crossWorld.status).toBe(403)
    expect((crossWorld.body as { error?: { code?: string } }).error?.code).toBe('artifact_reply_world_mismatch')
    expect(server.artifacts.list(otherWorld.id)).toEqual([])
  })
})

class QuietRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`, finalResponse: '好的。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}

async function startServer(): Promise<{ origin: string; server: CyberServer }> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-saved-reply-http-'))
  rootsToRemove.push(stateRoot)
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime: new QuietRuntime(),
    bootstrapDefaultWorld: true,
  })
  servers.push(server)
  return { origin: (await server.start()).origin, server }
}

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

async function createFixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-saved-reply-'))
  rootsToRemove.push(stateRoot)
  const { SqliteStore } = await import('@dsh-cyber/persistence')
  const store = await SqliteStore.open(join(stateRoot, 'data.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '回复世界', templateId: 'personal-world' })
  store.saveBlueprint({
    schemaVersion: 1,
    id: 'reply-worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '记录员',
    role: '助理',
    summary: '测试角色',
    persona: '只回复文字。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-25T00:00:00.000Z',
  })
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'reply-worker', blueprintVersion: 1 })
  const session = store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'direct',
    title: '回复测试',
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
  })
  const roots = new WorldRootService(stateRoot)
  const root = await roots.ensure(world.id)
  const artifacts = new WorldArtifactService({ repository: new WorldArtifactRepository(store.database), roots })
  const savedReplies = new SavedReplyDocumentService({ store, artifacts })
  return {
    stateRoot,
    store,
    workspace,
    world,
    employee,
    session,
    roots,
    root,
    artifacts,
    savedReplies,
    appendAssistantReply(content: string, sessionId = session.id) {
      return store.appendMessage({ sessionId, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content })
    },
    createSecondWorld() {
      const other = store.createWorld({ workspaceId: workspace.id, name: '另一个世界', templateId: 'personal-world' })
      const otherEmployee = store.recruitEmployee({ workspaceId: workspace.id, worldId: other.id, blueprintId: 'reply-worker', blueprintVersion: 1 })
      const otherSession = store.createSession({
        workspaceId: workspace.id,
        worldId: other.id,
        kind: 'direct',
        title: '另一个会话',
        participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: otherEmployee.id, kind: 'employee' }],
      })
      return { worldId: other.id, sessionId: otherSession.id }
    },
  }
}
