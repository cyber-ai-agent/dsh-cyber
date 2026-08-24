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
      return { status: 'failed', detail: error instanceof Error && error.name === 'AbortError' ? 'Firecrawl 搜索超时' : 'Firecrawl 搜索连接中断' }
    } finally { clearTimeout(timeout) }
  }
}

function requestedSearchQuery(prompt: string): string | undefined {
  const match = /(?:\/web-search|\/联网搜索|请联网搜索|联网搜索|使用\s*Firecrawl\s*搜索|用\s*Firecrawl\s*搜索)\s*[：:]?\s*([\s\S]+)/i.exec(prompt)
  const value = match?.[1]?.trim()
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
