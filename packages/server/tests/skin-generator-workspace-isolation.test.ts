import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SkinImportAnalyzeResult } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

/**
 * Skin Generator output is workspace-private, exactly like Character and World
 * Generator output: a generated skin is listed, previewed, installable and
 * readable only by the workspace that published it. Cross-workspace leakage
 * was a P0 for the first generator; this pins the boundary for the third one
 * before any UI exists.
 */

type AnyRecord = Record<string, any>

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Skin Generator workspace isolation', () => {
  it('hides a generated skin from every workspace but its own', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const generated = await publishSkin(server.origin, alpha.id)

    expect(await listMarket(server.origin, alpha.id)).toContain(generated.packageId)
    expect(await listMarket(server.origin, beta.id)).not.toContain(generated.packageId)
    // No workspace named: fail closed.
    expect(await listMarket(server.origin, undefined)).not.toContain(generated.packageId)

    const betaPreview = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    expect(betaPreview.status).toBe(404)
    const alphaPreview = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    expect(alphaPreview.status, JSON.stringify(alphaPreview.body)).toBe(200)
  })

  it('refuses to install another workspace generated skin, through the market and directly', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const generated = await publishSkin(server.origin, alpha.id)

    const betaMarketInstall = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/install`, { packageId: generated.packageId, version: generated.version, approvalToken: 'unused' })
    expect(betaMarketInstall.status).toBe(404)

    // The direct path: B knows the manifest and the real directory and is still
    // refused. (Today the direct route's manifest validator does not admit
    // `kind: 'skin'` for anyone, so the refusal arrives as 422 before the
    // workspace check; the assertion is that nothing installs, whichever
    // guard answers first.)
    const alphaPreview = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/preview`, { packageId: generated.packageId, version: generated.version })
    expect(alphaPreview.status, JSON.stringify(alphaPreview.body)).toBe(200)
    const manifest = alphaPreview.body.item.manifest as AnyRecord
    const sourceDirectory = alphaPreview.body.item.sourceDirectory as string
    const betaApproval = await postJson(server.origin, `/api/workspaces/${beta.id}/packages/preview`, { manifest })
    const betaDirectInstall = await postJson(server.origin, `/api/workspaces/${beta.id}/packages/install`, { manifest, sourceDirectory, approvalToken: betaApproval.body.approvalToken ?? 'unused' })
    expect([404, 422]).toContain(betaDirectInstall.status)
    expect(server.store.getActivePackage(beta.id, generated.packageId)).toBeUndefined()
    // B's installed-skin declarations never mention A's palette.
    const betaSkins = await getJson(server.origin, `/api/workspaces/${beta.id}/skins`)
    expect(betaSkins.status).toBe(200)
    expect((betaSkins.body.items as AnyRecord[]).map((item) => item.packageId)).not.toContain(generated.packageId)

    // The owning workspace installs it through the ordinary skin install path
    // and reads its palette back.
    const alphaInstall = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/install`, { packageId: generated.packageId, version: generated.version, approvalToken: alphaPreview.body.preview.approvalToken })
    expect(alphaInstall.status, JSON.stringify(alphaInstall.body)).toBe(201)
    expect(alphaInstall.body.installed.kind).toBe('skin')
    const alphaSkins = await getJson(server.origin, `/api/workspaces/${alpha.id}/skins`)
    expect(alphaSkins.status).toBe(200)
    const declared = (alphaSkins.body.items as AnyRecord[]).find((item) => item.packageId === generated.packageId)
    expect(declared?.manifest.palette.accentColor).toBe('#5aa9e6')
  })
})

async function publishSkin(origin: string, workspaceId: string): Promise<{ packageId: string; version: string }> {
  const source = { kind: 'paste' as const, text: '一个安静的深夜图书馆：深蓝底色、暖黄阅读灯、木质书架的沉稳感。'.repeat(3) }
  const analyzed = await postJson(origin, `/api/workspaces/${workspaceId}/skin-generator/analyze`, { source })
  expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
  const published = await postJson(origin, `/api/workspaces/${workspaceId}/skin-generator/publish`, { source, draft: analyzed.body.draft })
  expect(published.status, JSON.stringify(published.body)).toBe(201)
  return {
    packageId: published.body.item.manifest.id as string,
    version: published.body.item.manifest.version as string,
  }
}

async function listMarket(origin: string, workspaceId: string | undefined): Promise<string[]> {
  const query = workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(workspaceId)}`
  const response = await getJson(origin, `/api/marketplace?market=skin${query}`)
  expect(response.status).toBe(200)
  return (response.body.items as AnyRecord[]).map((item) => item.manifest.id as string)
}

async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skin-generator-isolation-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    skinImportAnalyzer: staticAnalyzer(),
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

function staticAnalyzer() {
  return {
    async analyze(): Promise<SkinImportAnalyzeResult> {
      return {
        draft: {
          schemaVersion: 1,
          displayName: '深夜图书馆',
          summary: '深蓝底色配暖黄阅读灯的安静阅读氛围。',
          palette: {
            accentColor: '#5aa9e6',
            pageBackground: '#0b1220',
            panelBackground: '#121c2e',
            textColor: '#eef2f7',
            ownerBubbleColor: '#1f3352',
            characterBubbleColor: '#16233a',
            backdropOpacity: 0.9,
          },
          sourceSummary: '来自用户提供的皮肤描述。',
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
