import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { InstalledPackage } from '@dsh-cyber/contracts'

import { FIRECRAWL_INTEGRATION_ID, firecrawlBaseUrl } from '../integrations/firecrawl-provider.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import type { CharacterSkillActionProposal, CharacterSkillAdapter, CharacterSkillExecutionResult, CharacterSkillMatchContext } from './skill-adapter.js'

export const FIRECRAWL_SEARCH_SKILL = 'web.search.firecrawl'
export const FIRECRAWL_ADAPTER_ID = 'builtin.firecrawl'

const DESCRIPTOR: CharacterSkillDescriptor = {
  id: FIRECRAWL_SEARCH_SKILL,
  displayName: '联网搜索',
  summary: '通过当前工作区配置的 Firecrawl 搜索公开网页；查询文本会发送到外部服务。',
  adapterId: FIRECRAWL_ADAPTER_ID,
  risks: ['external-side-effect'],
  supportsScheduling: false,
  // The whole semantic payload of this skill is `parameters.query`, and an
  // approval policy binds (skill, action, target, risk) only. An 'exact-target'
  // policy would therefore let one approved search authorize every later query
  // text, which is the rule already written down for MCP in
  // docs/architecture/mcp-skill-adapter-v1.md: no persistent policy before
  // parameter constraints and policy fingerprints exist.
  persistentApproval: 'forbidden',
  kind: 'integration',
  recommendedByDefault: false,
}

export class FirecrawlSkillAdapter implements CharacterSkillAdapter {
  readonly id = FIRECRAWL_ADAPTER_ID
  readonly descriptors = [DESCRIPTOR] as const
  readonly #store: Pick<SqliteStore, 'getWorld'>
  readonly #integrations: IntegrationService
  readonly #fetch: typeof globalThis.fetch
  readonly #listWorldPackages: (worldId: string) => Promise<InstalledPackage[]>

  constructor(options: { store: Pick<SqliteStore, 'getWorld'>; integrations: IntegrationService; listWorldPackages?: (worldId: string) => Promise<InstalledPackage[]>; fetch?: typeof globalThis.fetch }) {
    this.#store = options.store; this.#integrations = options.integrations; this.#fetch = options.fetch ?? globalThis.fetch
    this.#listWorldPackages = options.listWorldPackages ?? (async () => [])
  }

  propose(context: CharacterSkillMatchContext): CharacterSkillActionProposal[] {
    const query = requestedSearchQuery(context.prompt)
    if (query === undefined || !context.grantedSkillIds.includes(FIRECRAWL_SEARCH_SKILL)) return []
    return [{
      skillId: FIRECRAWL_SEARCH_SKILL, adapterId: this.id, action: 'search.web', target: 'firecrawl:web-search',
      label: `联网搜索：${query.length > 40 ? `${query.slice(0, 39)}…` : query}`,
      risk: 'external-side-effect', authorization: 'explicit-user-request', parameters: { query },
    }]
  }

  async preflight(action: CharacterSkillAction) {
    const world = this.#store.getWorld(action.worldId)
    const query = typeof action.parameters.query === 'string' ? action.parameters.query.trim() : ''
    if (world === undefined || !query) return { ready: false, detail: '联网搜索缺少有效世界或查询文本' }
    const worldPackages = await this.#listWorldPackages(world.id)
    const recipeInstalled = worldPackages.some((item) => item.manifest.entrypoints?.some((entrypoint) => entrypoint.kind === 'skill' && entrypoint.id === FIRECRAWL_SEARCH_SKILL))
    if (!recipeInstalled) return { ready: false, detail: '当前世界尚未安装联网搜索 Skill Recipe' }
    const connection = this.#integrations.get(world.workspaceId, FIRECRAWL_INTEGRATION_ID)
    const credential = this.#integrations.credential(world.workspaceId, FIRECRAWL_INTEGRATION_ID)
    return connection !== undefined && connection.enabled && Boolean(credential)
      ? { ready: true }
      : { ready: false, detail: 'Firecrawl 连接尚未启用或缺少凭据' }
  }

