/** Public discovery metadata only. Document bodies are fetched at the read boundary. */
export interface SkillDocumentDescriptor {
  id: string
  displayName: string
  summary: string
  revision: string
}

export interface SkillDocumentReadRequest {
  skillId: string
  path?: string
  offset?: number
  limit?: number
  /** Independent resource-name pagination, starting at zero. */
  resourceOffset?: number
}

export interface SkillDocumentReadResult {
  skillId: string
  revision: string
  path: string
  content: string
  totalChars: number
  nextOffset?: number
  resources: string[]
  totalResources?: number
  nextResourceOffset?: number
}

/** Host-owned, per-turn authority. Never serialize the callback or replace it with file discovery. */
export interface AgentSkillDocuments {
  workspaceId: string
  worldId: string
  actorId: string
  skills: SkillDocumentDescriptor[]
  /** Recheck live character, world, grants, installation and revision on EVERY read. */
  read(request: SkillDocumentReadRequest): Promise<SkillDocumentReadResult>
}

export const SKILL_DOCUMENT_DEFAULT_PAGE_CHARS = 6_000
export const SKILL_DOCUMENT_MAX_PAGE_CHARS = 12_000
export const SKILL_DOCUMENT_MAX_RESPONSE_BYTES = 512 * 1024

/** Reject absolute paths, traversal, platform aliases and encoded path tricks. */
export function parseSkillDocumentPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240
    || /[\\\u0000-\u001f\u007f:%?#]/u.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..' || part.trim() !== part)) {
    throw new TypeError('技能文档路径无效。')
  }
  return value
}

export function parseSkillDocumentReadRequest(value: unknown): Required<SkillDocumentReadRequest> {
  const input = record(value)
  if (Object.keys(input).some((key) => !['skillId', 'path', 'offset', 'limit', 'resourceOffset'].includes(key))) throw new TypeError('技能读取参数无效。')
  const offset = input.offset ?? 0
  const resourceOffset = input.resourceOffset ?? 0
  const limit = input.limit ?? SKILL_DOCUMENT_DEFAULT_PAGE_CHARS
  if (!Number.isSafeInteger(resourceOffset) || (resourceOffset as number) < 0
    || !Number.isSafeInteger(offset) || (offset as number) < 0
    || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > SKILL_DOCUMENT_MAX_PAGE_CHARS) {
    throw new TypeError('技能文档分页参数无效。')
  }
  return { skillId: text(input.skillId, 240), path: parseSkillDocumentPath(input.path ?? 'SKILL.md'), offset: offset as number, limit: limit as number, resourceOffset: resourceOffset as number }
}

/** Explicit projection prevents package bodies and other private fields entering discovery. */
export function parseSkillDocumentDescriptors(value: unknown): SkillDocumentDescriptor[] {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('技能目录数量无效。')
  const seen = new Set<string>()
  return value.map((raw) => {
    const item = record(raw)
    const id = text(item.id, 240)
    if (seen.has(id)) throw new TypeError('技能标识重复。')
    seen.add(id)
    return { id, displayName: text(item.displayName, 240), summary: text(item.summary, 2_000, true), revision: text(item.revision, 160) }
  })
}

/** Validate and project bounded text pages across the host/worker trust boundary. */
export function parseSkillDocumentReadResult(value: unknown, request: Required<SkillDocumentReadRequest>, revision: string): SkillDocumentReadResult {
  const result = record(value)
  const path = parseSkillDocumentPath(result.path)
  if (result.skillId !== request.skillId || result.revision !== revision || path !== request.path
    || typeof result.content !== 'string' || result.content.length > request.limit
    || !Number.isSafeInteger(result.totalChars) || (result.totalChars as number) < 0
    || request.offset + result.content.length > Math.max(request.offset, result.totalChars as number)) {
    throw new TypeError('技能文档响应无效。')
  }
  const next = request.offset + result.content.length
  const hasMore = next < (result.totalChars as number)
  if ((hasMore && (result.content.length === 0 || result.nextOffset !== next))
    || (!hasMore && result.nextOffset !== undefined)) throw new TypeError('技能文档分页响应无效。')
  if (!Array.isArray(result.resources) || result.resources.length > 256) throw new TypeError('技能文档资源列表无效。')
  const resources = result.resources.map(parseSkillDocumentPath)
  const totalResources = result.totalResources ?? resources.length
  const resourceEnd = request.resourceOffset + resources.length
  if (new Set(resources).size !== resources.length || !Number.isSafeInteger(totalResources) || (totalResources as number) < 0 || (totalResources as number) > 256
    || resourceEnd > Math.max(request.resourceOffset, totalResources as number)
    || (resourceEnd < (totalResources as number) && (resources.length === 0 || result.nextResourceOffset !== resourceEnd))
    || (resourceEnd >= (totalResources as number) && result.nextResourceOffset !== undefined)) throw new TypeError('技能资源分页响应无效。')
  return {
    skillId: request.skillId, revision, path, content: result.content,
    totalChars: result.totalChars as number,
    ...(hasMore ? { nextOffset: next } : {}),
    resources, totalResources: totalResources as number,
    ...(resourceEnd < (totalResources as number) ? { nextResourceOffset: resourceEnd } : {}),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('技能文档数据无效。')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value))) || value.length > max) throw new TypeError('技能文档字段无效。')
  return value
}
