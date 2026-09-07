import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCyberServer, type CyberServer } from '../src/index.js'
let server: CyberServer; let origin: string; let root: string; let workspaceId: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cyber-stats-api-'))
  server = await createCyberServer({ stateRoot: root, workspacePath: root, port: 0 })
  workspaceId = server.store.createWorkspace({ name: 'stats' }).id
  origin = (await server.start()).origin
})
afterAll(async () => { await server.close(); await rm(root, { recursive: true, force: true }) })
describe('model statistics route validation', () => {
  it.each([
    ['groupBy=unknown', 'invalid_stats_group'], ['groupBy=', 'invalid_stats_group'],
    ['groupBy=provider', 'missing_stats_provider'], ['groupBy=provider&providerId=', 'missing_stats_provider'],
    ['from=nope', 'invalid_from_date'], ['from=', 'invalid_from_date'], ['to=2026-02-30', 'invalid_to_date'],
    ['from=2026-09-08T00%3A00%3A00Z&to=2026-09-07T00%3A00%3A00Z', 'invalid_stats_range'],
  ])('rejects %s', async (query, code) => {
    const r = await fetch(`${origin}/api/workspaces/${workspaceId}/model-stats?${query}`)
    expect(r.status).toBe(422); expect((await r.json()).error.code).toBe(code)
  })
  it('returns an empty successful response only for a valid empty query', async () => {
    const r = await fetch(`${origin}/api/workspaces/${workspaceId}/model-stats`)
    expect(r.status).toBe(200); expect((await r.json()).summary.totalRequests).toBe(0)
  })
})
