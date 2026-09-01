import { ArrowClockwise } from '@phosphor-icons/react'
import type { ContextInspection, ContextLayerKind } from '@dsh-cyber/contracts'

import { useI18n } from '../../i18n/runtime.js'
import { useContextInspection } from './useContextInspection.js'
import './context-inspector.css'

/**
 * The Context Inspector.
 *
 * It answers one question the product could not answer before: what is
 * actually in this character's context. Everything here describes the layers
 * this product assembled and sent for the last turn — never the model's
 * internal reasoning, which we do not have and must not pretend to show. The
 * header copy says so in plain Chinese, because a surface like this is exactly
 * where a vague label turns into a false claim.
 */

const LAYER_LABELS: Record<ContextLayerKind, { key: string; label: string; hint: string }> = {
  'stable-identity': {
    key: 'context.layerIdentity',
    label: '稳定身份',
    hint: '人设、角色资料与已授予的权限，每轮不变，因此可以被缓存。',
  },
  'world-context': {
    key: 'context.layerWorld',
    label: '世界规则',
    hint: '当前世界的设定与运行规则。',
  },
  'task-context': {
    key: 'context.layerTask',
    label: '任务上下文',
    hint: '本次协作的目标、计划步骤与依赖。',
  },
  'memory-index': {
    key: 'context.layerMemoryIndex',
    label: '记忆索引',
    hint: '这一轮里角色“能想起哪些事”的目录。',
  },
  'retrieved-memories': {
    key: 'context.layerRetrieved',
    label: '召回的记忆',
    hint: '真正取回并放进这一轮的历史片段。',
  },
  'recent-conversation': {
    key: 'context.layerRecent',
    label: '最近对话',
    hint: '保留原文重放的最近几轮对话；实时会话可能只重放其中较新的一段。',
  },
  'current-request': {
    key: 'context.layerRequest',
    label: '本次请求',
    hint: '你这一次真正发出的内容。',
  },
}

const LANE_LABELS: Record<ContextInspection['lane'], { key: string; label: string }> = {
  direct: { key: 'context.laneDirect', label: '私聊' },
  group: { key: 'context.laneGroup', label: '群聊' },
  task: { key: 'context.laneTask', label: '任务' },
  unknown: { key: 'context.laneUnknown', label: '未知会话' },
}

export function ContextInspectorPanel({
  conversationId,
  demoMode,
}: {
  conversationId?: string
  demoMode: boolean
}) {
  const { t, formatNumber, formatDateTime } = useI18n()
  const { inspection, loading, error, refresh } = useContextInspection(conversationId, demoMode)

  return <section className="context-inspector" aria-label={t('context.title', '上下文检查器')}>
    <header className="context-inspector__header">
      <span>
        <strong>{t('context.title', '上下文检查器')}</strong>
        <small>{t(
          'context.disclaimer',
          '这里展示的是本产品为这一轮实际拼装并发送的上下文结构，不是模型的隐藏思维链。',
        )}</small>
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label={t('context.refresh', '刷新上下文')}
        disabled={loading}
        onClick={() => void refresh()}
      ><ArrowClockwise size={17} className={loading ? 'spin' : ''} /></button>
    </header>

    {error === undefined ? null : <div className="context-inspector__error" role="alert">{error}</div>}

    {inspection === undefined
      ? <EmptyState demoMode={demoMode} loading={loading} {...(conversationId === undefined ? {} : { conversationId })} />
      : <div className="context-inspector__body">
        <Summary inspection={inspection} formatNumber={formatNumber} formatDateTime={formatDateTime} />
        <Layers inspection={inspection} formatNumber={formatNumber} />
        <MemoryHits inspection={inspection} formatNumber={formatNumber} />
        <Cache inspection={inspection} formatNumber={formatNumber} />
        <Coverage inspection={inspection} formatNumber={formatNumber} />
      </div>}
  </section>
}

function EmptyState({
  conversationId,
  demoMode,
  loading,
}: {
  conversationId?: string
  demoMode: boolean
  loading: boolean
}) {
  const { t } = useI18n()
  if (loading) {
    return <div className="context-inspector__empty" role="status">
      <strong>{t('context.loading', '正在读取上下文…')}</strong>
    </div>
  }
  return <div className="context-inspector__empty">
    <strong>{t('context.emptyTitle', '这个会话还没有可查看的上下文')}</strong>
    <span>{demoMode
      ? t('context.emptyDemo', '演示模式没有真实运行的上下文；连接本地服务后即可查看。')
      : conversationId === undefined
        ? t('context.emptyNoConversation', '先在左侧选择一个会话，再回到这里查看它的上下文。')
        : t('context.emptyNoTurn', '发送一条消息后，这里会显示那一轮实际发送的分层内容。记录随服务进程保存，重启后需要重新发送一轮。')}</span>
  </div>
}

