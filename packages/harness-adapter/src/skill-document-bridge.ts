import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  parseSkillDocumentDescriptors, parseSkillDocumentReadRequest, parseSkillDocumentReadResult,
  SKILL_DOCUMENT_MAX_RESPONSE_BYTES,
  type AgentSkillDocuments, type SkillDocumentDescriptor,
} from '@dsh-cyber/contracts'

const ROUTE = '/skill-documents/read'
const MAX_REQUEST_BYTES = 4_096

/** Private RPC payload: never place this object in prompts, events, logs or environment variables. */
export interface SkillDocumentWorkerBinding {
  workspaceId: string
  worldId: string
  actorId: string
  sessionId: string
  skills: SkillDocumentDescriptor[]
  endpoint: string
  token: string
}
export interface SkillDocumentBridge {
  binding: SkillDocumentWorkerBinding
  close(): Promise<void>
}

/** One capability per active run; all content reads call the host's live authorization provider. */
export async function createSkillDocumentBridge(documents: AgentSkillDocuments, sessionId: string): Promise<SkillDocumentBridge> {
  const skills = parseSkillDocumentDescriptors(documents.skills)
  const revisions = new Map(skills.map((skill) => [skill.id, skill.revision]))
  let read: AgentSkillDocuments['read'] | undefined = documents.read.bind(documents)
  const token = randomBytes(32).toString('hex')
  let host = ''
  let closing: Promise<void> | undefined
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const code = error instanceof Error && ['skill_document_too_large', 'skill_document_not_text'].includes(error.message)
        ? error.message : 'skill_document_unavailable'
      reply(response, code === 'skill_document_unavailable' ? 403 : 422, { error: { code } })
    })
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.maxConnections = 32
  server.on('clientError', (_error, socket) => socket.destroy())

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    if (read === undefined || request.headers.host !== host || request.url !== ROUTE
      || request.method !== 'POST' || request.headers.origin !== undefined
      || request.headers['content-type'] !== 'application/json'
      || !matchesToken(request.headers.authorization, token)) {
      reply(response, 403, { error: '技能文档读取被拒绝。' })
      return
    }
    const parts: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_REQUEST_BYTES) {
        reply(response, 413, { error: '技能读取参数过长。' })
        return
      }
      parts.push(bytes)
    }
    const input = parseSkillDocumentReadRequest(JSON.parse(Buffer.concat(parts).toString('utf8')))
    const revision = revisions.get(input.skillId)
    const currentRead = read
    if (revision === undefined || currentRead === undefined) throw new Error('Unavailable')
    const result = parseSkillDocumentReadResult(await currentRead(input), input, revision)
    // Closing a run revokes even reads that were already waiting on the provider.
    if (read !== currentRead) throw new Error('Unavailable')
    const body = JSON.stringify(result)
    if (Buffer.byteLength(body) > SKILL_DOCUMENT_MAX_RESPONSE_BYTES) throw new Error('Oversized result')
    reply(response, 200, result)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    binding: {
      workspaceId: documents.workspaceId, worldId: documents.worldId, actorId: documents.actorId,
      sessionId, skills, endpoint: `http://${host}${ROUTE}`, token,
    },
    close() {
      read = undefined
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      return closing
    },
  }
}

function matchesToken(value: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`)
  const actual = Buffer.from(value ?? '')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}