  async execute(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const world = this.#store.getWorld(action.worldId)
    const query = typeof action.parameters.query === 'string' ? action.parameters.query.trim() : ''
    if (world === undefined || !query) return { status: 'failed', detail: '联网搜索缺少有效世界或查询文本，未发送外部请求' }
    const worldPackages = await this.#listWorldPackages(world.id)
    const recipeInstalled = worldPackages.some((item) => item.manifest.entrypoints?.some((entrypoint) => entrypoint.kind === 'skill' && entrypoint.id === FIRECRAWL_SEARCH_SKILL))
    if (!recipeInstalled) return { status: 'waiting-for-integration', detail: '当前世界尚未安装联网搜索 Skill Recipe，未发送外部请求' }
    const connection = this.#integrations.get(world.workspaceId, FIRECRAWL_INTEGRATION_ID)
    const credential = this.#integrations.credential(world.workspaceId, FIRECRAWL_INTEGRATION_ID)
    if (connection === undefined || !connection.enabled || !credential) return { status: 'waiting-for-integration', detail: '已获得搜索授权，但 Firecrawl 连接尚未启用或缺少凭据' }
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await this.#fetch(`${firecrawlBaseUrl(connection.config)}/v2/search`, {
        method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 5, sources: ['web'] }), signal: controller.signal,
      })
      if (!response.ok) return { status: 'failed', detail: firecrawlFailure(response.status) }
      const summary = summarizeSearchResponse(await response.json())
      return summary === undefined ? { status: 'failed', detail: 'Firecrawl 返回了无法识别的搜索结果' } : { status: 'executed', detail: summary }
    } catch (error) {
      // A 30s abort happens after the request was sent: it may have been
      // accepted and billed. Reporting that as `failed` claims knowledge the
      // host does not have, which is exactly what `outcome-unknown` exists for.
      // A refused connection never left the machine and stays `failed`.
      const aborted = error instanceof Error && error.name === 'AbortError'
      if (aborted) return { status: 'outcome-unknown', detail: 'Firecrawl 搜索超时，外部请求结果未知；不得自动重试' }
      if (isConnectionRefused(error)) return { status: 'failed', detail: 'Firecrawl 连接被拒绝，请求未发出' }
      return { status: 'outcome-unknown', detail: 'Firecrawl 搜索连接中断，外部请求结果未知；不得自动重试' }
    } finally { clearTimeout(timeout) }
  }
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code
    ?? (error as { code?: unknown } | null)?.code
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
}

/**
 * The trigger only fires in an imperative position: a slash command, an
 * explicit request verb, the start of a line, or a named Firecrawl request.
 * The query is bounded to the current line so an unrelated remainder of the
 * prompt can never become the text that leaves the machine.
 */
const SEARCH_TRIGGER =
  /(?:\/web-search|\/联网搜索|(?:请|帮我|帮忙|麻烦|去|来|现在|立刻|立即)\s*联网搜索|(?:^|\n)\s*联网搜索|(?:使用|用)\s*Firecrawl\s*搜索)\s*[：:，,]?\s*([^\n]+)/i

/** A negation right before the trigger cancels it rather than arming it. */
const TRIGGER_NEGATION = /(?:不要|不用|不需要|不想|无需|无须|别|勿|禁止|不准|不许|避免)[^，,。；;]{0,4}$/

function requestedSearchQuery(prompt: string): string | undefined {
  const match = SEARCH_TRIGGER.exec(prompt)
  if (match === null || match.index === undefined) return undefined
  // "不要联网搜索，直接根据下面内容回答：客户张三 手机 138…" must not egress the
  // rest of the sentence. An explicit refusal is not a request.
  if (TRIGGER_NEGATION.test(prompt.slice(Math.max(0, match.index - 12), match.index))) return undefined
  const value = match[1]?.replace(/^[，,、。：:\s]+/, '').trim()
  return value && value.length <= 500 ? value : undefined
}

function summarizeSearchResponse(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = (value as Record<string, unknown>).data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const web = (data as Record<string, unknown>).web
  if (!Array.isArray(web)) return undefined
  const lines = web.slice(0, 5).flatMap((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>; const url = typeof row.url === 'string' ? row.url : ''; if (!/^https?:\/\//.test(url)) return []
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 160) : url
    const description = typeof row.description === 'string' ? row.description.replace(/\s+/g, ' ').trim().slice(0, 320) : ''
    return [`${index + 1}. ${title}\n${url}${description ? `\n${description}` : ''}`]
  })
  return lines.length === 0 ? 'Firecrawl 搜索完成，但没有找到可展示的公开网页结果' : `Firecrawl 搜索完成，共返回 ${lines.length} 条结果：\n${lines.join('\n\n')}`
}

function firecrawlFailure(status: number): string {
  if (status === 401 || status === 403) return 'Firecrawl 凭据无效或没有访问权限'
  if (status === 402) return 'Firecrawl 账户额度不足'
  if (status === 429) return 'Firecrawl 请求过于频繁，请稍后重试'
  return `Firecrawl 搜索失败（HTTP ${status}）`
}
