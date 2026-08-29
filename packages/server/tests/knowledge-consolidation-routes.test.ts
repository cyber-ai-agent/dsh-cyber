import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { KnowledgeExtractionPort, KnowledgeExtractionRequest } from '../src/services/knowledge-extraction.js'
import { createCyberServer, type CyberServer } from '../src/server.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('knowledge consolidation job routes', () => {
  it('lists a failed conversation job and retries it to completion', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-knowledge-job-routes-'))
    roots.push(stateRoot)
    const extractor = new RecoveringExtractor()
    const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, knowledgeExtractionPort: extractor })
    servers.push(server)
    const origin = (await server.start()).origin
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const employee = server.store.listEmployees(world.id)[0]!
    const session = server.store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '知识整理失败可见性',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
    })
    server.store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '公司将在九月发布新版本。' })
    server.store.appendMessage({ sessionId: session.id, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '已确认九月发布计划。' })

    const queued = await postJson<{ job: { id: string } }>(`${origin}/api/worlds/${world.id}/knowledge/consolidate`, { sourceType: 'conversation', sourceId: session.id, fromCursor: 0, toCursor: 2 })
    expect(queued.status).toBe(202)
    await waitFor(async () => (await getJson<{ items: Array<{ id: string; status: string }> }>(`${origin}/api/worlds/${world.id}/knowledge/consolidation-jobs`)).items.find((job) => job.id === queued.body.job.id)?.status === 'failed')
    const failed = await getJson<{ items: Array<{ id: string; status: string; errorCode?: string }> }>(`${origin}/api/worlds/${world.id}/knowledge/consolidation-jobs?status=failed`)
    expect(failed.items).toEqual([expect.objectContaining({ id: queued.body.job.id, status: 'failed', errorCode: 'knowledge_model_timeout' })])

    extractor.recover()
    const retried = await postJson<{ job: { status: string } }>(`${origin}/api/worlds/${world.id}/knowledge/consolidation-jobs/${queued.body.job.id}/retry`, {})
    expect(retried).toMatchObject({ status: 202, body: { job: { status: 'queued' } } })
    await waitFor(async () => (await getJson<{ items: Array<{ id: string; status: string }> }>(`${origin}/api/worlds/${world.id}/knowledge/consolidation-jobs`)).items.find((job) => job.id === queued.body.job.id)?.status === 'completed')
    expect(extractor.calls).toBe(2)
  })
})

class RecoveringExtractor implements KnowledgeExtractionPort {
  calls = 0
  #failing = true

  recover(): void { this.#failing = false }

  async extract(request: KnowledgeExtractionRequest) {
    this.calls += 1
    if (this.#failing) {
      const error = new Error('model timeout') as Error & { code: string }
      error.code = 'knowledge_model_timeout'
      throw error
    }
    return {
      entities: [], claims: [], relations: [],
      evidenceRefs: request.evidence.map((item) => ({ sourceType: item.sourceType, sourceId: item.sourceId, evidenceId: item.evidenceId })),
    }
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body = await response.json() as T
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`)
  return body
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as T }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for knowledge consolidation state')
}
