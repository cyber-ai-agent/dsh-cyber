import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest, SkillAuthoringDraft } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('Skill Center authoring routes', () => {
  it('analyzes, publishes, installs, loads and exposes one generated Skill package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-authoring-route-')); roots.push(root)
    const server = await createCyberServer({
      stateRoot: root, workspacePath: root, port: 0, bootstrapDefaultWorld: true, runtime: new QuietRuntime(),
      skillAuthoringAnalyzer: { analyze: async () => ({ draft }) },
    }); servers.push(server)
    const { origin } = await server.start()
    const workspace = (await get(origin, '/api/workspaces')).items[0]
    const world = (await get(origin, `/api/workspaces/${workspace.id}/worlds`)).items[0]

    const analyzed = await post(origin, `/api/workspaces/${workspace.id}/skill-authoring/analyze`, { source: { kind: 'description', text: '做发布检查' } })
    expect(analyzed.draft).toMatchObject({ id: draft.id, integrationId: 'builtin.recipe' })
    const published = await post(origin, `/api/workspaces/${workspace.id}/skill-authoring/publish`, { source: { kind: 'description', text: '做发布检查' }, draft })
    expect(published.item.manifest).toMatchObject({ kind: 'skill', version: '1.0.0', entrypoints: [{ id: draft.id, kind: 'skill' }] })

    const preview = await post(origin, `/api/workspaces/${workspace.id}/packages/preview`, { manifest: published.item.manifest })
    await post(origin, `/api/workspaces/${workspace.id}/packages/install`, { manifest: published.item.manifest, sourceDirectory: published.item.sourceDirectory, approvalToken: preview.approvalToken, worldId: world.id })
    const catalog = await get(origin, `/api/workspaces/${workspace.id}/skill-catalog`)
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: draft.id, kind: 'recipe', worldAvailable: true }))
    const detail = await get(origin, `/api/workspaces/${workspace.id}/skills/${encodeURIComponent(draft.id)}/detail`)
    expect(detail).toMatchObject({ editable: true, tree: expect.arrayContaining([{ path: 'SKILL.md', kind: 'file' }]) })
    const edited = await post(origin, `/api/workspaces/${workspace.id}/skill-authoring/publish`, {
      source: { kind: 'description', text: '补充验收证据' }, draft: { ...draft, instructions: '核对测试、版本、风险、证据和回滚方案。' },
      basePackageId: published.item.manifest.id, basePackageVersion: published.item.manifest.version,
    })
    expect(edited.item.manifest).toMatchObject({ id: published.item.manifest.id, version: '1.0.1' })

    const settings = await put(origin, `/api/workspaces/${workspace.id}/skill-settings`, { scope: 'workspace', scopeId: workspace.id, skillIds: [draft.id] })
    expect(settings.global).toMatchObject({ configured: true, skillIds: [draft.id] })
    expect((await get(origin, `/api/worlds/${world.id}/skill-catalog`)).items.find((item: { id: string }) => item.id === draft.id)).toMatchObject({ worldAvailable: true })
  })
})

const draft: SkillAuthoringDraft = { schemaVersion: 1, id: 'custom.release-check', displayName: '发布检查', summary: '检查发布前条件。', routingHints: ['发布', '检查'], integrationId: 'builtin.recipe', dataEgress: [], instructions: '核对测试、版本、风险和回滚方案。', sourceSummary: '测试草稿。' }
class QuietRuntime implements AgentRuntimePort { async runTurn(request: AgentTurnRequest) { return { agentSessionId: request.agent.agentSessionId ?? 'quiet', finalResponse: '完成', eventCount: 0 } } async close() {} }
async function get(origin: string, path: string): Promise<any> { const response = await fetch(`${origin}${path}`); expect(response.status).toBe(200); return response.json() }
async function post(origin: string, path: string, body: unknown): Promise<any> { const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status).toBeLessThan(300); return response.json() }
async function put(origin: string, path: string, body: unknown): Promise<any> { const response = await fetch(`${origin}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status).toBeLessThan(300); return response.json() }
