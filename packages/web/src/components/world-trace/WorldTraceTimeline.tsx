import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { WorldTraceItem } from './WorldTraceItem.js'

export function WorldTraceTimeline({ entries, employees, onOpenArtifact }: {
  entries: WorldTraceEntry[]
  employees: CyberEmployee[]
  onOpenArtifact?: (artifactId: string) => void
}) {
  return <div className="world-trace-timeline-wrap">
    <div className="world-trace-timeline" aria-live="polite">
      {entries.length === 0 ? <div className="world-trace-empty"><strong>还没有可展示的轨迹</strong><span>提交真实任务、执行技能或与世界互动后，这里会出现经过脱敏的事实记录。</span></div> : <ol>{entries.map((entry) => <WorldTraceItem key={entry.id} entry={entry} employees={employees} {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })} />)}</ol>}
    </div>
  </div>
}