function Summary({
  inspection,
  formatNumber,
  formatDateTime,
}: {
  inspection: ContextInspection
  formatNumber(value: number): string
  formatDateTime(value: string, options?: Intl.DateTimeFormatOptions): string
}) {
  const { t } = useI18n()
  const lane = LANE_LABELS[inspection.lane]
  const window = inspection.budget.contextWindow
  const input = inspection.budget.inputBudgetTokens
  const share = input === undefined || input <= 0
    ? undefined
    : Math.min(100, Math.round((inspection.usedTokens / input) * 100))

  return <section className="context-inspector__card">
    <h3>{t('context.summaryTitle', '本轮上下文')}</h3>
    <p className="context-inspector__meta">
      <span>{inspection.employeeName}</span>
      <span>{t(lane.key, lane.label)}</span>
      <span>{formatDateTime(inspection.capturedAt, { dateStyle: 'short', timeStyle: 'short' })}</span>
    </p>
    <p className="context-inspector__tokens">
      <strong>{formatNumber(inspection.usedTokens)}</strong>
      <span>{t('context.usedTokens', 'Token（按本地估算，非模型账单）')}</span>
    </p>
    {share === undefined
      ? <p className="context-inspector__note">{t('context.noBudget', '本轮没有记录模型预算，因此不展示占用比例。')}</p>
      : <>
        <div className="context-inspector__meter" role="img" aria-label={t('context.meterLabel', '已占用输入预算 {percent}%', { percent: share })}>
          <i style={{ inlineSize: `${share}%` }} />
        </div>
        <dl className="context-inspector__facts">
          <div><dt>{t('context.budgetInput', '可用输入预算')}</dt><dd>{formatNumber(input!)}</dd></div>
          {window === undefined ? null : <div><dt>{t('context.budgetWindow', '模型上下文窗口')}</dt><dd>{formatNumber(window)}</dd></div>}
          {inspection.budget.memoryTokens === undefined ? null : <div><dt>{t('context.budgetMemory', '记忆预算')}</dt><dd>{formatNumber(inspection.budget.memoryTokens)}</dd></div>}
          {inspection.budget.historyTokens === undefined ? null : <div><dt>{t('context.budgetHistory', '历史预算')}</dt><dd>{formatNumber(inspection.budget.historyTokens)}</dd></div>}
        </dl>
      </>}
  </section>
}

function Layers({
  inspection,
  formatNumber,
}: {
  inspection: ContextInspection
  formatNumber(value: number): string
}) {
  const { t } = useI18n()
  const largest = inspection.layers.reduce((total, layer) => Math.max(total, layer.tokenEstimate), 1)

  return <section className="context-inspector__card">
    <h3>{t('context.layersTitle', '分层内容')}</h3>
    <ol className="context-inspector__layers">
      {inspection.layers.map((layer) => {
        const meta = LAYER_LABELS[layer.kind]
        return <li key={layer.id}>
          <details>
            <summary>
              <span className="context-inspector__layer-head">
                <strong>{t(meta.key, meta.label)}</strong>
                <small>{t(`${meta.key}Hint`, meta.hint)}</small>
              </span>
              <span className="context-inspector__layer-size">
                <strong>{formatNumber(layer.tokenEstimate)}</strong>
                <small>Token</small>
              </span>
            </summary>
            <div className="context-inspector__layer-body">
              <div className="context-inspector__bar" aria-hidden="true">
                <i style={{ inlineSize: `${Math.max(2, Math.round((layer.tokenEstimate / largest) * 100))}%` }} />
              </div>
              <dl className="context-inspector__facts">
                <div><dt>{t('context.layerRevision', '版本')}</dt><dd>{layer.revision}</dd></div>
                <div><dt>{t('context.layerHash', '内容哈希')}</dt><dd><code>{layer.contentHash}</code></dd></div>
                <div><dt>{t('context.layerSources', '来源条目')}</dt><dd>{formatNumber(layer.sourceCount)}</dd></div>
              </dl>
              <p className="context-inspector__preview">{layer.preview}</p>
              {layer.previewTruncated
                ? <p className="context-inspector__note">{t('context.previewTruncated', '内容较长，此处只显示开头一段；凭据已自动隐藏。')}</p>
                : null}
            </div>
          </details>
        </li>
      })}
    </ol>
  </section>
}

