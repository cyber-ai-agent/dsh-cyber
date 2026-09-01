import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort } from '@dsh-cyber/contracts'
import { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import { createCyberServer, type CyberServer } from '../src/index.js'
import { characterGeneratorMarketplaceRoot } from '../src/services/character-generator-marketplace.js'

type AnyRecord = Record<string, any>

const servers: CyberServer[] = []
const roots: string[] = []

// A 1x1 opaque PNG. Only the signature is inspected by the avatar boundary,
// but keeping a real image here means the bytes that come back out of
// /api/assets can be compared with the bytes that went in.
const UPLOADED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Character Generator 2D avatar closure', () => {
  it('carries an uploaded image all the way to the recruited character appearance', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!

    const blueprint = await publishInstallAndReadBlueprint(server, workspace.id, world.id, {
      displayName: '上传头像角色',
      avatar: {
        kind: 'upload',
        fileName: 'portrait.png',
        mimeType: 'image/png',
        dataBase64: UPLOADED_PNG_BASE64,
      },
    })

    const recruited = await postJson(server.origin, `/api/worlds/${world.id}/recruit`, {
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      displayName: '上传头像角色实例',
      skillGrants: [],
    })
    expect(recruited.status, JSON.stringify(recruited.body)).toBe(201)
    const employeeId = (recruited.body.employee as AnyRecord).id as string

    // The recruited character must own the uploaded image, not merely a
    // marketplace preview that disappears once the card is closed.
    const profile = server.store.getEmployeeProfile(employeeId)
    expect(profile, 'recruited character has no profile').toBeDefined()
    const digitalHumanAvatar = profile!.appearance.digitalHumanAvatar as AnyRecord | undefined
    expect(digitalHumanAvatar, `appearance was ${JSON.stringify(profile!.appearance)}`).toBeDefined()
    expect(digitalHumanAvatar!.rendererKind).toBe('image-2d')
    expect(digitalHumanAvatar!.identityId).toBe(employeeId)
    expect(typeof digitalHumanAvatar!.assetId).toBe('string')

    // The asset has to be scoped to this character, otherwise the profile
    // route would reject it on the next edit.
    const avatarAsset = server.store.getCharacterAvatarAsset(digitalHumanAvatar!.assetId as string)
    expect(avatarAsset?.employeeId).toBe(employeeId)

    // And the bytes the browser would render must be the uploaded bytes.
    const assetResponse = await fetch(`${server.origin}/api/assets/${encodeURIComponent(digitalHumanAvatar!.assetId as string)}`)
    expect(assetResponse.status).toBe(200)
    const served = Buffer.from(await assetResponse.arrayBuffer())
    expect(served.equals(Buffer.from(UPLOADED_PNG_BASE64, 'base64'))).toBe(true)
  })

  it('keeps one stable built-in avatar when nothing is uploaded', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!

    const blueprint = await publishInstallAndReadBlueprint(server, workspace.id, world.id, {
      displayName: '默认头像角色',
    })

    // The choice is made once, when the talent package is compiled.
    expect(Number.isInteger(blueprint.fallbackAvatarIndex), `blueprint was ${JSON.stringify(blueprint)}`).toBe(true)
    expect(blueprint.fallbackAvatarIndex).toBeGreaterThanOrEqual(0)
    expect(blueprint.fallbackAvatarIndex).toBeLessThanOrEqual(7)

    const recruited = await postJson(server.origin, `/api/worlds/${world.id}/recruit`, {
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      displayName: '默认头像角色实例',
      skillGrants: [],
    })
    expect(recruited.status, JSON.stringify(recruited.body)).toBe(201)
    const employeeId = (recruited.body.employee as AnyRecord).id as string

    // Recruiting seeds the same index as durable initial appearance data, so
    // nothing re-rolls it on the next render or page reload.
    const profile = server.store.getEmployeeProfile(employeeId)
    expect(profile!.appearance.avatarIndex, `appearance was ${JSON.stringify(profile!.appearance)}`)
      .toBe(blueprint.fallbackAvatarIndex)
    expect(profile!.appearance.digitalHumanAvatar).toBeUndefined()

    // A reload reads the same durable record.
    const dossier = await getJson(server.origin, `/api/employees/${employeeId}/dossier`)
    expect(dossier.status).toBe(200)
    expect((dossier.body.profile as AnyRecord).appearance.avatarIndex).toBe(blueprint.fallbackAvatarIndex)

    // Recruiting the same talent twice must not drift.
    const second = await postJson(server.origin, `/api/worlds/${world.id}/recruit`, {
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      displayName: '默认头像角色实例乙',
      skillGrants: [],
    })
    expect(second.status).toBe(201)
    expect(server.store.getEmployeeProfile((second.body.employee as AnyRecord).id as string)!.appearance.avatarIndex)
      .toBe(blueprint.fallbackAvatarIndex)
  })
})

