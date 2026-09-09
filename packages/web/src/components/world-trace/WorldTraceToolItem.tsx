import { useState } from 'react'
import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import type { WorldTraceToolStep } from '@dsh-cyber/contracts'
import { formatDuration } from '../../i18n/format.js'

const PREVIEW_LINES = 5

/**
 * One tool step in the trace: the raw command and the raw result live together
 * in a single evidence box. Collapsed it previews the first five lines; when
 * the content runs longer, clicking the box expands the full text. There is no
 * copy affordance and no redaction: the owner selects text to take it away.
 */
export function WorldTraceToolItem({ tool }: { tool: WorldTraceToolStep }) {
  const [expanded, setExpanded] = useState(false)
  const inputText = (tool.input ?? '').trim()
  const outputText = tool.output ?? ''
  const hasInput = inputText !== ''
  const hasOutput = outputText !== ''
  const combined = [hasInput ? inputText : '', hasOutput ? outputText : ''].filter(Boolean).join('\n')
  const lines = combined ? combined.split('\n') : []
  const clamped = lines.length > PREVIEW_LINES
  const preview = lines.slice(0, PREVIEW_LINES).join('\n')
  const publication = /(?:^|\/)\.dsh\/artifacts\/[^\n]+\.json(?:$|\s| ·)/.test(inputText.replaceAll('\\', '/'))
    && /write|create|save/i.test(tool.name ?? '')
  const label = publication ? '写入产物登记清单' : tool.label
  const nonzeroExit = tool.exitCode !== undefined && tool.exitCode !== 0
  const warning = tool.status === 'failed' || nonzeroExit
  const statusText = tool.status === 'running' ? '执行中' : warning ? (nonzeroExit ? '非零退出' : '失败') : '完成'
  const toggle = () => { if (clamped) setExpanded((value) => !value) }
  return <li className={`world-trace-tool is-${tool.status}${warning ? ' has-warning' : ''}`}>
    {tool.status === 'running' ? <CircleNotch size={14} className="spin" /> : warning ? <WarningCircle size={14} /> : <CheckCircle size={14} weight="fill" />}
    <div className="world-trace-tool__body">
      <div className="world-trace-tool__heading">
        <strong>{label}</strong>
        {tool.name ? <code>{tool.name}</code> : null}
        {tool.exitCode !== undefined ? <small>退出码：{tool.exitCode}</small> : null}
      </div>
      {publication ? <small>清单写入与宿主校验、产物登记是不同步骤；登记结果见产出记录。</small> : null}
      {!(hasInput || hasOutput) && tool.description ? <small>{tool.description}</small> : null}
      {hasInput || hasOutput ? <div
        className={`world-trace-tool__evidence${clamped ? ' is-clickable' : ''}`}
        role={clamped ? 'button' : undefined}
        tabIndex={clamped ? 0 : undefined}
        aria-expanded={clamped ? expanded : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && clamped) {
            event.preventDefault()
            toggle()
          }
        }}
      >
        {expanded ? <>
          {hasInput ? <div className="world-trace-tool__part"><span>命令</span><pre>{inputText}</pre></div> : null}
          {hasOutput ? <div className="world-trace-tool__part"><span>结果</span><pre>{outputText}{tool.outputTruncated ? '…' : ''}</pre></div> : null}
        </> : <pre>{preview}{clamped ? '…' : ''}</pre>}
        {clamped ? <small className="world-trace-tool__hint">{expanded ? '点击收起' : '点击展开完整内容'}</small> : null}
      </div> : null}
    </div>
    <small className="world-trace-tool__status">{statusText}{tool.durationMs === undefined ? '' : ` · ${formatDuration(tool.durationMs)}`}</small>
  </li>
}
