import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createCyberServer, type CyberServer } from '../src/index.js'

const roots: string[] = []
const servers: CyberServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('character avatar assets', () => {
  it('validates image/VRM assets and preserves explicit publish/rollback history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-assets-'))
    roots.push(root)
    const server = await createCyberServer({ stateRoot: root, workspacePath: process.cwd(), port: 0, bootstrapDefaultWorld: true })
    servers.push(server)
    const origin = (await server.start()).origin
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const employee = server.store.listEmployees(world.id)[0]!
    const initialProfileRevision = server.store.getEmployeeProfile(employee.id)?.revision ?? 0

    const image = await postJson<{ asset: { id: string }; avatarAsset: { rendererKind: string }; url: string }>(`${origin}/api/employees/${employee.id}/avatar-assets`, {
      name: 'portrait.png', mimeType: 'image/png', dataBase64: ONE_PIXEL_PNG,
    })
    expect(image.status).toBe(201)
    expect(image.body.avatarAsset.rendererKind).toBe('image-2d')
    expect((await fetch(`${origin}${image.body.url}`)).status).toBe(200)

    const publishedImage = await postJson<{ profile: { revision: number; appearance: Record<string, unknown> } }>(`${origin}/api/employees/${employee.id}/avatar-assets/${image.body.asset.id}/publish`, {
      fallbackAvatarIndex: 2, expectedProfileRevision: initialProfileRevision,
    })
    expect(publishedImage.status).toBe(201)
    expect(publishedImage.body.profile.revision).toBe(initialProfileRevision + 1)
    expect(publishedImage.body.profile.appearance.digitalHumanAvatar).toMatchObject({ rendererKind: 'image-2d', assetId: image.body.asset.id })

    const vrm = await postJson<{ asset: { id: string }; avatarAsset: { rendererKind: string; validation: Record<string, unknown> } }>(`${origin}/api/employees/${employee.id}/avatar-assets`, {
      name: 'employee.vrm', mimeType: 'model/gltf-binary', dataBase64: validGlb(true).toString('base64'),
    })
    expect(vrm.status).toBe(201)
    expect(vrm.body.avatarAsset).toMatchObject({ rendererKind: 'vrm-3d', validation: { specVersion: '1.0', visemeReady: true, interactiveAvatar: true } })

    const publishedVrm = await postJson<{ profile: { revision: number; appearance: Record<string, unknown> } }>(`${origin}/api/employees/${employee.id}/avatar-assets/${vrm.body.asset.id}/publish`, {
      fallbackAvatarIndex: 4, expectedProfileRevision: initialProfileRevision + 1,
    })
    expect(publishedVrm.status).toBe(201)
    expect(publishedVrm.body.profile.appearance.digitalHumanAvatar).toMatchObject({ rendererKind: 'vrm-3d', assetId: vrm.body.asset.id })

    const generic = await postJson<{ asset: { id: string }; avatarAsset: { rendererKind: string } }>(`${origin}/api/employees/${employee.id}/avatar-assets`, {
      name: 'mesh.glb', mimeType: 'model/gltf-binary', dataBase64: validGlb(false).toString('base64'),
    })
    expect(generic.status).toBe(201)
    expect(generic.body.avatarAsset.rendererKind).toBe('mesh-preview')
    expect((await postJson(`${origin}/api/employees/${employee.id}/avatar-assets/${generic.body.asset.id}/publish`, { fallbackAvatarIndex: 0, expectedProfileRevision: initialProfileRevision + 2 })).status).toBe(422)

    const rolledBack = await postJson<{ profile: { revision: number; appearance: Record<string, unknown> } }>(`${origin}/api/employees/${employee.id}/avatar-profile/rollback`, {
      targetRevision: initialProfileRevision + 1, expectedProfileRevision: initialProfileRevision + 2,
    })
    expect(rolledBack.status).toBe(201)
    expect(rolledBack.body.profile).toMatchObject({ revision: initialProfileRevision + 3, appearance: { digitalHumanAvatar: { rendererKind: 'image-2d', assetId: image.body.asset.id } } })
    const dossier = server.store.getEmployeeDossier(employee.id)
    expect(dossier.profileHistory?.slice(0, 3).map((profile) => profile.revision)).toEqual([initialProfileRevision + 3, initialProfileRevision + 2, initialProfileRevision + 1])

    const reset = await postJson<{ profile: { revision: number; appearance: Record<string, unknown> } }>(`${origin}/api/employees/${employee.id}/avatar-profile/reset`, {
      fallbackAvatarIndex: 6, expectedProfileRevision: initialProfileRevision + 3,
    })
    expect(reset.status).toBe(201)
    expect(reset.body.profile.appearance).not.toHaveProperty('digitalHumanAvatar')
  })
})

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as T }
}

function validGlb(vrm: boolean): Buffer {
  const boneNames = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand']
  const nodes = boneNames.map((name, index) => index === 0 ? { name, mesh: 0 } : { name })
  const document: Record<string, unknown> = {
    asset: { version: '2.0' }, scenes: [{ nodes: nodes.map((_, index) => index) }], scene: 0, nodes, meshes: [{ primitives: [] }],
  }
  if (vrm) {
    document.extensionsUsed = ['VRMC_vrm']
    document.extensions = { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Test', version: '1', authors: ['DSH'], licenseUrl: 'https://vrm.dev/licenses/1.0/' }, humanoid: { humanBones: Object.fromEntries(boneNames.map((name, index) => [name, { node: index }])) }, expressions: { preset: { aa: {}, ih: {}, ou: {}, ee: {}, oh: {} } }, lookAt: {} } }
  }
  const raw = Buffer.from(JSON.stringify(document), 'utf8')
  const padding = (4 - raw.length % 4) % 4
  const json = Buffer.concat([raw, Buffer.alloc(padding, 0x20)])
  const output = Buffer.alloc(20 + json.length)
  output.write('glTF', 0, 'ascii'); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8)
  output.writeUInt32LE(json.length, 12); output.writeUInt32LE(0x4e4f534a, 16); json.copy(output, 20)
  return output
}

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
