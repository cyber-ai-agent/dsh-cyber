import type { DomainEvent, WorkMessage } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

/**
 * Builds the durable dossier read model from canonical conversation/runtime facts.
 * Re-running the projection is safe: a completed turn event is consumed at most
 * once by each growth record, which also backfills conversations created before
 * this projection existed.
 */
export class EmployeeActivityProjectionService {
  readonly #store: SqliteStore

  constructor(store: SqliteStore) {
    this.#store = store
  }

  projectAll(): void {
    for (const workspace of this.#store.listWorkspaces()) {
      for (const world of this.#store.listWorlds(workspace.id, true)) {
        for (const employee of this.#store.listEmployees(world.id, true)) this.project(employee.id)
      }
    }
  }

  project(employeeId: string): void {
    const employee = this.#store.getEmployee(employeeId)
    if (employee === undefined) return

    const completedTurns = this.#store.listWorldDomainEvents(employee.worldId)
      .filter((event) => event.type === 'turn.completed' && event.actorId === employee.id && event.sessionId !== undefined)
    if (completedTurns.length === 0) return

    const milestones = this.#store.listEmployeeMilestones(employee.id, 500)
    const projectedMilestoneEvents = new Set(milestones.flatMap((item) => item.sourceEventIds))
    const journals = this.#store.listEmployeeJournals(employee.id, 366)
    const projectedJournalEvents = new Set(journals.flatMap((item) => item.sourceEventIds))

    for (const event of completedTurns) {
      const messages = turnMessages(this.#store.listMessages(event.sessionId!), event)
      if (messages.length === 0) continue
      const presentation = turnPresentation(employee.displayName, messages)

      if (!projectedMilestoneEvents.has(event.id)) {
        this.#store.appendEmployeeMilestone({
          employeeId: employee.id,
          category: 'task',
          title: presentation.title,
          summary: presentation.summary,
          sourceEventIds: [event.id],
          sourceMessageIds: messages.map((message) => message.id),
          actorId: employee.id,
          occurredAt: event.createdAt,
        })
        projectedMilestoneEvents.add(event.id)
      }

      if (!projectedJournalEvents.has(event.id)) {
        const localDate = localDateFor(event.createdAt)
        const previous = this.#store.listEmployeeJournals(employee.id, 366)
          .find((journal) => journal.localDate === localDate)
        const sourceEventIds = unique([...(previous?.sourceEventIds ?? []), event.id])
        const sourceMessageIds = unique([...(previous?.sourceMessageIds ?? []), ...messages.map((message) => message.id)])
        const highlights = unique([...(previous?.highlights ?? []), presentation.highlight]).slice(-12)
        this.#store.writeEmployeeJournal({
          employeeId: employee.id,
          localDate,
          summary: `${employee.displayName} 当日已完成 ${sourceEventIds.length} 次有真实记录的会话或任务。`,
          highlights,
          sourceEventIds,
          sourceMessageIds,
        })
        projectedJournalEvents.add(event.id)
      }
    }
  }
}

function turnMessages(messages: WorkMessage[], event: DomainEvent): WorkMessage[] {
  const traceTurnId = typeof event.payload.traceTurnId === 'string' ? event.payload.traceTurnId : undefined
  const agentMessages = traceTurnId === undefined
    ? messages.filter((message) => message.senderId === event.actorId)
    : messages.filter((message) => message.senderId === event.actorId && message.metadata.traceTurnId === traceTurnId)
  if (agentMessages.length === 0) return []
  const firstSequence = Math.min(...agentMessages.map((message) => message.sequence))
  const prompt = messages
    .filter((message) => message.kind === 'user' && message.sequence < firstSequence)
    .at(-1)
  return [...(prompt === undefined ? [] : [prompt]), ...agentMessages]
}

function turnPresentation(employeeName: string, messages: WorkMessage[]): {
  title: string
  summary: string
  highlight: string
} {
  const prompt = messages.find((message) => message.kind === 'user')
  const reply = messages.filter((message) => message.kind === 'assistant').at(-1)
  const toolCalls = messages.filter((message) => message.kind === 'tool-call')
  const failedTools = messages.filter((message) => message.kind === 'tool-result' && message.metadata.failed === true)
  const tools = unique(toolCalls.flatMap((message) => {
    const name = message.metadata.toolName
    return typeof name === 'string' && name.trim() ? [name.trim()] : []
  }))
  const request = compact(prompt?.content ?? '收到会话请求', 54)
  const outcome = compact(reply?.content ?? '已完成本轮处理', 72)
  const toolSummary = tools.length === 0
    ? '未调用外部工具'
    : `${failedTools.length === 0 ? '完成' : '尝试'} ${tools.join('、')} ${tools.length} 项工具调用`
  return {
    title: tools.length === 0 ? '完成一次真实对话' : '完成一次有工具证据的任务',
    summary: `回应“${request}”；${toolSummary}。结果：${outcome}`,
    highlight: `${employeeName} · ${request} · ${toolSummary}`,
  }
}

function compact(value: string, limit: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function localDateFor(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value.slice(0, 10)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
