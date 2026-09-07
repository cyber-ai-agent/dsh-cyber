import type { ModelStatsQueryParams } from './index.js'

export class ModelStatsQueryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ModelStatsQueryError' }
}

function date(value: string, field: string): string {
  // Require an ISO date or zoned timestamp, not Date.parse's locale heuristics.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value)
  const timestamp = Date.parse(value)
  const day = Number(match?.[3]); const month = Number(match?.[2]); const year = Number(match?.[1])
  const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0)
  if (!match || !Number.isFinite(timestamp) || month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate()) {
    throw new ModelStatsQueryError(`invalid_${field}_date`, `${field} 参数不是合法的 ISO-8601 日期`)
  }
  return new Date(timestamp).toISOString()
}

export function parseModelStatsQuery(params: Partial<ModelStatsQueryParams>, now: string): ModelStatsQueryParams {
  const groupBy = params.groupBy ?? 'all'
  if (groupBy !== 'all' && groupBy !== 'provider') throw new ModelStatsQueryError('invalid_stats_group', '统计分组只能为 all 或 provider')
  if (groupBy === 'provider' && !params.providerId?.trim()) throw new ModelStatsQueryError('missing_stats_provider', '请选择统计服务商')
  const to = date(params.to ?? now, 'to')
  const from = date(params.from ?? new Date(Date.parse(to) - 7 * 86_400_000).toISOString(), 'from')
  if (from > to) throw new ModelStatsQueryError('invalid_stats_range', '开始时间不能晚于结束时间')
  if (params.providerId !== undefined && params.providerId.length > 256) throw new ModelStatsQueryError('invalid_stats_provider', '统计服务商标识过长')
  return { groupBy, from, to, ...(groupBy === 'provider' ? { providerId: params.providerId! } : {}) }
}
