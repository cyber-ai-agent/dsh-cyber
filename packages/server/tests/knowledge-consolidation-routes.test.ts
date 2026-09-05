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
  it('connects indexed library documents to the graph and keeps manual scans world-scoped', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-knowledge-source-scan-'))
    roots.push(stateRoot)
    const requests: KnowledgeExtractionRequest[] = []
    const extractor: KnowledgeExtractionPort = { async extract(input) {
      requests.push(input)
      const evidenceId = input.evidence[0]!.evidenceId
      return { payload: {
        entities: [{ key: 'sqlite', type: 'technology', canonicalName: 'SQLite', aliases: [], evidenceRefs: [evidenceId] }],
        claims: [{ key: 'local', type: 'fact', subjectKey: 'sqlite', predicate: '存储方式', objectText: '本地数据库', confidence: 0.9, evidenceRefs: [evidenceId] }],
        relations: [], evidenceRefs: [{ evidenceId, sourceType: input.sourceType, sourceId: input.sourceId }],
      } }
    } }
    const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, knowledgeExtractionPort: extractor })
    servers.push(server)
    const origin = (await server.start()).origin
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const other = server.store.createWorld({ workspaceId: workspace.id, name: '其他资料', templateId: 'personal-world' })
    for (const current of [world, other]) await server.knowledge.createFromText({ workspaceId: workspace.id, worldId: current.id, title: '数据库说明', text: 'SQLite 是本地数据库。' })
    // Move only fixture timestamps past the source quiet window. No real sleep
    // or explicit source enqueue bypasses the production scan path.
    server.store.database.prepare('UPDATE knowledge_documents SET updated_at = ?').run(new Date(Date.now() - 60_000).toISOString())
    const scan = await postJson<{ scan: { worlds: number; queued: number } }>(`${origin}/api/worlds/${world.id}/knowledge/consolidate`, {})
    expect(scan.body.scan).toEqual({ worlds: 1, sessions: 0, queued: 1 })
    await waitFor(async () => (await getJson<{ items: Array<{ status: string }> }>(`${origin}/api/worlds/${world.id}/knowledge/consolidation-jobs`)).items.some((job) => job.status === 'completed'))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sourceType).toBe('document')
    expect(requests[0]?.worldId).toBe(world.id)
    const graph = await getJson<{ claims: unknown[]; evidence: Array<{ sourceType: string }> }>(`${origin}/api/worlds/${world.id}/knowledge/graph`)
    expect(graph.claims).toHaveLength(1)
    expect(graph.evidence[0]?.sourceType).toBe('document')
    const repeated = await postJson<{ scan: { queued: number } }>(`${origin}/api/worlds/${world.id}/knowledge/consolidate`, {})
    expect(repeated.body.scan.queued).toBe(0)
  })

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

