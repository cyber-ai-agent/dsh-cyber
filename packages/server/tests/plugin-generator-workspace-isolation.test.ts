import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PluginImportAnalyzeResult } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

/**
 * Plugin Generator output is workspace-private, exactly like Character, World
 * and Skin Generator output: a generated plugin is listed, previewed,
 * installable and readable only by the workspace that published it. A prompt
 * transform is the most direct route into a runtime prompt, so this pins the
 * boundary for the fourth generator before any UI exists.
 */

type AnyRecord = Record<string, any>

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Plugin Generator workspace isolation', () => {
  it('hides a generated plugin from every workspace but its own', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const generated = await publishPlugin(server.origin, alpha.id)

    expect(await listMarket(server.origin, alpha.id)).toContain(generated.packageId)
    expect(await listMarket(server.origin, beta.id)).not.toContain(generated.packageId)
    // No workspace named: fail closed.
    expect(await listMarket(server.origin, undefined)).not.toContain(generated.packageId)

    const betaPreview = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    expect(betaPreview.status).toBe(404)
    const alphaPreview = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    expect(alphaPreview.status, JSON.stringify(alphaPreview.body)).toBe(200)
  })

  it('refuses to install another workspace generated plugin, through the market and directly', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const generated = await publishPlugin(server.origin, alpha.id)

    const betaMarketInstall = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/install`, { packageId: generated.packageId, version: generated.version, approvalToken: 'unused' })
    expect(betaMarketInstall.status).toBe(404)

    // The direct path: B knows the manifest and the real directory and is still
    // refused. `kind: 'plugin'` is a shape the direct route admits, so here the
    // refusal has to come from the workspace ownership check itself.
    const alphaPreview = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    expect(alphaPreview.status, JSON.stringify(alphaPreview.body)).toBe(200)
    const manifest = alphaPreview.body.item.manifest as AnyRecord
    const sourceDirectory = alphaPreview.body.item.sourceDirectory as string
    const betaApproval = await postJson(server.origin, `/api/workspaces/${beta.id}/packages/preview`, { manifest })
    const betaDirectInstall = await postJson(server.origin, `/api/workspaces/${beta.id}/packages/install`, { manifest, sourceDirectory, approvalToken: betaApproval.body.approvalToken ?? 'unused' })
    expect([404, 422]).toContain(betaDirectInstall.status)
    expect(server.store.getActivePackage(beta.id, generated.packageId)).toBeUndefined()
    // B's command picker never lists A's trigger.
    const betaCommands = await getJson(server.origin, `/api/workspaces/${beta.id}/plugins`)
    expect(betaCommands.status).toBe(200)
    expect((betaCommands.body.items as AnyRecord[]).map((item) => item.packageId)).not.toContain(generated.packageId)

    // The owning workspace installs it through the ordinary plugin install
    // path, into its own world, and the trigger surfaces where every other
    // installed prompt transform does.
    const world = server.store.listWorlds(alpha.id, true).find((item) => item.status === 'active')!
    const alphaInstall = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/install`, { packageId: generated.packageId, version: generated.version, approvalToken: alphaPreview.body.preview.approvalToken, worldId: world.id })
    expect(alphaInstall.status, JSON.stringify(alphaInstall.body)).toBe(201)
    expect(alphaInstall.body.installed.kind).toBe('plugin')
    expect(alphaInstall.body.installed.capabilities).toEqual(['prompt:transform'])
    const alphaCommands = await getJson(server.origin, `/api/workspaces/${alpha.id}/plugins`)
    expect(alphaCommands.status).toBe(200)
    const command = (alphaCommands.body.items as AnyRecord[]).find((item) => item.packageId === generated.packageId)
    expect(command?.trigger).toBe('/weekly-review')
    expect(command?.displayTrigger).toBe('/weekly-review')
    expect(command?.automatic).toBe(false)
    const worldCommands = await getJson(server.origin, `/api/worlds/${world.id}/plugins`)
    expect(worldCommands.status).toBe(200)
    expect((worldCommands.body.items as AnyRecord[]).map((item) => item.trigger)).toContain('/weekly-review')
    // The instruction itself never leaves the server through the picker.
    expect(JSON.stringify(alphaCommands.body)).not.toContain('只依据当前会话')
  })
})

async function publishPlugin(origin: string, workspaceId: string): Promise<{ packageId: string; version: string }> {
  const source = { kind: 'paste' as const, text: '把每周的会话整理成复盘：进展、阻碍、下周计划。'.repeat(3) }
  const analyzed = await postJson(origin, `/api/workspaces/${workspaceId}/plugin-generator/analyze`, { source })
  expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
  const published = await postJson(origin, `/api/workspaces/${workspaceId}/plugin-generator/publish`, { source, draft: analyzed.body.draft })
  expect(published.status, JSON.stringify(published.body)).toBe(201)
  return {
    packageId: published.body.item.manifest.id as string,
    version: published.body.item.manifest.version as string,
  }
}

async function listMarket(origin: string, workspaceId: string | undefined): Promise<string[]> {
  const query = workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(workspaceId)}`
  const response = await getJson(origin, `/api/marketplace?market=plugin${query}`)
  expect(response.status).toBe(200)
  return (response.body.items as AnyRecord[]).map((item) => item.manifest.id as string)
}

async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-generator-isolation-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    pluginImportAnalyzer: staticAnalyzer(),
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

function staticAnalyzer() {
  return {
    async analyze(): Promise<PluginImportAnalyzeResult> {
      return {
        draft: {
          schemaVersion: 1,
          displayName: '每周复盘助手',
          summary: '把一周的会话和任务整理成可追溯的复盘要点。',
          transforms: [{
            id: 'weekly-review',
            trigger: '/weekly-review',
            description: '整理本周复盘要点。',
            instruction: '你是本周复盘助手。只依据当前会话和任务中的事实，按进展、阻碍、下周计划三段整理要点；没有证据的条目标记为待确认，不要替任何角色发言。',
            mode: 'prepend',
            priority: 50,
          }],
          sourceSummary: '来自用户提供的提示词配方。',
          sourceRefs: ['source:paste'],
        },
      }
    },
  }
}

async function postJson(origin: string, path: string, body: unknown): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}

async function getJson(origin: string, path: string): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`)
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}