async function publishInstallAndReadBlueprint(
  server: Awaited<ReturnType<typeof startServer>>,
  workspaceId: string,
  worldId: string,
  input: { displayName: string; avatar?: AnyRecord },
): Promise<AnyRecord> {
  const source = { kind: 'paste' as const, text: `${input.displayName} 是一名负责端到端交付的工程角色。` }
  const analyzed = await postJson(server.origin, `/api/workspaces/${workspaceId}/character-generator/analyze`, {
    source,
    targetWorldTemplateId: 'personal-world',
  })
  expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)

  const published = await postJson(server.origin, `/api/workspaces/${workspaceId}/character-generator/publish`, {
    draft: { ...(analyzed.body.draft as AnyRecord), displayName: input.displayName },
    source,
    targetWorldTemplateId: 'personal-world',
    ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
  })
  expect(published.status, JSON.stringify(published.body)).toBe(201)
  const packageId = (published.body.item as AnyRecord).manifest.id as string

  // Generated talent is workspace-scoped on disk; ask the service for the root
  // rather than restating the layout here.
  const generatedRoot = characterGeneratorMarketplaceRoot(server.root, workspaceId)
  const generated = (await new LocalPackageCatalog(generatedRoot).list({ market: 'talent' }))
    .find((item) => item.manifest.id === packageId)!
  expect(generated).toBeDefined()

  const preview = server.packageManager.preview(workspaceId, generated.manifest)
  const installed = await postJson(server.origin, `/api/workspaces/${workspaceId}/packages/install`, {
    manifest: generated.manifest,
    sourceDirectory: generated.sourceDirectory,
    approvalToken: preview.approvalToken,
    worldId,
  })
  expect(installed.status, JSON.stringify(installed.body)).toBe(201)

  const catalog = await getJson(server.origin, `/api/catalog/blueprints?worldId=${encodeURIComponent(worldId)}`)
  expect(catalog.status).toBe(200)
  const blueprint = (catalog.body.items as AnyRecord[]).find((item) => item.id === packageId)
  expect(blueprint, `installed blueprint ${packageId} is not in the world catalog`).toBeDefined()
  return blueprint!
}

async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-character-avatar-closure-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: new SilentRuntime(),
    characterImportAnalyzer: {
      async analyze() {
        return {
          draft: {
            schemaVersion: 1,
            targetWorldTemplateId: 'personal-world',
            displayName: '交付工程师',
            role: '交付工程师',
            summary: '负责端到端交付。',
            persona: '只依据当前世界中可验证的事实工作。',
            personalityTraits: [],
            background: '',
            requestedSkillIds: [],
            requestedCapabilities: [],
            sourceSummary: '来自粘贴文本。',
            sourceRefs: ['source:paste'],
          },
        }
      },
    },
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

class SilentRuntime implements AgentRuntimePort {
  async runTurn(request: AnyRecord) {
    return { agentSessionId: `avatar-closure-${request.agent.id}`, finalResponse: '好的。', eventCount: 0 }
  }

  async close() {}
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