describe('knowledge source version, chunk cursor and completion watermark', () => {
  it('resumes a long document after a rate-limited window and a restart without re-extracting done chunks', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-knowledge-chunk-cursor-'))
    roots.push(stateRoot)
    const extractor = new ChunkRecordingExtractor()
    const first = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, knowledgeExtractionPort: extractor })
    servers.push(first)
    const origin = (await first.start()).origin
    const workspace = first.store.listWorkspaces()[0]!
    const world = first.store.listWorlds(workspace.id)[0]!
    const document = await first.knowledge.createFromText({
      workspaceId: workspace.id, worldId: world.id, title: '长篇资料', text: longDocumentText(40),
    })
    expect(document.chunkCount).toBeGreaterThan(20)
    const jobsUrl = `${origin}/api/worlds/${world.id}/knowledge/consolidation-jobs`
    const scanUrl = `${origin}/api/worlds/${world.id}/knowledge/consolidate`
    // One fixed revision past the source quiet window: the document is not
    // being edited between windows, only walked further.
    const aged = new Date(Date.now() - 60_000).toISOString()
    const ageSources = (): void => {
      first.store.database.prepare('UPDATE knowledge_documents SET updated_at = ?').run(aged)
    }

    // First window: the document is only partly processed, and the job says so.
    ageSources()
    await postJson(scanUrl, {})
    await waitFor(async () => (await getJson<{ items: KnowledgeJobView[] }>(jobsUrl)).items.some((job) => job.status === 'completed'))
    const afterFirst = (await getJson<{ items: KnowledgeJobView[] }>(jobsUrl)).items.find((job) => job.sourceId === document.id)!
    expect(afterFirst.chunkTotal).toBe(document.chunkCount)
    expect(afterFirst.processedChunks).toBeGreaterThan(0)
    expect(afterFirst.processedChunks).toBeLessThan(document.chunkCount)
    const doneAfterFirst = afterFirst.processedChunks!

    // A 429 in the middle leaves the watermark exactly where it was, and the
    // next window starts at the chunk that failed — never past it.
    extractor.failNextWith('knowledge_model_rate_limited')
    ageSources()
    await postJson(scanUrl, {})
    await waitFor(async () => (await getJson<{ items: KnowledgeJobView[] }>(`${jobsUrl}?status=failed`)).items.length > 0)
    const failed = (await getJson<{ items: KnowledgeJobView[] }>(`${jobsUrl}?status=failed`)).items[0]!
    expect(failed).toMatchObject({ errorCode: 'knowledge_model_rate_limited', fromCursor: doneAfterFirst, processedChunks: doneAfterFirst })
    expect(failed.processedChunks).toBeLessThan(failed.chunkTotal!)

    // Restart: the durable watermark, not process memory, decides where to go on.
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    const resumed = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, knowledgeExtractionPort: extractor })
    servers.push(resumed)
    const resumedOrigin = (await resumed.start()).origin
    const resumedJobs = `${resumedOrigin}/api/worlds/${world.id}/knowledge/consolidation-jobs`
    const seenBeforeRestart = new Set(extractor.chunkIds)
    for (let pass = 0; pass < 12; pass += 1) {
      resumed.store.database.prepare('UPDATE knowledge_documents SET updated_at = ?').run(aged)
      // Only the transient-failure backoff is fast-forwarded; the retry itself
      // still goes through the production scan path.
      resumed.store.database.prepare("UPDATE knowledge_consolidation_jobs SET updated_at = ? WHERE status = 'failed'").run(aged)
      await postJson(`${resumedOrigin}/api/worlds/${world.id}/knowledge/consolidate`, {})
      await waitFor(async () => (await getJson<{ items: KnowledgeJobView[] }>(resumedJobs)).items.every((job) => job.status === 'completed' || job.status === 'failed'))
      const latest = (await getJson<{ items: KnowledgeJobView[] }>(resumedJobs)).items.find((job) => job.sourceId === document.id)!
      if (latest.processedChunks === latest.chunkTotal) break
    }
    const finished = (await getJson<{ items: KnowledgeJobView[] }>(resumedJobs)).items.find((job) => job.sourceId === document.id)!
    expect(finished.processedChunks).toBe(document.chunkCount)
    expect(finished.chunkTotal).toBe(document.chunkCount)

    // Every chunk was extracted exactly once across the failure and the restart.
    expect(new Set(extractor.chunkIds).size).toBe(extractor.chunkIds.length)
    expect(new Set(extractor.chunkIds).size).toBe(document.chunkCount)
    expect([...seenBeforeRestart].every((id) => extractor.chunkIds.indexOf(id) === extractor.chunkIds.lastIndexOf(id))).toBe(true)

    // A fully processed version queues nothing again — and a source row merely
    // touched by a re-scan does not re-extract a document whose text is
    // unchanged, because the watermark is keyed on content, not a timestamp.
    resumed.store.database.prepare('UPDATE knowledge_documents SET updated_at = ?').run(new Date(Date.now() - 60_000).toISOString())
    const repeated = await postJson<{ scan: { queued: number } }>(`${resumedOrigin}/api/worlds/${world.id}/knowledge/consolidate`, {})
    expect(repeated.body.scan.queued).toBe(0)
  }, 60_000)

  it('walks a long document whose pre-migration job already reports completed', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-knowledge-legacy-job-'))
    roots.push(stateRoot)
    const extractor = new ChunkRecordingExtractor()
    const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, knowledgeExtractionPort: extractor })
    servers.push(server)
    const origin = (await server.start()).origin
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const document = await server.knowledge.createFromText({
      workspaceId: workspace.id, worldId: world.id, title: '迁移前就整理过的长资料', text: longDocumentText(40),
    })
    expect(document.chunkCount).toBeGreaterThan(20)

    // The pre-42 state, written the way the old code wrote it: one job row for
    // the whole source, from_cursor 0 and the revision timestamp as to_cursor,
    // status completed — and no knowledge_source_versions row at all, because
    // migration 42 deliberately backfills nothing.
    const aged = new Date(Date.now() - 60_000).toISOString()
    const ageSources = (): void => {
      server.store.database.prepare('UPDATE knowledge_documents SET updated_at = ?').run(aged)
    }
    server.store.database.prepare(
      `INSERT INTO knowledge_consolidation_jobs
       (id, workspace_id, world_id, source_type, source_id, from_cursor, to_cursor, status, attempt, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, 'document', ?, 0, ?, 'completed', 1, ?, ?, ?, ?)`,
    ).run('legacy-completed-job', workspace.id, world.id, document.id, Date.parse(aged), aged, aged, aged, aged)
    ageSources()
    expect(server.store.database.prepare('SELECT COUNT(*) AS total FROM knowledge_source_versions').get()).toMatchObject({ total: 0 })

    const jobsUrl = `${origin}/api/worlds/${world.id}/knowledge/consolidation-jobs`
    const scanUrl = `${origin}/api/worlds/${world.id}/knowledge/consolidate`
    // The very first scan must refuse to accept that row as coverage.
    const firstScan = await postJson<{ scan: { queued: number } }>(scanUrl, {})
    expect(firstScan.body.scan.queued).toBe(1)

    for (let pass = 0; pass < 12; pass += 1) {
      ageSources()
      await postJson(scanUrl, {})
      await waitFor(async () => (await getJson<{ items: KnowledgeJobView[] }>(jobsUrl)).items.every((job) => job.status === 'completed' || job.status === 'failed'))
      const latest = (await getJson<{ items: KnowledgeJobView[] }>(jobsUrl)).items.find((job) => job.sourceId === document.id)!
      if (latest.chunkTotal !== undefined && latest.processedChunks === latest.chunkTotal) break
    }

    // A real watermark, walked chunk by chunk — never a completion stamped
    // from the legacy row.
    const versions = server.store.database.prepare(
      'SELECT processed_chunks, chunk_total, completed_at FROM knowledge_source_versions WHERE world_id = ? AND source_id = ?',
    ).all(world.id, document.id) as Array<Record<string, unknown>>
    expect(versions).toMatchObject([{ processed_chunks: document.chunkCount, chunk_total: document.chunkCount, completed_at: expect.any(String) }])
    expect(new Set(extractor.chunkIds).size).toBe(document.chunkCount)
    expect(new Set(extractor.chunkIds).size).toBe(extractor.chunkIds.length)

    // Once the watermark is real, the source stops being re-queued.
    ageSources()
    const repeated = await postJson<{ scan: { queued: number } }>(scanUrl, {})
    expect(repeated.body.scan.queued).toBe(0)
  }, 60_000)

  it('starts a new version when the source content changes and keeps the previous claims for review', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-knowledge-source-version-'))
    roots.push(stateRoot)
    const extractor = new ChunkRecordingExtractor()
    const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, knowledgeExtractionPort: extractor })
    servers.push(server)
    const origin = (await server.start()).origin
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const document = await server.knowledge.createFromText({ workspaceId: workspace.id, worldId: world.id, title: '会更新的资料', text: '第一版：本地存储使用 SQLite。' })
    const jobsUrl = `${origin}/api/worlds/${world.id}/knowledge/consolidation-jobs`
    server.store.database.prepare('UPDATE knowledge_documents SET updated_at = ?').run(new Date(Date.now() - 60_000).toISOString())
    await postJson(`${origin}/api/worlds/${world.id}/knowledge/consolidate`, {})
    await waitFor(async () => (await getJson<{ items: KnowledgeJobView[] }>(jobsUrl)).items.some((job) => job.status === 'completed'))
    const completed = (await getJson<{ items: KnowledgeJobView[] }>(jobsUrl)).items[0]!
    expect(completed).toMatchObject({ processedChunks: document.chunkCount, chunkTotal: document.chunkCount })
    const graphBefore = await getJson<{ claims: unknown[] }>(`${origin}/api/worlds/${world.id}/knowledge/graph`)
    expect(graphBefore.claims.length).toBeGreaterThan(0)

    const updated = await server.knowledge.createFromText({
      workspaceId: workspace.id, worldId: world.id, title: '会更新的资料',
      text: '第二版：本地存储改为 SQLite WAL 模式，并新增了备份说明。',
    })
    expect(updated.id).toBe(document.id)
    expect(updated.sha256).not.toBe(document.sha256)
    server.store.database.prepare('UPDATE knowledge_documents SET updated_at = ?').run(new Date(Date.now() - 60_000).toISOString())
    await postJson(`${origin}/api/worlds/${world.id}/knowledge/consolidate`, {})
    await waitFor(async () => {
      const items = (await getJson<{ items: KnowledgeJobView[] }>(jobsUrl)).items
      return items.length > 1 && items.every((job) => job.status === 'completed')
    })

    const versions = server.store.database.prepare(
      'SELECT content_hash, superseded_by_hash, superseded_at, processed_chunks, chunk_total FROM knowledge_source_versions WHERE world_id = ? AND source_id = ? ORDER BY created_at',
    ).all(world.id, document.id) as Array<Record<string, unknown>>
    expect(versions).toMatchObject([
      { content_hash: document.sha256, superseded_by_hash: updated.sha256, superseded_at: expect.any(String) },
      { content_hash: updated.sha256, superseded_by_hash: null, processed_chunks: updated.chunkCount, chunk_total: updated.chunkCount },
    ])
    // The invalidation seam: nothing from the old version was discarded here.
    // Evidence downgrade is a separate, explicit decision.
    const graphAfter = await getJson<{ claims: unknown[] }>(`${origin}/api/worlds/${world.id}/knowledge/graph`)
    expect(graphAfter.claims.length).toBeGreaterThanOrEqual(graphBefore.claims.length)
  }, 30_000)
})

