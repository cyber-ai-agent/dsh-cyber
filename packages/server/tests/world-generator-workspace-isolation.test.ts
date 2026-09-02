import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorldImportAnalyzeResult } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

/**
 * World Generator output is workspace-private, exactly like Character
 * Generator output: a generated theme and its cast are listed, previewed and
 * installable only by the workspace that published them. Cross-workspace
 * leakage was a P0 for the first generator; this pins the boundary for the
 * second one before any UI exists.
 */

type AnyRecord = Record<string, any>

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('World Generator workspace isolation', () => {
  it('hides a generated theme and its cast from every workspace but its own', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const generated = await publishWorld(server.origin, alpha.id)

    expect(await listMarket(server.origin, 'theme', alpha.id)).toContain(generated.packageId)
    expect(await listMarket(server.origin, 'talent', alpha.id)).toContain(generated.castPackageId)

    expect(await listMarket(server.origin, 'theme', beta.id)).not.toContain(generated.packageId)
    expect(await listMarket(server.origin, 'talent', beta.id)).not.toContain(generated.castPackageId)
    // No workspace named: fail closed.
    expect(await listMarket(server.origin, 'theme', undefined)).not.toContain(generated.packageId)

    const betaPreview = await fetch(`${server.origin}/api/marketplace/packages/${encodeURIComponent(generated.packageId)}/${generated.version}/preview?workspaceId=${encodeURIComponent(beta.id)}`)
    expect(betaPreview.status).toBe(404)
    const alphaPreview = await fetch(`${server.origin}/api/marketplace/packages/${encodeURIComponent(generated.packageId)}/${generated.version}/preview?workspaceId=${encodeURIComponent(alpha.id)}`)
    expect(alphaPreview.status).toBe(200)
  })

  it('refuses to install or create a world from another workspace generated theme', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const generated = await publishWorld(server.origin, alpha.id)

    const betaMarketPreview = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    expect(betaMarketPreview.status).toBe(404)
    const betaMarketInstall = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/install`, { packageId: generated.packageId, version: generated.version, approvalToken: 'unused' })
    expect(betaMarketInstall.status).toBe(404)
    const betaWorld = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/worlds`, { packageId: generated.packageId, name: '偷来的世界' })
    expect(betaWorld.status).not.toBe(201)
    expect(server.store.listWorlds(beta.id).some((world) => world.name === '偷来的世界')).toBe(false)

    // The direct path: B knows the manifest and the real directory and is still refused.
    const alphaPreview = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    expect(alphaPreview.status, JSON.stringify(alphaPreview.body)).toBe(200)
    const manifest = alphaPreview.body.item.manifest as AnyRecord
    const sourceDirectory = alphaPreview.body.item.sourceDirectory as string
    const betaApproval = await postJson(server.origin, `/api/workspaces/${beta.id}/packages/preview`, { manifest })
    expect(betaApproval.status).toBe(200)
    const betaDirectInstall = await postJson(server.origin, `/api/workspaces/${beta.id}/packages/install`, { manifest, sourceDirectory, approvalToken: betaApproval.body.approvalToken })
    expect(betaDirectInstall.status, JSON.stringify(betaDirectInstall.body)).toBe(404)
    expect(server.store.getActivePackage(beta.id, generated.packageId)).toBeUndefined()

    // The owning workspace installs and creates a world from it.
    const alphaApproval = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    const alphaInstall = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/install`, { packageId: generated.packageId, version: generated.version, approvalToken: alphaApproval.body.preview.approvalToken })
    expect(alphaInstall.status, JSON.stringify(alphaInstall.body)).toBe(201)
    const alphaWorld = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/worlds`, { packageId: generated.packageId, name: '自己的世界' })
    expect(alphaWorld.status, JSON.stringify(alphaWorld.body)).toBe(201)
    expect(alphaWorld.body.world.workspaceId).toBe(alpha.id)
  })

  it('keeps an uploaded background private to the workspace that uploaded it', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const bytes = pngBytes(1536, 1024)
    const generated = await publishWorld(server.origin, alpha.id, { kind: 'upload', id: 'official-moonlit-tavern', fileName: 'backdrop.png', mimeType: 'image/png', dataBase64: bytes.toString('base64') })

    expect(await listMarket(server.origin, 'theme', beta.id)).not.toContain(generated.packageId)
    const previewPath = `/api/marketplace/packages/${encodeURIComponent(generated.packageId)}/${generated.version}/preview`
    const betaPreview = await fetch(`${server.origin}${previewPath}?workspaceId=${encodeURIComponent(beta.id)}`)
    expect(betaPreview.status).toBe(404)
    const unscopedPreview = await fetch(`${server.origin}${previewPath}`)
    expect(unscopedPreview.status).toBe(404)
    // The owning workspace sees exactly the bytes it uploaded.
    const alphaPreview = await fetch(`${server.origin}${previewPath}?workspaceId=${encodeURIComponent(alpha.id)}`)
    expect(alphaPreview.status).toBe(200)
    expect(Buffer.from(await alphaPreview.arrayBuffer()).equals(bytes)).toBe(true)

    // B cannot bind the theme to a world of its own, so the world asset route
    // never has a B world to serve the background through.
    const betaWorld = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/worlds`, { packageId: generated.packageId, name: '偷来的背景' })
    expect(betaWorld.status).not.toBe(201)
    expect(server.store.listWorlds(beta.id).some((world) => world.name === '偷来的背景')).toBe(false)
  })
})

function pngBytes(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([signature, ihdr, Buffer.alloc(64)])
}

async function publishWorld(origin: string, workspaceId: string, scene?: AnyRecord): Promise<{ packageId: string; version: string; castPackageId: string }> {
  const source = { kind: 'paste' as const, text: '一家社区法律援助诊所，律师、助理和志愿者分工推进来访者的问题梳理。'.repeat(4) }
  const analyzed = await postJson(origin, `/api/workspaces/${workspaceId}/world-generator/analyze`, { source })
  expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
  const published = await postJson(origin, `/api/workspaces/${workspaceId}/world-generator/publish`, { source, draft: analyzed.body.draft, ...(scene === undefined ? {} : { scene }) })
  expect(published.status, JSON.stringify(published.body)).toBe(201)
  return {
    packageId: published.body.item.manifest.id as string,
    version: published.body.item.manifest.version as string,
    castPackageId: published.body.cast[0].manifest.id as string,
  }
}

async function listMarket(origin: string, market: string, workspaceId: string | undefined): Promise<string[]> {
  const query = workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(workspaceId)}`
  const response = await getJson(origin, `/api/marketplace?market=${market}${query}`)
  expect(response.status).toBe(200)
  return (response.body.items as AnyRecord[]).map((item) => item.manifest.id as string)
}

async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-generator-isolation-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    worldImportAnalyzer: staticAnalyzer(),
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

function staticAnalyzer() {
  return {
    async analyze(): Promise<WorldImportAnalyzeResult> {
      return {
        draft: {
          schemaVersion: 1,
          targetWorldTemplateId: 'personal-world',
          displayName: '社区法律援助诊所',
          summary: '面向社区居民的小型法律援助诊所。',
          terminology: { world: '诊所', participant: '成员', session: '案情会', milestone: '办案记录' },
          workflow: ['来访登记', '问题梳理'],
          rules: ['只根据来访者提供的材料判断。'],
          cast: [{
            schemaVersion: 1,
            targetWorldTemplateId: 'personal-world',
            displayName: '值班律师',
            role: '法律评估',
            summary: '负责法律评估和最终建议。',
            persona: '只依据来访者提供的材料判断，时效问题当天标红。',
            personalityTraits: [],
            background: '',
            requestedSkillIds: [],
            requestedCapabilities: [],
            sourceSummary: '来自用户提供的世界资料。',
            sourceRefs: ['source:paste'],
          }],
          sourceSummary: '来自用户提供的世界资料。',
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