function MemoryHits({
  inspection,
  formatNumber,
}: {
  inspection: ContextInspection
  formatNumber(value: number): string
}) {
  const { t } = useI18n()
  return <section className="context-inspector__card">
    <h3>{t('context.memoryTitle', '这一轮召回了哪些记忆')}</h3>
    {inspection.memoryHits.length === 0
      ? <p className="context-inspector__note">{t('context.memoryEmpty', '本轮没有召回任何记忆，最近对话按原文重放。')}</p>
      : <ul className="context-inspector__memories">
        {inspection.memoryHits.map((hit) => <li key={hit.memoryId}>
          <header>
            <code>{hit.memoryId}</code>
            <span className="context-inspector__score">{t('context.memoryScore', '相关度 {score}', { score: hit.score.toFixed(2) })}</span>
          </header>
          <p className="context-inspector__preview">{hit.summary}</p>
          <p className="context-inspector__meta">
            <span>{hit.reason}</span>
            <span>{t('context.memorySources', '来源消息 {count} 条', { count: formatNumber(hit.sourceMessageCount) })}</span>
            {hit.artifactCount === 0 ? null : <span>{t('context.memoryArtifacts', '相关产物 {count} 个', { count: formatNumber(hit.artifactCount) })}</span>}
          </p>
        </li>)}
      </ul>}
  </section>
}

function Cache({
  inspection,
  formatNumber,
}: {
  inspection: ContextInspection
  formatNumber(value: number): string
}) {
  const { t } = useI18n()
  const cache = inspection.cache
  // No cache runtime reported anything, so nothing is claimed. A fabricated
  // hit rate would be worse than an honest blank.
  const unknown = cache.state === 'unavailable' || cache.state === 'disabled'

  return <section className="context-inspector__card">
    <h3>{t('context.cacheTitle', '提示词缓存')}</h3>
    {unknown
      ? <p className="context-inspector__note">{cache.state === 'disabled'
        ? t('context.cacheDisabled', '未启用：当前模型通道没有开启提示词缓存。')
        : t('context.cacheUnavailable', '本轮无缓存数据：运行时没有返回缓存统计，因此这里不显示命中率。')}</p>
      : <dl className="context-inspector__facts">
        <div>
          <dt>{t('context.cacheState', '缓存结果')}</dt>
          <dd>{cache.state === 'hit' ? t('context.cacheHit', '命中') : t('context.cacheMiss', '未命中')}</dd>
        </div>
        {cache.cachedTokens === undefined ? null : <div><dt>{t('context.cacheCached', '命中的 Token')}</dt><dd>{formatNumber(cache.cachedTokens)}</dd></div>}
        {cache.uncachedTokens === undefined ? null : <div><dt>{t('context.cacheUncached', '未命中的 Token')}</dt><dd>{formatNumber(cache.uncachedTokens)}</dd></div>}
      </dl>}
    {cache.stableContextHash === undefined ? null : <dl className="context-inspector__facts">
      <div>
        <dt>{t('context.cachePrefix', '稳定前缀标识')}</dt>
        <dd><code>{cache.stableContextHash}</code></dd>
      </div>
    </dl>}
  </section>
}

function Coverage({
  inspection,
  formatNumber,
}: {
  inspection: ContextInspection
  formatNumber(value: number): string
}) {
  const { t } = useI18n()
  const coverage = inspection.coverage
  return <section className="context-inspector__card">
    <h3>{t('context.coverageTitle', '这一轮是怎么取舍的')}</h3>
    <dl className="context-inspector__facts">
      <div><dt>{t('context.coverageRaw', '按原文保留的对话')}</dt><dd>{formatNumber(coverage.rawEntryCount)}</dd></div>
      <div><dt>{t('context.coverageDropped', '改由记忆召回的更早对话')}</dt><dd>{formatNumber(coverage.droppedOlderEntryCount)}</dd></div>
      <div><dt>{t('context.coverageHydrated', '取回原文的记忆')}</dt><dd>{formatNumber(coverage.hydratedMemoryCount)}</dd></div>
      <div><dt>{t('context.coverageScopes', '可见记忆范围')}</dt><dd>{coverage.memoryScopes.join('、') || t('context.coverageNoScope', '无')}</dd></div>
    </dl>
    {coverage.fullReplayFallback
      ? <p className="context-inspector__note">{t('context.coverageFullReplay', '本轮没有可用的记忆召回，因此完整重放了历史对话，没有丢弃任何一轮。')}</p>
      : null}
    {coverage.unrememberedRawEntryCount > 0
      ? <p className="context-inspector__note">{t(
        'context.coverageUnremembered',
        '有 {count} 轮对话没有被任何记忆收录，为了不让它们彻底消失，这一轮仍然按原文保留。',
        { count: formatNumber(coverage.unrememberedRawEntryCount) },
      )}</p>
      : null}
  </section>
}
