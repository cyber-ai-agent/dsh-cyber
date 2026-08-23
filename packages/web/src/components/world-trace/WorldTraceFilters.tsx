import type { WorldTraceCategory, WorldTraceStatus } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'

export interface TraceFilters {
  category: '' | WorldTraceCategory
  status: '' | WorldTraceStatus
  actorId: string
}

export function WorldTraceFilters({ value, employees, onChange }: {
  value: TraceFilters
  employees: CyberEmployee[]
  onChange(value: TraceFilters): void
}) {
  return <div className="world-trace-filters" aria-label="筛选世界轨迹">
    <label><span>类型</span><select value={value.category} onChange={(event) => onChange({ ...value, category: event.target.value as TraceFilters['category'] })}>
      <option value="">全部</option><option value="agent">角色</option><option value="tool">工具</option><option value="skill">技能</option><option value="task">任务</option><option value="collaboration">协作</option><option value="world">世界</option><option value="schedule">计划</option><option value="system">系统</option>
    </select></label>
    <label><span>状态</span><select value={value.status} onChange={(event) => onChange({ ...value, status: event.target.value as TraceFilters['status'] })}>
      <option value="">全部</option><option value="running">进行中</option><option value="pending">待处理</option><option value="waiting">等待中</option><option value="success">已完成</option><option value="failed">失败</option><option value="cancelled">已取消</option><option value="info">记录</option>
    </select></label>
    <label><span>角色</span><select value={value.actorId} onChange={(event) => onChange({ ...value, actorId: event.target.value })}>
      <option value="">全部</option><option value="owner">你</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}
    </select></label>
  </div>
}
