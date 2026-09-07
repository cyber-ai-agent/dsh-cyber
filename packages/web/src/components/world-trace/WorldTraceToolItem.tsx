import { useEffect, useRef, useState } from 'react'
import { CheckCircle, CircleNotch, Copy, WarningCircle } from '@phosphor-icons/react'
import type { WorldTraceToolStep } from '@dsh-cyber/contracts'
import { formatDuration } from '../../i18n/format.js'

/** Render host evidence, not a generated story of what the tool probably did. */
export function WorldTraceToolItem({ tool }: { tool: WorldTraceToolStep }) {
  const [copyStatus, setCopyStatus] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const hasDifferentInput = Boolean(tool.input && tool.input.trim() !== tool.description?.trim())
  const target = tool.description ?? tool.input
  const publication = /(?:^|\/)\.dsh\/artifacts\/[^\n]+\.json(?:$|\s| ·)/.test((tool.input ?? target ?? '').replaceAll('\\', '/'))
    && /write|create|save/i.test(tool.name ?? '')
  const label = publication ? '写入产物登记清单' : tool.label
  const nonzeroExit = tool.exitCode !== undefined && tool.exitCode !== 0
  const warning = tool.status === 'failed' || nonzeroExit
  const copy = async (text: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      if (mounted.current) setCopyStatus('已复制')
    } catch {
      if (mounted.current) setCopyStatus('复制失败，请选中文本复制')
    }
  }
  return <li className={`world-trace-tool is-${tool.status}${warning ? ' has-warning' : ''}`}>
    {tool.status === 'running' ? <CircleNotch size={14} className="spin" /> : warning ? <WarningCircle size={14} /> : <CheckCircle size={14} weight="fill" />}
    <div className="world-trace-tool__body">
      <div className="world-trace-tool__heading"><strong>{label}</strong>{tool.name ? <code>{tool.name}</code> : null}</div>
      {target ? <code className="world-trace-tool__target">{target}</code> : null}
      {publication ? <small>清单写入与宿主校验、产物登记是不同步骤；登记结果见产出记录。</small> : null}
      {hasDifferentInput ? <details className="world-trace-tool__evidence"><summary>查看参数</summary><pre>{tool.input}</pre></details> : null}
      {tool.output !== undefined ? <details className="world-trace-tool__evidence"><summary>查看结果{tool.outputTruncated ? ' · 已截断' : ''}{tool.outputRedacted ? ' · 已脱敏' : ''}</summary><pre>{tool.output}</pre><button type="button" onClick={() => { void copy(tool.output!) }}><Copy size={14} />复制结果</button></details> : null}
      <div className="world-trace-tool__actions">
        {tool.input || target ? <button type="button" aria-label={`复制${label}的参数`} onClick={() => { void copy(tool.input ?? target!) }}><Copy size={14} />复制参数</button> : null}
        {tool.exitCode === undefined ? null : <small>退出码：{tool.exitCode}</small>}
        <small role="status">{copyStatus}</small>
      </div>
    </div>
    <small className="world-trace-tool__status">{tool.status === 'running' ? '执行中' : warning ? (nonzeroExit ? '非零退出' : '失败') : '完成'}{tool.durationMs === undefined ? '' : ` · ${formatDuration(tool.durationMs)}`}</small>
  </li>
}
