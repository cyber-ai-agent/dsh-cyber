import type { DatabaseSync } from 'node:sqlite'
import { parseModelStatsQuery, type ModelStatsItem, type ModelStatsProvider, type ModelStatsQueryParams, type ModelStatsResponse } from '@dsh-cyber/contracts'

type Aggregate = {
  tokensSent: number; tokensReceived: number; tokensCached: number | null
  requests: number; toolCalls: number; successCount: number; avgLatencyMs: number | null
}
const METRICS = `COALESCE(SUM(tokens_prompt), 0) AS tokensSent,
  COALESCE(SUM(tokens_completion), 0) AS tokensReceived, SUM(tokens_cached) AS tokensCached,
  COUNT(*) AS requests, COALESCE(SUM(tool_call_count), 0) AS toolCalls,
  COALESCE(SUM(status = 'success'), 0) AS successCount, AVG(duration_ms) AS avgLatencyMs`
const PROVIDER_KEY = "CASE WHEN provider_id IS NULL THEN 'legacy:' || provider ELSE 'provider:' || provider_id END"

/** Only aggregate rows cross the SQLite boundary. Every lookup is workspace-scoped. */
export class ModelStatsRepository {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => string) {}

  aggregate(workspaceId: string, input: ModelStatsQueryParams): ModelStatsResponse {
    const params = parseModelStatsQuery(input, this.clock())
    const base = 'workspace_id = ? AND created_at >= ? AND created_at <= ?'
    const values: string[] = [workspaceId, params.from!, params.to!]
    let where = base
    if (params.groupBy === 'provider') {
      const key = params.providerId!
      if (key.startsWith('provider:')) { where += ' AND provider_id = ?'; values.push(key.slice(9)) }
      else { where += ' AND provider_id IS NULL AND provider = ?'; values.push(key.startsWith('legacy:') ? key.slice(7) : key) }
    }
    const total = this.db.prepare(`SELECT ${METRICS} FROM model_interaction_logs WHERE ${where}`).get(...values) as Aggregate
    const group = params.groupBy === 'all' ? 'employee_id, world_id' : 'model_id'
    // Keep system records together; real employees retain their world context.
    const dimensions = params.groupBy === 'all' ? 'employee_id AS actor, CASE WHEN employee_id IS NULL THEN NULL ELSE world_id END AS world' : 'model_id AS model'
    const grouped = this.db.prepare(`SELECT ${dimensions}, ${METRICS} FROM model_interaction_logs WHERE ${where}
      GROUP BY ${params.groupBy === 'all' ? 'actor, world' : group} ORDER BY requests DESC, ${params.groupBy === 'all' ? 'actor, world' : 'model_id'}`)
      .all(...values) as Array<Aggregate & { actor?: string | null; world?: string | null; model?: string }>
    const employee = this.db.prepare('SELECT display_name FROM employee_instances WHERE workspace_id = ? AND id = ?')
    const world = this.db.prepare('SELECT name FROM worlds WHERE workspace_id = ? AND id = ?')
    const items: ModelStatsItem[] = grouped.map((row) => {
      const item: ModelStatsItem = {
        id: params.groupBy === 'all' ? row.actor ?? '' : row.model!,
        tokensSent: row.tokensSent, tokensReceived: row.tokensReceived, requests: row.requests,
        toolCalls: row.toolCalls, successCount: row.successCount, avgLatencyMs: Math.round(row.avgLatencyMs ?? 0),
        ...(row.tokensCached === null ? {} : { tokensCached: row.tokensCached, hasCacheData: true }),
      }
      if (params.groupBy === 'all') {
        item.name = row.actor ? (employee.get(workspaceId, row.actor) as { display_name: string } | undefined)?.display_name ?? row.actor : '系统'
        if (row.world) { const name = (world.get(workspaceId, row.world) as { name: string } | undefined)?.name; if (name) item.worldName = name }
      } else item.name = row.model!
      return item
    })
    // Sidebar is derived from the time window, NOT the currently selected provider.
    const providerRows = this.db.prepare(`SELECT ${PROVIDER_KEY} AS id, provider_id AS connectionId,
      COALESCE(MAX(provider_name), provider) AS name FROM model_interaction_logs WHERE ${base}
      GROUP BY ${PROVIDER_KEY} ORDER BY name, id`).all(workspaceId, params.from!, params.to!) as Array<{ id: string; connectionId: string | null; name: string }>
    const providerLookup = this.db.prepare('SELECT name FROM model_providers WHERE workspace_id = ? AND id = ?')
    const providers: ModelStatsProvider[] = providerRows.map((row) => ({
      id: row.id, legacy: row.connectionId === null,
      name: row.connectionId === null ? row.name : (providerLookup.get(workspaceId, row.connectionId) as { name: string } | undefined)?.name ?? row.name,
    }))
    return {
      summary: {
        totalTokensSent: total.tokensSent, totalTokensReceived: total.tokensReceived,
        totalRequests: total.requests, totalToolCalls: total.toolCalls, successCount: total.successCount,
        avgLatencyMs: Math.round(total.avgLatencyMs ?? 0),
        successRate: total.requests === 0 ? 0 : Math.round(total.successCount / total.requests * 10_000) / 100,
        ...(total.tokensCached === null ? {} : { tokensCached: total.tokensCached }),
      },
      items, providers,
      distinctProviders: (this.db.prepare(`SELECT DISTINCT provider FROM model_interaction_logs WHERE ${base} ORDER BY provider`).all(workspaceId, params.from!, params.to!) as Array<{ provider: string }>).map((r) => r.provider),
    }
  }
}