interface KnowledgeJobView {
  id: string
  sourceType: string
  sourceId: string
  status: string
  fromCursor: number
  toCursor: number
  errorCode?: string
  processedChunks?: number
  chunkTotal?: number
}

function longDocumentText(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, index) =>
    `第 ${index + 1} 段：本地事实源在第 ${index + 1} 节记录了一条独立结论。${'这一段用于占满一个分块的目标长度，使分块边界稳定可预期。'.repeat(24)}`)
    .join('\n\n')
}

/** Records the chunk ids handed to the model so a repeat is observable. */
class ChunkRecordingExtractor implements KnowledgeExtractionPort {
  readonly chunkIds: string[] = []
  #failWith: string | undefined

  failNextWith(code: string): void { this.#failWith = code }

  async extract(request: KnowledgeExtractionRequest) {
    if (this.#failWith !== undefined) {
      const code = this.#failWith
      this.#failWith = undefined
      const error = new Error('model rejected the request') as Error & { code: string }
      error.code = code
      throw error
    }
    for (const evidence of request.evidence) if (evidence.chunkId !== undefined) this.chunkIds.push(evidence.chunkId)
    const evidenceId = request.evidence[0]!.evidenceId
    return { payload: {
      entities: [{ key: 'store', type: 'technology', canonicalName: '本地事实源', aliases: [], evidenceRefs: [evidenceId] }],
      claims: [{ key: 'fact', type: 'fact', subjectKey: 'store', predicate: '记录于', objectText: request.sourceId, confidence: 0.9, evidenceRefs: [evidenceId] }],
      relations: [], evidenceRefs: [{ evidenceId, sourceType: request.sourceType, sourceId: request.sourceId }],
    } }
  }
}

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
