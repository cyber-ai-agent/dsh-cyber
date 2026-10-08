import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  parseSkillDocumentDescriptors, parseSkillDocumentReadRequest, parseSkillDocumentReadResult,
  SKILL_DOCUMENT_MAX_RESPONSE_BYTES,
  type SkillDocumentDescriptor, type SkillDocumentReadRequest, type SkillDocumentReadResult,
} from '@dsh-cyber/contracts'

interface Binding {
  workspaceId: string
  worldId: string
  actorId: string
  sessionId: string
  endpoint: string
  token: string
  skills: SkillDocumentDescriptor[]
  abort: AbortController
  agents: Set<NonNullable<ToolRunContext['agent']>>
}

/** Host-bound document access, without discovery, filesystem reads or script execution. */
export class SkillDocumentTools {
  #binding: Binding | undefined
  #identity: Pick<Binding, 'workspaceId' | 'worldId' | 'actorId'> | undefined
  #installed = false

  constructor(private readonly ctx: Context, private readonly fetchImpl: typeof fetch = globalThis.fetch) {
    ctx.on('agent/created', ({ agent }) => {
      const binding = this.#binding
      if (!binding || binding.agents.size >= 1024 || ctx.agents.get(agent.id) !== agent) return
      if (agent.session.id === binding.sessionId || [...binding.agents].some((owner) => ctx.agents.get(owner.id) === owner && ctx.agents.isOwnedBy(agent.id, owner))) {
        binding.agents.add(agent)
      }
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { this.#binding?.agents.delete(agent) }, { global: true })
  }

  update(value: unknown): { totalSkills: number } {
    const input = object(value)
    if (input.binding === null) {
      this.clear()
      return { totalSkills: 0 }
    }
    const binding: Binding = {
      workspaceId: text(input.workspaceId), worldId: text(input.worldId), actorId: text(input.actorId),
      sessionId: text(input.sessionId), endpoint: endpoint(input.endpoint), token: token(input.token),
      skills: parseSkillDocumentDescriptors(input.skills), abort: new AbortController(), agents: new Set(),
    }
    const identity = this.#identity
    if (identity && (identity.workspaceId !== binding.workspaceId || identity.worldId !== binding.worldId || identity.actorId !== binding.actorId)) {
      throw new Error('技能文档不能切换到另一个角色或世界。')
    }
    this.clear()
    this.#binding = binding
    const root = this.ctx.agents.list().find((agent) => agent.session.id === binding.sessionId)
    if (root) binding.agents.add(root)
    this.#identity ??= { workspaceId: binding.workspaceId, worldId: binding.worldId, actorId: binding.actorId }
    if (!this.#installed) { this.#install(); this.#installed = true }
    return { totalSkills: binding.skills.length }
  }

  clear(): void {
    this.#binding?.abort.abort()
    this.#binding = undefined
  }

  #current(exec: ToolRunContext): Binding {
    const binding = this.#binding
    if (!binding || !exec.agent || !binding.agents.has(exec.agent) || this.ctx.agents.get(exec.agent.id) !== exec.agent || exec.signal.aborted) {
      throw new Error('本轮未提供可读取的技能文档。')
    }
    return binding
  }

  #install(): void {
    const output = {
      schema: { type: 'json' } as const,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    }
    const definitions = [
      defineTool({
        name: 'skills_list',
        description: '列出宿主为当前角色本轮提供的技能说明摘要。只有摘要；读取正文须调用 skills_read，读取时重新核验授权。',
        parameters: {
          offset: { type: 'integer', description: '从 0 开始；使用返回的 nextOffset 继续读取目录。' },
          limit: { type: 'integer', description: '每页最多 1–40 项，默认 20；输出预算可能缩短本页。' },
        }, output, isConcurrencySafe: () => true,
        execute: async (args, exec) => JSON.parse(JSON.stringify(listPage(this.#current(exec).skills, args))),
      }),
      defineTool({
        name: 'skills_read',
        description: '按需只读当前角色已获授权的技能说明或文本资源。默认 SKILL.md；不执行脚本，也不授予任何动作权限。使用返回的 nextOffset 继续分页。',
        parameters: {
          skillId: { type: 'string', required: true, description: 'skills_list 返回的稳定技能标识。' },
          path: { type: 'string', description: '默认 SKILL.md，或返回的 resources 中的相对文本路径。' },
          offset: { type: 'integer', description: '从 0 开始的字符偏移，下一页使用 nextOffset。' },
          limit: { type: 'integer', description: '每页最多 1–12000 字符，默认 6000；输出预算可能缩短本页，必须使用 nextOffset。' },
          resourceOffset: { type: 'integer', description: '资源名称分页，默认 0；使用 nextResourceOffset 继续列出资源。' },
        }, output, isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const binding = this.#current(exec)
          const request = parseSkillDocumentReadRequest(args)
          const descriptor = binding.skills.find((skill) => skill.id === request.skillId)
          if (!descriptor) throw new Error('当前角色未获授权读取此技能。')
          let failureMessage = '技能文档不可用或授权已失效，请重新确认当前技能授权。'
          try {
            const response = await this.fetchImpl(binding.endpoint, {
              method: 'POST', redirect: 'error',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.token}` },
              body: JSON.stringify(request),
              signal: AbortSignal.any([exec.signal, binding.abort.signal, AbortSignal.timeout(10_000)]),
            })
            if (!response.ok) {
              const payload = await boundedJson(response) as { error?: { code?: unknown } }
              if (payload?.error?.code === 'skill_document_too_large') failureMessage = '此技能资源超过可读取的大小上限。'
              if (payload?.error?.code === 'skill_document_not_text') failureMessage = '此技能资源不是可读取的纯文本；不会执行脚本或加载二进制文件。'
              throw new Error('Denied')
            }
            const result = parseSkillDocumentReadResult(await boundedJson(response), request, descriptor.revision)
            if (binding !== this.#binding || binding.abort.signal.aborted || exec.signal.aborted) throw new Error('Expired')
            return JSON.parse(JSON.stringify(readPage(result, request)))
          } catch {
            // Network exceptions may contain the private endpoint. Provider
            // errors may contain physical paths. Neither belongs in model output.
            throw new Error(failureMessage)
          }
        },
      }),
    ]
    this.ctx.effect(() => {
      const disposers = definitions.map((definition) => this.ctx.tools.register(definition))
      return () => { this.clear(); for (const dispose of disposers) dispose() }
    }, 'skill-documents.tools')
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > SKILL_DOCUMENT_MAX_RESPONSE_BYTES) throw new Error('Oversized')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > SKILL_DOCUMENT_MAX_RESPONSE_BYTES) throw new Error('Oversized')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => undefined) }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('技能文档绑定无效。')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) throw new TypeError('技能文档绑定无效。')
  return value
}
function endpoint(value: unknown): string {
  const raw = text(value)
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port
    || parsed.pathname !== '/skill-documents/read' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('技能文档绑定无效。')
  }
  return parsed.href
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError('技能文档绑定无效。')
  return value
}

/** Safely below this profile's 4096-code-point eager pruning threshold. */
export const SKILL_TOOL_RESULT_MAX_CHARS = 3_900

function readPage(result: SkillDocumentReadResult, request: Required<SkillDocumentReadRequest>): SkillDocumentReadResult {
  const totalResources = result.totalResources ?? result.resources.length
  const make = (characters: number, resourceCount: number): SkillDocumentReadResult => {
    const content = safePrefix(result.content, characters)
    const nextOffset = request.offset + content.length
    const nextResourceOffset = request.resourceOffset + resourceCount
    return {
      skillId: result.skillId, revision: result.revision, path: result.path,
      content, totalChars: result.totalChars,
      ...(nextOffset < result.totalChars ? { nextOffset } : {}),
      resources: result.resources.slice(0, resourceCount), totalResources,
      ...(nextResourceOffset < totalResources ? { nextResourceOffset } : {}),
    }
  }
  // Preserve independently reachable resource names without allowing their
  // metadata to consume the entire budget needed for document progress.
  let resources = 0
  const resourceBudget = result.content.length > 0 ? SKILL_TOOL_RESULT_MAX_CHARS / 2 : SKILL_TOOL_RESULT_MAX_CHARS
  while (resources < result.resources.length && JSON.stringify(make(0, resources + 1)).length <= resourceBudget) resources += 1
  if (resources === 0 && result.resources.length > 0) resources = 1
  let low = 0
  let high = result.content.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (JSON.stringify(make(middle, resources)).length <= SKILL_TOOL_RESULT_MAX_CHARS) low = middle
    else high = middle - 1
  }
  const page = make(low, resources)
  if (JSON.stringify(page).length > SKILL_TOOL_RESULT_MAX_CHARS || (result.content.length > 0 && page.content.length === 0)) throw new Error('技能文档元数据超过分页预算。')
  return page
}

function listPage(skills: SkillDocumentDescriptor[], args: { offset?: number; limit?: number }): unknown {
  const offset = args.offset ?? 0
  const limit = args.limit ?? 20
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 40) throw new TypeError('技能目录分页参数无效。')
  const page: Array<SkillDocumentDescriptor & { summaryTruncated?: true }> = []
  const result = () => ({ skills: page, totalSkills: skills.length, ...(offset + page.length < skills.length ? { nextOffset: offset + page.length } : {}) })
  for (const skill of skills.slice(offset, offset + limit)) {
    // Discovery summaries are previews; full instructions remain available via
    // skills_read. Always leave IDs and names intact for reliable selection.
    const summary = safePrefix(skill.summary, 600)
    const item = { ...skill, summary, ...(summary !== skill.summary ? { summaryTruncated: true as const } : {}) }
    page.push(item)
    if (JSON.stringify(result()).length > SKILL_TOOL_RESULT_MAX_CHARS) {
      if (page.length > 1) { page.pop(); break }
      // A single heavily escaped summary must still be discoverable.
      item.summaryTruncated = true
      let low = 0
      let high = summary.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        item.summary = safePrefix(summary, middle)
        if (JSON.stringify(result()).length <= SKILL_TOOL_RESULT_MAX_CHARS) low = middle
        else high = middle - 1
      }
      item.summary = safePrefix(summary, low)
      break
    }
  }
  if (page.length === 0 && offset < skills.length) throw new Error('技能目录条目超过分页预算。')
  return result()
}

function safePrefix(text: string, length: number): string {
  if (length > 0 && length < text.length && /[\uD800-\uDBFF]/u.test(text[length - 1]!) && /[\uDC00-\uDFFF]/u.test(text[length]!)) length -= 1
  return text.slice(0, length)
}
