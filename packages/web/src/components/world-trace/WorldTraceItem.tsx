import {
  ArrowsClockwise, CaretDown, CheckCircle, CircleNotch, Clock, GearSix,
  GlobeHemisphereWest, Package, Robot, Sparkle, Stack, UsersThree, WarningCircle, Wrench,
} from '@phosphor-icons/react'
import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { formatDateTime, formatDuration, formatNumber } from '../../i18n/format.js'
import { artifactKindLabel } from '../../features/artifacts/useWorldArtifacts.js'
import { CONTEXT_LAYER_LABELS } from '../context-inspector/layer-labels.js'

const categoryLabel: Record<WorldTraceEntry['category'], string> = {
  agent: '角色运行', tool: '角色运行', skill: '技能', task: '任务', collaboration: '协作', world: '世界', schedule: '日程', system: '系统',
}
const statusLabel: Record<WorldTraceEntry['status'], string> = {
  pending: '待处理', running: '进行中', waiting: '等待中', success: '已完成', failed: '失败', cancelled: '已取消', info: '记录',
}

export function WorldTraceItem({ entry, employees, onOpenArtifact, onOpenContext }: {
  entry: WorldTraceEntry
  employees: CyberEmployee[]
  onOpenArtifact?: (artifactId: string) => void
  /** Hands a run id back to the host so the Context Inspector opens on that run. */
  onOpenContext?: (agentRunId: string) => void
}) {
  const Icon = categoryIcon(entry.category)
  const actor = employees.find((employee) => employee.id === entry.actorId)?.displayName
  const artifacts = entry.artifacts ?? []
  // Only a durable AgentRun can be looked up by the Inspector. Entries without
  // a real run id (domain events, skill actions) get no link at all.
  const contextRunId = entry.sourceKind === 'agent-run' && entry.runId ? entry.runId : undefined
  const hasDetails = Boolean(entry.reasoningSummary || entry.detail || entry.tools?.length || artifacts.length || entry.context || (contextRunId && onOpenContext))
  const content = <>
    <header><span>{categoryLabel[entry.category]}</span><time dateTime={entry.updatedAt}>{formatDateTime(entry.updatedAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></header>
    <strong>{entry.summary}</strong>
    {entry.taskId === undefined ? null : <span className="world-trace-item__task" title={entry.taskId}><CheckCircle size={12} />{`任务：${entry.taskTitle ?? entry.taskId}`}</span>}
    <div className="world-trace-item__meta"><span className={`trace-status trace-status--${entry.status}`}>{statusIcon(entry.status)}{statusLabel[entry.status]}</span>{actor === undefined ? null : <span>{actor}</span>}{entry.durationMs === undefined ? null : <span>{formatDuration(entry.durationMs)}</span>}{entry.tokenUsage === undefined ? null : <span>{formatNumber(entry.tokenUsage.total)} Token</span>}{artifacts.length === 0 ? null : <span className="world-trace-item__artifact-count"><Package size={12} />{`${artifacts.length} 个产物`}</span>}{entry.context === undefined ? null : <span className="world-trace-item__context-count"><Stack size={12} />{`上下文 ${formatNumber(entry.context.totalTokenEstimate)} Token`}</span>}</div>
  </>
  return <li className={`world-trace-item world-trace-item--${entry.status}`}>
    <span className="world-trace-item__rail" aria-hidden="true" />
    <span className="world-trace-item__icon" aria-hidden="true"><Icon size={17} /></span>
    {!hasDetails ? <article>{content}</article> : <article className="world-trace-item__expandable"><details><summary><div className="world-trace-item__summary">{content}</div><span className="world-trace-item__expand-label">查看过程<CaretDown size={14} /></span></summary><div className="world-trace-item__detail">
      {entry.reasoningSummary ? <section><strong>判断摘要</strong><p>{entry.reasoningSummary}</p></section> : null}
      {entry.tools?.length ? <section><strong>工具调度</strong><ol className="world-trace-tools">{entry.tools.map((tool) => <li key={tool.callId} className={`is-${tool.status}`}>{tool.status === 'running' ? <CircleNotch size={14} className="spin" /> : tool.status === 'failed' ? <WarningCircle size={14} /> : <CheckCircle size={14} weight="fill" />}<span><strong>{tool.label}</strong>{tool.description ? <small>{tool.description}</small> : null}{tool.name ? <code>{tool.name}</code> : null}</span><small>{tool.status === 'running' ? '执行中' : tool.status === 'failed' ? '失败' : '完成'}</small></li>)}</ol></section> : null}
      {artifacts.length === 0 ? null : <section><strong>产出结果</strong><ul className="world-trace-artifacts">{artifacts.map((artifact) => {
        const label = `${artifact.title} · ${artifactKindLabel(artifact.kind)} · v${artifact.version}`
        return <li key={`${artifact.artifactId}:${artifact.version}`}>{onOpenArtifact === undefined
          ? <span><strong>{artifact.title}</strong><small>{artifactKindLabel(artifact.kind)} · v{artifact.version}</small></span>
          : <button type="button" aria-label={`打开产物 ${label}`} onClick={() => onOpenArtifact(artifact.artifactId)}><span><strong>{artifact.title}</strong><small>{artifactKindLabel(artifact.kind)} · v{artifact.version}</small></span><span>查看</span></button>}</li>
      })}</ul></section>}
      {entry.detail ? <section><strong>运行说明</strong><p>{entry.detail}</p></section> : null}
      {entry.context === undefined && contextRunId === undefined ? null : <section className="world-trace-context"><strong>用了什么上下文</strong>
        {entry.context === undefined
          ? null
          : <>
            <ol className="world-trace-context__layers" aria-label="各层 Token 估算">{entry.context.layers.map((layer, index) => {
              const meta = CONTEXT_LAYER_LABELS[layer.kind]
              const share = Math.max(2, Math.round((layer.tokenEstimate / Math.max(1, entry.context!.totalTokenEstimate)) * 100))
              return <li key={`${layer.kind}:${index}`}><span>{meta.label}</span><i aria-hidden="true"><b style={{ inlineSize: `${share}%` }} /></i><small>{formatNumber(layer.tokenEstimate)}</small></li>
            })}</ol>
            <dl><dt>合计</dt><dd>{formatNumber(entry.context.totalTokenEstimate)} Token（本地估算）</dd><dt>记忆</dt><dd>{`命中 ${formatNumber(entry.context.memoryHitCount)} 条`}</dd></dl>
          </>}
        {contextRunId === undefined || onOpenContext === undefined ? null : <button type="button" className="world-trace-context__open" aria-label={`查看运行 ${contextRunId} 的上下文`} onClick={() => onOpenContext(contextRunId)}>{entry.context === undefined ? '查看上下文记录' : '打开上下文检查器'}</button>}
      </section>}
      {entry.modelId || entry.provider || entry.tokenUsage ? <section className="world-trace-usage"><strong>模型用量</strong><dl>{entry.provider ? <><dt>服务</dt><dd>{entry.provider}</dd></> : null}{entry.modelId ? <><dt>模型</dt><dd>{entry.modelId}</dd></> : null}{entry.tokenUsage ? <><dt>输入</dt><dd>{formatNumber(entry.tokenUsage.prompt)}</dd><dt>输出</dt><dd>{formatNumber(entry.tokenUsage.completion)}</dd><dt>合计</dt><dd>{formatNumber(entry.tokenUsage.total)} Token</dd></> : null}</dl></section> : null}
    </div></details></article>}
  </li>
}

function categoryIcon(category: WorldTraceEntry['category']) {
  return ({ agent: Robot, tool: Wrench, skill: Sparkle, task: CheckCircle, collaboration: UsersThree, world: GlobeHemisphereWest, schedule: Clock, system: GearSix })[category]
}

function statusIcon(status: WorldTraceEntry['status']) {
  if (status === 'running') return <CircleNotch size={12} className="spin" />
  if (status === 'failed') return <WarningCircle size={12} />
  if (status === 'waiting' || status === 'pending') return <Clock size={12} />
  if (status === 'success') return <CheckCircle size={12} weight="fill" />
  return <ArrowsClockwise size={12} />
}
