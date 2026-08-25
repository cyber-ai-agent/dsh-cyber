import type {
  DomainEvent,
  DomainEventType,
  JsonObject,
  WorldTraceCategory,
  WorldTraceEntry,
  WorldTraceStatus,
} from '@dsh-cyber/contracts'

import {
  booleanField,
  numberField,
  runtimeIdentity,
  stringField,
  traceId,
  type WorldTraceAdapter,
} from './trace-adapter.js'

interface DomainPresentation {
  category: WorldTraceCategory
  status: WorldTraceStatus
  summary: string
  detail?: string
  lifecycle?: 'turn' | 'tool' | 'task' | 'meeting'
}

const EXCLUDED = new Set<DomainEventType>([
  'message.appended',
  'world.runtime.snapshot.saved',
  'world.entered',
  'employee.milestone.recorded',
  'employee.journal.written',
  'employee.relationship.updated',
  'workspace.preferences.updated',
  'model.profile.updated',
  'model.assignment.updated',
  'local.asset.saved',
  'session.created',
  'session.participant.joined',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'tool.started',
  'tool.completed',
  'task.started',
  'task.waiting',
  'task.blocked',
  'task.completed',
])

/**
 * Domain event types the world trace can never render.
 *
 * Three are explicitly discarded by `describe`, and three have no case at all.
 * Reading them only to drop them is what made the trace read model expensive on
 * a long-lived world, so they are excluded in SQL. A test asserts this list is
 * exactly the set the adapter produces nothing for.
 */
export const TRACE_INVISIBLE_EVENT_TYPES: readonly DomainEventType[] = [
  'workspace.created',
  'world.administrator.changed',
  'world.entered',
  'employee.milestone.recorded',
  'employee.journal.written',
  'employee.relationship.updated',
  'workspace.preferences.updated',
  'model.profile.updated',
  'model.assignment.updated',
  'local.asset.saved',
  'session.created',
  'session.participant.joined',
  'message.appended',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'tool.started',
  'tool.completed',
  'task.started',
  'task.waiting',
  'task.blocked',
  'task.completed',
  'world.runtime.snapshot.saved',
  'world.package.instantiated',
  'world.package.disabled',
]

export class DomainEventTraceAdapter implements WorldTraceAdapter<'domain-event'> {
  readonly kind = 'domain-event' as const

  adapt({ value }: { kind: 'domain-event'; value: DomainEvent }): WorldTraceEntry[] {
    if (value.worldId === undefined || EXCLUDED.has(value.type)) return []
    const payload = value.payload as JsonObject & Record<string, unknown>
    const presentation = presentDomainEvent(value.type, payload)
    if (presentation === undefined) return []
    const source = stringField(payload, 'source')
    const sourceSessionId = stringField(payload, 'sourceSessionId')
    const sourceSequence = numberField(payload, 'sourceSequence')
    const callId = stringField(payload, 'callId')
    const traceTurnId = stringField(payload, 'traceTurnId')
    const entryId = presentation.lifecycle === 'turn' && source !== undefined && sourceSessionId !== undefined
      ? runtimeIdentity({ kind: runtimeTurnKind(value.type), source, sourceSessionId, ...(sourceSequence === undefined ? {} : { sourceSequence }), ...(traceTurnId === undefined ? {} : { traceTurnId }) })
      : presentation.lifecycle === 'turn' && traceTurnId !== undefined
        ? traceId('runtime-turn', traceTurnId)
      : presentation.lifecycle === 'tool' && source !== undefined && sourceSessionId !== undefined
        ? runtimeIdentity({ kind: runtimeToolKind(value.type), source, sourceSessionId, ...(sourceSequence === undefined ? {} : { sourceSequence }), ...(callId === undefined ? {} : { callId }), ...(traceTurnId === undefined ? {} : { traceTurnId }) })
        : presentation.lifecycle === 'task'
          ? traceId('domain-task', traceTurnId ?? `${value.sessionId}:${value.actorId}`)
          : presentation.lifecycle === 'meeting'
            ? traceId('domain-meeting', stringField(payload, 'meetingRunId') ?? value.sessionId ?? value.correlationId)
            : traceId('domain-event', value.id)
    return [{
      id: entryId,
      worldId: value.worldId,
      category: presentation.category,
      status: presentation.status,
      summary: presentation.summary,
      ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
      actorId: value.actorId,
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
      ...(presentation.lifecycle === 'task' ? { taskId: traceTurnId ?? `${value.sessionId ?? value.correlationId ?? value.id}:${value.actorId}` } : {}),
      sourceKind: 'domain-event',
      sourceId: value.id,
      sourceSequence: value.sequence,
      createdAt: value.createdAt,
      updatedAt: value.createdAt,
    }]
  }
}

