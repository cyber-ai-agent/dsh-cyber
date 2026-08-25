import type { IncomingMessage } from 'node:http'

import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { optionalString, readJson, record, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import { KnowledgeWebImportService } from '../services/knowledge-web-import-service.js'
import { WorldKnowledgeLibraryService } from '../services/world-knowledge-library-service.js'

const MAX_MULTIPART_BODY_BYTES = 204 * 1024 * 1024
const MAX_MULTIPART_FILES = 500

export interface WorldKnowledgeRoutesDependencies {
  store: Pick<SqliteStore, 'getWorld'>
  library: WorldKnowledgeLibraryService
  web?: KnowledgeWebImportService
  access?: WorldAccessService
}

export function registerWorldKnowledgeRoutes(router: Router, dependencies: WorldKnowledgeRoutesDependencies): void {
  const { store, library, web, access } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/knowledge$/, async ({ request, response, params }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    writeJson(response, 200, { collections: library.listCollections(world.id), documents: library.listDocuments(world.id) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/knowledge\/library$/, async ({ request, response, params, url }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    const collectionId = optionalString(url.searchParams.get('collectionId'))
    const status = optionalDocumentStatus(url.searchParams.get('status'))
    const query = optionalString(url.searchParams.get('query'))
    writeJson(response, 200, {
      collections: library.listCollections(world.id),
      documents: library.listDocuments(world.id, {
        ...(collectionId === undefined ? {} : { collectionId }),
        ...(status === undefined ? {} : { status }),
        ...(query === undefined ? {} : { query }),
      }),
    })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/knowledge\/search$/, async ({ request, response, params, url }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    const query = optionalString(url.searchParams.get('q')) ?? optionalString(url.searchParams.get('query'))
    if (query === undefined) throw new HttpError(422, 'knowledge_query_required', '查询文本不能为空')
    if (Array.from(query).length > 500) throw new HttpError(422, 'knowledge_query_too_long', '查询文本不能超过 500 个字符')
    const limit = parseLimit(url.searchParams.get('limit'))
    writeJson(response, 200, { results: await library.search(world.id, query, limit) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/knowledge\/library\/import$/, async ({ request, response, params }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    const contentType = request.headers['content-type'] ?? ''
    if (contentType.toLowerCase().startsWith('multipart/form-data')) {
      const form = await parseKnowledgeMultipart(request)
      const collectionName = optionalString(form.fields.collectionName)
      const documentOrigin = originFrom(form.fields.origin)
      const collectionOrigin = collectionOriginFrom(form.fields.origin)
      const relativePaths = parseRelativePaths(form.fields.relativePaths, form.files.length)
      if (form.files.length === 1 && isZip(form.files[0]!.fileName)) {
        const report = await dependencies.library.importZip({ workspaceId: world.workspaceId, worldId: world.id, bytes: form.files[0]!.bytes, ...(collectionName === undefined ? {} : { collectionName }) })
        writeJson(response, 201, report)
        return
      }
      const documents = []
      for (const [index, file] of form.files.entries()) {
        documents.push(await library.importFile({
          workspaceId: world.workspaceId,
          worldId: world.id,
          bytes: file.bytes,
          fileName: file.fileName,
          relativePath: relativePaths[index] ?? file.fileName,
          origin: documentOrigin,
          ...(collectionName === undefined ? {} : { collectionName }),
          collectionOrigin,
        }))
      }
      writeJson(response, 201, { documents })
      return
    }
    const body = await readJson(request)
    const fileName = requiredString(body, 'fileName')
    const dataBase64 = requiredString(body, 'dataBase64')
    const bytes = decodeBase64(dataBase64)
    const mimeType = optionalString(body.mimeType)
    const relativePath = optionalString(body.relativePath)
    const collectionId = optionalString(body.collectionId)
    const collectionName = optionalString(body.collectionName)
    if (isZip(fileName)) {
      const report = await library.importZip({
        workspaceId: world.workspaceId,
        worldId: world.id,
        bytes,
        ...(collectionName === undefined ? {} : { collectionName }),
      })
      writeJson(response, 201, report)
      return
    }
    const document = await library.importFile({
      workspaceId: world.workspaceId,
      worldId: world.id,
      bytes,
      fileName,
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(relativePath === undefined ? {} : { relativePath }),
      origin: originFrom(body.origin),
      ...(collectionId === undefined ? {} : { collectionId }),
      ...(collectionName === undefined ? {} : { collectionName }),
    })
    writeJson(response, 201, { document })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/knowledge\/library\/paste$/, async ({ request, response, params }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const text = requiredString(body, 'text')
    const title = requiredString(body, 'title')
    const relativePath = optionalString(body.relativePath)
    const collectionId = optionalString(body.collectionId)
    const collectionName = optionalString(body.collectionName)
    const document = await library.createFromText({
      workspaceId: world.workspaceId,
      worldId: world.id,
      title,
      text,
      ...(relativePath === undefined ? {} : { relativePath }),
      ...(collectionId === undefined ? {} : { collectionId }),
      ...(collectionName === undefined ? {} : { collectionName }),
      collectionOrigin: 'manual',
    })
    writeJson(response, 201, { document })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/knowledge\/library\/scan$/, async ({ request, response, params }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    writeJson(response, 200, await library.scan(world.id, world.workspaceId))
  })

  router.post(/^\/api\/worlds\/([^/]+)\/knowledge\/library\/web$/, async ({ request, response, params }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    if (web === undefined) throw new HttpError(503, 'knowledge_web_import_unavailable', '网页导入服务尚未配置')
    const body = await readJson(request)
    const collectionId = optionalString(body.collectionId)
    const collectionName = optionalString(body.collectionName)
    const title = optionalString(body.title)
    const document = await web.importUrl({
      workspaceId: world.workspaceId,
      worldId: world.id,
      url: requiredString(body, 'url'),
      ...(collectionId === undefined ? {} : { collectionId }),
      ...(collectionName === undefined ? {} : { collectionName }),
      ...(title === undefined ? {} : { title }),
    })
    writeJson(response, 201, { document })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/knowledge\/library\/artifact$/, async ({ request, response, params }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    const body = await readJson(request)
    const collectionId = optionalString(body.collectionId)
    const document = await library.importArtifact({
      workspaceId: world.workspaceId,
      worldId: world.id,
      artifactId: requiredString(body, 'artifactId'),
      ...(collectionId === undefined ? {} : { collectionId }),
    })
    writeJson(response, 201, { document })
  })

  router.delete(/^\/api\/worlds\/([^/]+)\/knowledge\/library\/documents\/([^/]+)$/, async ({ request, response, params }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    writeJson(response, 200, { removed: await library.removeDocument(world.id, params[1]!) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/knowledge\/library\/documents\/([^/]+)\/reindex$/, async ({ request, response, params }) => {
    const world = assertWorld(store, params[0]!)
    await access?.assertUnlocked(world.id, request)
    writeJson(response, 200, { document: await library.reindex(world.id, params[1]!) })
  })
}

function assertWorld(store: Pick<SqliteStore, 'getWorld'>, worldId: string) {
  const world = store.getWorld(worldId)
  if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
  return world
}

function originFrom(value: unknown): 'upload' | 'paste' | 'web' | 'filesystem' | 'artifact' {
  return value === 'paste' || value === 'web' || value === 'filesystem' || value === 'artifact' ? value : 'upload'
}

function collectionOriginFrom(value: unknown): 'folder' | 'zip' | 'manual' | 'web' | 'artifact' {
  return value === 'folder' || value === 'zip' || value === 'manual' || value === 'web' || value === 'artifact' ? value : 'manual'
}

function optionalDocumentStatus(value: string | null): 'pending' | 'indexed' | 'failed' | 'missing' | undefined {
  const status = optionalString(value)
  if (status === undefined) return undefined
  if (status === 'pending' || status === 'indexed' || status === 'failed' || status === 'missing') return status
  throw new HttpError(422, 'knowledge_status_invalid', '知识文档状态无效')
}

function parseLimit(value: string | null): number {
  if (value === null || value.trim() === '') return 6
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > 8) throw new HttpError(422, 'knowledge_limit_invalid', '检索数量必须在 1 到 8 之间')
  return number
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new HttpError(422, 'invalid_base64', '文件数据不是有效 Base64')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > MAX_MULTIPART_BODY_BYTES) throw new HttpError(413, 'knowledge_body_too_large', '知识导入请求过大')
  return bytes
}

interface KnowledgeMultipartFile { fileName: string; bytes: Buffer }
interface KnowledgeMultipartForm { fields: Record<string, string>; files: KnowledgeMultipartFile[] }

/** Minimal bounded multipart parser for the knowledge feature; it accepts files only, never executes them. */
export async function parseKnowledgeMultipart(request: IncomingMessage): Promise<KnowledgeMultipartForm> {
  const contentType = request.headers['content-type'] ?? ''
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (boundary === undefined || boundary.length > 120 || /[\r\n]/.test(boundary)) throw new HttpError(400, 'multipart_boundary_invalid', 'multipart boundary 无效')
  const length = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(length) && length > MAX_MULTIPART_BODY_BYTES) throw new HttpError(413, 'knowledge_body_too_large', '知识导入请求过大')
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.length
    if (total > MAX_MULTIPART_BODY_BYTES) throw new HttpError(413, 'knowledge_body_too_large', '知识导入请求过大')
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks)
  const marker = Buffer.from(`--${boundary}`)
  const files: KnowledgeMultipartFile[] = []
  const fields: Record<string, string> = {}
  let cursor = body.indexOf(marker)
  while (cursor >= 0 && files.length <= MAX_MULTIPART_FILES) {
    let partStart = cursor + marker.length
    if (body.subarray(partStart, partStart + 2).toString('ascii') === '--') break
    if (body.subarray(partStart, partStart + 2).toString('ascii') !== '\r\n') throw new HttpError(400, 'multipart_invalid', 'multipart part 分隔符无效')
    partStart += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart)
    if (headerEnd < 0) throw new HttpError(400, 'multipart_invalid', 'multipart headers 无效')
    const headers = parsePartHeaders(body.subarray(partStart, headerEnd).toString('latin1'))
    const contentStart = headerEnd + 4
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart)
    if (nextBoundary < 0) throw new HttpError(400, 'multipart_invalid', 'multipart 结束边界缺失')
    const content = body.subarray(contentStart, nextBoundary)
    const disposition = headers['content-disposition'] ?? ''
    const name = /(?:^|;)\s*name="([^"]+)"/i.exec(disposition)?.[1]
    if (name === undefined) throw new HttpError(400, 'multipart_invalid', 'multipart 字段缺少 name')
    const fileName = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1]
    if (fileName !== undefined && fileName !== '') {
      if (content.length > WORLD_KNOWLEDGE_MULTIPART_FILE_LIMIT) throw new HttpError(413, 'knowledge_file_too_large', '单个知识文件过大')
      files.push({ fileName: fileName.replaceAll('\\', '/').split('/').pop() ?? 'upload', bytes: Buffer.from(content) })
    } else {
      const value = content.toString('utf8')
      if (value.includes('\uFFFD') || value.length > 1_000_000) throw new HttpError(422, 'multipart_field_invalid', 'multipart 文本字段无效')
      fields[name] = value
    }
    cursor = nextBoundary + 2
  }
  if (files.length === 0) throw new HttpError(422, 'knowledge_file_required', '至少需要一个知识文件')
  if (files.length > MAX_MULTIPART_FILES) throw new HttpError(413, 'knowledge_file_count_rejected', '知识文件数量超过限制')
  return { fields, files }
}

const WORLD_KNOWLEDGE_MULTIPART_FILE_LIMIT = 50 * 1024 * 1024

function parsePartHeaders(value: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const line of value.split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    output[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  return output
}

function parseRelativePaths(value: string | undefined, count: number): Array<string | undefined> {
  if (value === undefined || value.trim() === '') return Array.from({ length: count }, () => undefined)
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((item) => item !== null && typeof item !== 'string')) throw new Error()
    return Array.from({ length: count }, (_, index) => typeof parsed[index] === 'string' ? parsed[index] : undefined)
  } catch { throw new HttpError(422, 'knowledge_relative_paths_invalid', 'relativePaths 必须是字符串数组') }
}

function isZip(fileName: string): boolean { return fileName.toLowerCase().endsWith('.zip') }
