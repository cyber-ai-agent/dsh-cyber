import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createCyberServer, createLocalBackupBundle, restoreLocalBackupBundle, type CyberServer } from '../src/index.js'

/**
 * Character Generator output is workspace-private.
 *
 * These are catalog-authority tests, not presentation tests: the server must
 * refuse to list, preview, or install another workspace's generated talent even
 * when the caller names the package and its on-disk directory outright.
 */

type AnyRecord = Record<string, any>

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Character Generator workspace isolation', () => {
  it('hides a generated character from every workspace but its own', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })

    const generated = await publishCharacter(server.origin, alpha.id, '甲工作区角色')

    const alphaTalent = await listTalent(server.origin, alpha.id)
    expect(alphaTalent).toContain(generated.packageId)

    const betaTalent = await listTalent(server.origin, beta.id)
    expect(betaTalent).not.toContain(generated.packageId)

    // A catalog read that names no workspace must fail closed rather than fall
    // back to the shared view the defect used to expose.
    const unscopedTalent = await listTalent(server.origin, undefined)
    expect(unscopedTalent).not.toContain(generated.packageId)

    const betaPreview = await fetch(
      `${server.origin}/api/marketplace/packages/${encodeURIComponent(generated.packageId)}/${encodeURIComponent(generated.version)}/preview?workspaceId=${encodeURIComponent(beta.id)}`,
    )
    expect(betaPreview.status).toBe(404)
    const alphaPreview = await fetch(
      `${server.origin}/api/marketplace/packages/${encodeURIComponent(generated.packageId)}/${encodeURIComponent(generated.version)}/preview?workspaceId=${encodeURIComponent(alpha.id)}`,
    )
    expect(alphaPreview.status).toBe(200)
  })

  it('refuses to install another workspace generated character', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const generated = await publishCharacter(server.origin, alpha.id, '甲工作区角色')

    // The marketplace path: workspace B cannot even resolve the package.
    const betaMarketPreview = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/preview`, {
      packageId: generated.packageId,
      version: generated.version,
    })
    expect(betaMarketPreview.status).toBe(404)
    const betaMarketInstall = await postJson(server.origin, `/api/workspaces/${beta.id}/marketplace/install`, {
      packageId: generated.packageId,
      version: generated.version,
      approvalToken: 'unused',
    })
    expect(betaMarketInstall.status).toBe(404)

    // The direct path: workspace B knows the manifest and the real directory
    // and still must be refused, because the directory belongs to workspace A.
    const alphaPreview = await postJson(server.origin, `/api/workspaces/${alpha.id}/marketplace/preview`, {
      packageId: generated.packageId,
      version: generated.version,
    })
    expect(alphaPreview.status, JSON.stringify(alphaPreview.body)).toBe(200)
    const manifest = alphaPreview.body.item.manifest as AnyRecord
    const sourceDirectory = alphaPreview.body.item.sourceDirectory as string

    const betaApproval = await postJson(server.origin, `/api/workspaces/${beta.id}/packages/preview`, { manifest })
    expect(betaApproval.status, JSON.stringify(betaApproval.body)).toBe(200)
    const betaDirectInstall = await postJson(server.origin, `/api/workspaces/${beta.id}/packages/install`, {
      manifest,
      sourceDirectory,
      approvalToken: betaApproval.body.approvalToken,
    })
    expect(betaDirectInstall.status, JSON.stringify(betaDirectInstall.body)).toBe(404)
    expect(server.store.getActivePackage(beta.id, generated.packageId)).toBeUndefined()

    // The owning workspace is still able to install its own character.
    const alphaApproval = await postJson(server.origin, `/api/workspaces/${alpha.id}/packages/preview`, { manifest })
    const alphaInstall = await postJson(server.origin, `/api/workspaces/${alpha.id}/packages/install`, {
      manifest,
      sourceDirectory,
      approvalToken: alphaApproval.body.approvalToken,
    })
    expect(alphaInstall.status, JSON.stringify(alphaInstall.body)).toBe(201)
    expect(server.store.getActivePackage(alpha.id, generated.packageId)).toBeDefined()
  })

  it('keeps workspace ownership after a backup and restore round trip', async () => {
    const server = await startServer()
    const alpha = server.store.listWorkspaces()[0]!
    const beta = server.store.createWorkspace({ name: '工作区 B' })
    const generated = await publishCharacter(server.origin, alpha.id, '甲工作区角色')

    const bundle = await createLocalBackupBundle(server.root, server.store)
    await server.close()
    servers.splice(servers.indexOf(server), 1)

    const restoredRoot = await mkdtemp(join(tmpdir(), 'dsh-character-generator-restore-'))
    roots.push(restoredRoot)
    const restored = await restoreLocalBackupBundle(restoredRoot, bundle)
    expect(restored.included).toContain('workshop')

    const reopened = await startServer({ stateRoot: restoredRoot })
    expect(reopened.store.getWorkspace(alpha.id)).toBeDefined()
    expect(reopened.store.getWorkspace(beta.id)).toBeDefined()

    expect(await listTalent(reopened.origin, alpha.id)).toContain(generated.packageId)
    expect(await listTalent(reopened.origin, beta.id)).not.toContain(generated.packageId)

    const betaInstall = await postJson(reopened.origin, `/api/workspaces/${beta.id}/marketplace/install`, {
      packageId: generated.packageId,
      version: generated.version,
      approvalToken: 'unused',
    })
    expect(betaInstall.status).toBe(404)
  })
})

async function publishCharacter(
  origin: string,
  workspaceId: string,
  displayName: string,
): Promise<{ packageId: string; version: string }> {
  const source = { kind: 'paste' as const, text: `${displayName}：负责工作区内部的资料整理与核对。`.repeat(8) }
  const analyzed = await postJson(origin, `/api/workspaces/${workspaceId}/character-generator/analyze`, {
    source,
    targetWorldTemplateId: 'personal-world',
  })
  expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
  const published = await postJson(origin, `/api/workspaces/${workspaceId}/character-generator/publish`, {
    draft: { ...analyzed.body.draft, displayName },
    source,
    targetWorldTemplateId: 'personal-world',
  })
  expect(published.status, JSON.stringify(published.body)).toBe(201)
  const manifest = published.body.item.manifest as AnyRecord
  return { packageId: manifest.id as string, version: manifest.version as string }
}

async function listTalent(origin: string, workspaceId: string | undefined): Promise<string[]> {
  const query = workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(workspaceId)}`
  const response = await getJson(origin, `/api/marketplace?market=talent${query}`)
  expect(response.status).toBe(200)
  return (response.body.items as AnyRecord[]).map((item) => item.manifest.id as string)
}

async function startServer(options: { stateRoot?: string } = {}) {
  const root = options.stateRoot ?? await mkdtemp(join(tmpdir(), 'dsh-character-generator-isolation-'))
  if (options.stateRoot === undefined) roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    characterImportAnalyzer: staticAnalyzer(),
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

function staticAnalyzer(): unknown {
  const analyze = async () => ({
    draft: {
      schemaVersion: 1,
      targetWorldTemplateId: 'personal-world',
      displayName: '资料员',
      role: '资料整理员',
      summary: '负责工作区内部的资料整理与核对。',
      persona: '只依据当前工作区中可核对的资料回答，明确区分事实与推测。',
      requestedSkillIds: [],
      requestedCapabilities: [],
    },
  })
  return Object.assign(analyze, { analyze, generate: analyze })
}

async function postJson(origin: string, path: string, body: unknown): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}

async function getJson(origin: string, path: string): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`)
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}
