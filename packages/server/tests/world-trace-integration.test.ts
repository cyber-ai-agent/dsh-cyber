import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, WorldTracePage } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

class TraceRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    const sourceSessionId = `runtime-${request.agent.id}`
    request.onEvent?.({ kind: 'turn.started', source: 'trace-test', sourceSessionId, sourceSequence: 1, metadata: {} })
    request.onEvent?.({ kind: 'assistant.reasoning', source: 'trace-test', sourceSessionId, sourceSequence: 2, content: '只保留提供方给出的摘要', metadata: {} })
    request.onEvent?.({ kind: 'tool.started', source: 'trace-test', sourceSessionId, sourceSequence: 3, toolName: 'sk-1234567890123456', callId: 'call-1', metadata: {} })
    request.onEvent?.({ kind: 'tool.completed', source: 'trace-test', sourceSessionId, sourceSequence: 4, toolName: 'sk-1234567890123456', callId: 'call-1', failed: false, metadata: {} })
    request.onEvent?.({ kind: 'assistant.message', source: 'trace-test', sourceSessionId, sourceSequence: 5, content: '最终回答', metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'trace-test', sourceSessionId, sourceSequence: 6, metadata: {} })
    return { agentSessionId: sourceSessionId, finalResponse: '最终回答', eventCount: 6 }
  }
  async close(): Promise<void> {}
}

async function start(stateRoot: string) {
  const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, runtime: new TraceRuntime() })
  servers.push(server)
  return { server, origin: (await server.start()).origin }
}

async function json(origin: string, path: string, init?: RequestInit) {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() as any }
}

describe('World Trace HTTP and live recovery', () => {
  it('streams live entries, restores durable history after reconnect and restart, and never leaks runtime secrets', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-trace-http-'))
    const first = await start(stateRoot)
    const workspace = (await json(first.origin, '/api/workspaces', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '轨迹工作区' }),
    })).body.workspace
    const world = (await json(first.origin, `/api/workspaces/${workspace.id}/worlds`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '轨迹世界', templateId: 'cyber-company' }),
    })).body.world
    const employee = (await json(first.origin, `/api/worlds/${world.id}/recruit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blueprintId: 'cyber-company.archivist', blueprintVersion: 1 }),
    })).body.employee

    const stream = openTraceStream(first.origin, world.id)
    await stream.ready
    const chat = await json(first.origin, `/api/worlds/${world.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeIds: [employee.id], prompt: '完整用户提示不应出现在轨迹中' }),
    })
    const interactionLogs = first.server.store.listModelInteractions(workspace.id, { page: 1, pageSize: 10 })
    expect(chat.response.status, JSON.stringify({ body: chat.body, logs: interactionLogs.items })).toBe(200)
    await stream.waitFor(6)
    const live = await stream.waitForMatch((entry) => entry.category === 'task' && entry.status === 'success')
    stream.close()
    expect(live.some((entry) => entry.category === 'tool' && entry.status === 'success')).toBe(true)
    expect(live.some((entry) => entry.category === 'task' && entry.status === 'success')).toBe(true)
    expect(live.some((entry) => entry.category === 'task' && entry.status === 'pending')).toBe(true)
    expect(JSON.stringify(live)).not.toContain('sk-1234567890123456')

    const historyResponse = await json(first.origin, `/api/worlds/${world.id}/trace?limit=200`)
    expect(historyResponse.response.status).toBe(200)
    const history = historyResponse.body as WorldTracePage
    expect(JSON.stringify(history)).not.toContain('完整用户提示')
    expect(JSON.stringify(history)).not.toContain('sk-1234567890123456')
    const liveTurn = live.find((entry) => entry.summary.includes('本轮处理') && entry.status === 'success')
    const durableTurn = history.items.find((entry) => entry.summary.includes('本轮处理'))
    expect(liveTurn?.id).toBe(durableTurn?.id)
    expect(history.items.filter((entry) => entry.id === durableTurn?.id)).toHaveLength(1)
    const filtered = await json(first.origin, `/api/worlds/${world.id}/trace?category=tool&status=success&actorId=${employee.id}&limit=10`)
    expect(filtered.response.status).toBe(200)
    expect((filtered.body as WorldTracePage).items.every((entry) => entry.category === 'tool' && entry.status === 'success' && entry.actorId === employee.id)).toBe(true)
    expect((await json(first.origin, `/api/worlds/${world.id}/trace?after=not-a-cursor`)).response.status).toBe(422)

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)
    const restarted = await start(stateRoot)
    const restored = (await json(restarted.origin, `/api/worlds/${world.id}/trace?limit=200`)).body as WorldTracePage
    expect(restored.items.map((entry) => entry.id)).toContain(durableTurn?.id)
  })
})

function openTraceStream(origin: string, worldId: string) {
  const target = new URL(origin)
  const entries: any[] = []
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise })
  let buffer = ''
  const waiters: Array<{ count: number; resolve(value: any[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> = []
  const request = httpRequest({ hostname: target.hostname, port: Number(target.port), path: `/api/worlds/${worldId}/live`, headers: { Host: target.host } }, (response) => {
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      buffer += chunk.replaceAll('\r\n', '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = /^event:\s*(.+)$/m.exec(block)?.[1]
        const data = /^data:\s*(.+)$/m.exec(block)?.[1]
        if (event === 'ready') resolveReady()
        if (event === 'trace' && data !== undefined) entries.push(JSON.parse(data))
        for (const waiter of [...waiters]) {
          if (entries.length < waiter.count) continue
          clearTimeout(waiter.timer)
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve([...entries])
        }
        boundary = buffer.indexOf('\n\n')
      }
    })
  })
  request.once('error', (error) => { rejectReady(error); for (const waiter of waiters) waiter.reject(error) })
  request.end()
  return {
    ready,
    waitFor(count: number) {
      if (entries.length >= count) return Promise.resolve([...entries])
      return new Promise<any[]>((resolvePromise, rejectPromise) => {
        const waiter = {
          count,
          resolve: resolvePromise,
          reject: rejectPromise,
          timer: setTimeout(() => rejectPromise(new Error(`仅收到 ${entries.length} 条实时轨迹`)), 2_000),
        }
        waiters.push(waiter)
      })
    },
    async waitForMatch(predicate: (entry: any) => boolean) {
      const deadline = Date.now() + 2_000
      while (!entries.some(predicate)) {
        if (Date.now() >= deadline) throw new Error('未收到匹配的实时轨迹')
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      }
      return [...entries]
    },
    close() { request.destroy() },
  }
}
