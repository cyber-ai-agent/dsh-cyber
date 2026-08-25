import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { InstalledPackage } from '@dsh-cyber/contracts'

import { FIRECRAWL_INTEGRATION_ID } from '../integrations/firecrawl-provider.js'
import { FirecrawlClient, FirecrawlClientError } from '../integrations/firecrawl-client.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import type { CharacterSkillActionProposal, CharacterSkillAdapter, CharacterSkillExecutionResult, CharacterSkillMatchContext } from './skill-adapter.js'

export const FIRECRAWL_SEARCH_SKILL = 'web.search.firecrawl'
export const FIRECRAWL_ADAPTER_ID = 'builtin.firecrawl'
export const FIRECRAWL_PACKAGE_ID = 'official-firecrawl-search'

const DESCRIPTOR: CharacterSkillDescriptor = {
  id: FIRECRAWL_SEARCH_SKILL,
  displayName: '联网搜索',
  summary: '通过当前工作区配置的 Firecrawl 搜索公开网页；查询文本会发送到外部服务。',
  adapterId: FIRECRAWL_ADAPTER_ID,
  packageId: FIRECRAWL_PACKAGE_ID,
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
  readonly #client: FirecrawlClient
  readonly #listWorldPackages: (worldId: string) => Promise<InstalledPackage[]>

  constructor(options: { store: Pick<SqliteStore, 'getWorld'>; integrations: IntegrationService; listWorldPackages?: (worldId: string) => Promise<InstalledPackage[]>; fetch?: typeof globalThis.fetch; client?: FirecrawlClient }) {
    this.#store = options.store; this.#integrations = options.integrations
    this.#client = options.client ?? new FirecrawlClient({ integrations: options.integrations, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
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
    try {
      const results = await this.#client.search({ workspaceId: world.workspaceId, query, limit: 5 })
      return { status: 'executed', detail: summarizeSearchResults(results) }
    } catch (error) {
      // A 30s abort happens after the request was sent: it may have been
      // accepted and billed. Reporting that as `failed` claims knowledge the
      // host does not have, which is exactly what `outcome-unknown` exists for.
      // A refused connection never left the machine and stays `failed`.
      if (error instanceof FirecrawlClientError && error.kind === 'unreachable') return { status: 'failed', detail: error.message }
      if (error instanceof FirecrawlClientError && error.kind === 'not-configured') return { status: 'waiting-for-integration', detail: error.message }
      if (error instanceof FirecrawlClientError && (error.kind === 'http' || error.kind === 'invalid-response' || error.kind === 'too-large')) return { status: 'failed', detail: error.message }
      return { status: 'outcome-unknown', detail: 'Firecrawl 搜索连接中断，外部请求结果未知；不得自动重试' }
    }
  }
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

function summarizeSearchResults(results: Array<{ title: string; url: string; description?: string }>): string {
  const lines = results.slice(0, 5).map((item, index) => `${index + 1}. ${item.title}\n${item.url}${item.description ? `\n${item.description}` : ''}`)
  return lines.length === 0 ? 'Firecrawl 搜索完成，但没有找到可展示的公开网页结果' : `Firecrawl 搜索完成，共返回 ${lines.length} 条结果：\n${lines.join('\n\n')}`
}