function presentDomainEvent(type: DomainEventType, payload: Record<string, unknown>): DomainPresentation | undefined {
  switch (type) {
    case 'world.created': return { category: 'world', status: 'success', summary: '世界已创建' }
    case 'world.renamed': return { category: 'world', status: 'success', summary: worldRenameSummary(payload) }
    case 'world.character.authority.changed': return { category: 'world', status: 'success', summary: '角色世界职权已更新' }
    case 'world.creation.rolled-back': return { category: 'world', status: 'failed', summary: '世界创建已回滚' }
    case 'world.entered': return { category: 'world', status: 'info', summary: '已进入世界' }
    case 'employee.recruited': return { category: 'world', status: 'success', summary: '新角色已加入世界' }
    case 'employee.revised':
    case 'employee.profile.revised': return { category: 'world', status: 'success', summary: '角色设定已更新' }
    case 'employee.archived': return { category: 'world', status: 'cancelled', summary: '角色已归档' }
    case 'skill.evidence.recorded': return { category: 'skill', status: 'success', summary: '技能证据已记录' }
    case 'employee.skill.revised': return { category: 'skill', status: 'success', summary: '角色技能已更新' }
    case 'employee.milestone.recorded': return { category: 'world', status: 'success', summary: '成长里程碑已记录' }
    case 'employee.journal.written': return { category: 'world', status: 'info', summary: '角色日志已更新' }
    case 'employee.relationship.updated': return { category: 'collaboration', status: 'info', summary: '角色关系已更新' }
    case 'celebration.started': return { category: 'world', status: 'running', summary: '成长庆祝已开始' }
    case 'celebration.finished': return { category: 'world', status: 'success', summary: '成长庆祝已完成' }
    case 'workspace.preferences.updated': return { category: 'system', status: 'success', summary: '工作区偏好已更新' }
    case 'model.profile.updated':
    case 'model.assignment.updated': return { category: 'system', status: 'success', summary: '模型配置已更新' }
    case 'local.asset.saved': return { category: 'system', status: 'success', summary: '本地资产已保存' }
    case 'session.created': return { category: 'collaboration', status: 'info', summary: '会话已创建' }
    case 'session.participant.joined': return { category: 'collaboration', status: 'info', summary: '会话成员已加入' }
    case 'meeting.started': return { category: 'collaboration', status: 'running', summary: '多人协作已开始', lifecycle: 'meeting' }
    case 'meeting.finished': return {
      category: 'collaboration',
      status: stringField(payload, 'status') === 'blocked' ? 'failed' : 'success',
      summary: stringField(payload, 'status') === 'blocked' ? '多人协作被阻塞' : '多人协作已完成',
      lifecycle: 'meeting',
    }
    case 'turn.started': return { category: 'agent', status: 'running', summary: '角色开始处理请求', lifecycle: 'turn' }
    case 'turn.completed': return { category: 'agent', status: 'success', summary: '角色已完成本轮处理', lifecycle: 'turn' }
    case 'turn.failed': return { category: 'agent', status: 'failed', summary: '角色本轮处理失败', lifecycle: 'turn' }
    case 'tool.started': return {
      category: 'tool',
      status: 'running',
      summary: `开始使用工具：${stringField(payload, 'toolName') ?? '未命名工具'}`,
      ...(stringField(payload, 'toolName') === undefined ? {} : { detail: stringField(payload, 'toolName')! }),
      lifecycle: 'tool',
    }
    case 'tool.completed': return {
      category: 'tool',
      status: booleanField(payload, 'failed') === true ? 'failed' : 'success',
      summary: booleanField(payload, 'failed') === true ? '工具执行失败' : '工具执行完成',
      ...(stringField(payload, 'toolName') === undefined ? {} : { detail: stringField(payload, 'toolName')! }),
      lifecycle: 'tool',
    }
    case 'task.started': return { category: 'task', status: 'running', summary: '真实任务已开始', lifecycle: 'task' }
    case 'task.waiting': return { category: 'task', status: 'waiting', summary: '任务正在等待', lifecycle: 'task' }
    case 'task.blocked': return { category: 'task', status: 'failed', summary: '任务已被阻塞', lifecycle: 'task' }
    case 'task.completed': return { category: 'task', status: 'success', summary: '真实任务已完成', lifecycle: 'task' }
    case 'schedule.created': return { category: 'schedule', status: 'pending', summary: '计划任务已创建' }
    case 'schedule.updated': return { category: 'schedule', status: 'info', summary: '计划任务已更新' }
    case 'schedule.run.started': return { category: 'schedule', status: 'running', summary: '计划任务开始执行' }
    case 'schedule.run.completed': return { category: 'schedule', status: 'success', summary: '计划任务执行完成' }
    case 'schedule.run.failed': return { category: 'schedule', status: 'failed', summary: '计划任务执行失败' }
    case 'world.interaction.requested': return { category: 'world', status: 'pending', summary: interactionSummary(payload, false) }
    case 'world.interaction.completed': return { category: 'world', status: 'success', summary: interactionSummary(payload, true) }
    case 'world.object.activated': return { category: 'world', status: 'success', summary: '世界对象已激活' }
    case 'world.lights.changed': return { category: 'world', status: 'success', summary: '世界灯光已切换' }
    case 'package.install.approved': return { category: 'system', status: 'pending', summary: '软件包安装已批准' }
    case 'package.install.staged': return { category: 'system', status: 'running', summary: '软件包正在暂存验证' }
    case 'package.install.activated': return { category: 'system', status: 'success', summary: '软件包已激活' }
    case 'package.install.rolled-back': return { category: 'system', status: 'failed', summary: '软件包安装已回滚' }
    // Uninstall is the same class of system fact as the four install events
    // beside it; leaving it unrendered made a package silently vanish from the
    // trace that recorded it arriving.
    case 'package.uninstalled': return { category: 'system', status: 'success', summary: '软件包已卸载' }
    case 'workspace.created':
    case 'message.appended':
    case 'world.runtime.snapshot.saved':
      return undefined
  }
}

function worldRenameSummary(payload: Record<string, unknown>): string {
  const previous = stringField(payload, 'previousName')
  const next = stringField(payload, 'name')
  if (!next) return '世界已重命名'
  return previous ? `世界已重命名：${previous} → ${next}` : `世界已重命名为「${next}」`
}

function runtimeTurnKind(type: DomainEventType): 'turn.started' | 'turn.completed' | 'turn.failed' {
  if (type === 'turn.completed') return type
  if (type === 'turn.failed') return type
  return 'turn.started'
}

function runtimeToolKind(type: DomainEventType): 'tool.started' | 'tool.completed' {
  return type === 'tool.completed' ? type : 'tool.started'
}

function interactionSummary(payload: Record<string, unknown>, completed: boolean): string {
  const action = stringField(payload, 'action')
  const label: Record<string, string> = {
    focus: '聚焦角色',
    talk: '发起对话',
    'assign-task': '安排任务',
    inspect: '查看对象',
    'use-object': '使用世界对象',
    'start-meeting': '召集会议',
    'toggle-lights': '切换灯光',
    'fit-camera': '调整世界视图',
  }
  return `${label[action ?? ''] ?? '世界交互'}${completed ? '已完成' : '已提交'}`
}
