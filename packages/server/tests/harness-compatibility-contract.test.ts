import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class RecordingRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    return {
      agentSessionId: `runtime-${request.agent.id}`,
      finalResponse: '已收到图片附件',
      eventCount: 0,
    }
  }

  async close() {}
}

async function start() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-harness-compat-server-'))
  roots.push(stateRoot)
  const runtime = new RecordingRuntime()
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime,
    bootstrapDefaultWorld: true,
  })
  servers.push(server)
  const address = await server.start()
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  return { origin: address.origin, server, runtime, world, employee }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for image conversation')
}

describe('Harness compatibility server contracts', () => {
  it('keeps a verified image attachment in direct and queued turns without sending raw bytes to the runtime', async () => {
    const { origin, server, runtime, world, employee } = await start()
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const uploaded = await json(origin, `/api/worlds/${world.id}/assets/attachment`, post({
      name: 'diagram.png',
      mimeType: 'image/png',
      dataBase64: pngBase64,
    }))
    expect(uploaded.response.status).toBe(201)
    const attachment = uploaded.body.attachment as {
      assetId: string
      name: string
      mimeType: string
      byteLength: number
      url: string
    }
    expect(attachment).toMatchObject({ name: 'diagram.png', mimeType: 'image/png' })
    expect(attachment.byteLength).toBeGreaterThan(0)

    const direct = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: [employee.id],
      prompt: '请查看这张图并说明已收到',
      attachments: [attachment],
    }))
    expect(direct.response.status).toBe(200)
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]!.prompt).toContain(`${attachment.assetId}`)
    expect(runtime.calls[0]!.prompt).toContain('image/png')
    expect(JSON.stringify(runtime.calls[0]!.prompt)).not.toContain(pngBase64)

    const directMessage = server.store.listMessages(direct.body.session.id)
      .find((message) => message.kind === 'user')
    expect(directMessage?.metadata.attachments).toEqual([
      expect.objectContaining({
        assetId: attachment.assetId,
        name: 'diagram.png',
        mimeType: 'image/png',
        byteLength: attachment.byteLength,
      }),
    ])

    const queued = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: [employee.id],
      prompt: '排队后再次确认这张图',
      attachments: [attachment],
      queueMode: 'normal',
      clientTurnId: 'queued-image-contract',
    }))
    expect(queued.response.status).toBe(202)
    await waitFor(() => server.store.getWorkTurn(queued.body.workTurnId)?.status === 'completed')
    expect(runtime.calls).toHaveLength(2)
    expect(runtime.calls[1]!.prompt).toContain(`${attachment.assetId}`)
    expect(runtime.calls[1]!.prompt).toContain('image/png')
    expect(server.store.getConversationQueueEntry(queued.body.queueItem.id)).toMatchObject({
      status: 'completed',
      workTurnId: queued.body.workTurnId,
    })
    const queuedMessage = server.store.listMessages(queued.body.session.id)
      .findLast((message) => message.kind === 'user' && message.metadata.workTurnId === queued.body.workTurnId)
    expect(queuedMessage?.metadata.attachments).toEqual([
      expect.objectContaining({ assetId: attachment.assetId, mimeType: 'image/png' }),
    ])
  })
})
