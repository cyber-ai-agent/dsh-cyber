import {
  BracketsCurly,
  CaretDown,
  CheckCircle,
  CircleNotch,
  PaperPlaneRight,
  Paperclip,
  TerminalWindow,
  WarningCircle,
} from '@phosphor-icons/react'
import { useMemo, useRef, useState } from 'react'
import type { WorkMessage, WorkSession } from '@dsh-cyber/contracts'

import type { CyberEmployee, LiveAgentTurn, ToolStep } from '../types.js'
import { Avatar } from './Avatar.js'

interface ChatWorkbenchProps {
  demoMode: boolean
  session?: WorkSession
  messages: WorkMessage[]
  employees: CyberEmployee[]
  liveTurns: LiveAgentTurn[]
  sending: boolean
  draft: string
  onDraftChange(value: string): void
  onSend(prompt: string): Promise<void>
  onOpenDossier(employeeId: string): void
  onOpenArtifact(): void
  onRecruit(): void
}

export function ChatWorkbench({
  demoMode,
  session,
  messages,
  employees,
  liveTurns,
  sending,
  draft,
  onDraftChange,
  onSend,
  onOpenDossier,
  onOpenArtifact,
  onRecruit,
}: ChatWorkbenchProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mention = useMemo(() => currentMention(draft), [draft])
  const suggestions = useMemo(() => {
    if (mention === undefined) return []
    return employees.filter((employee) => employee.displayName.includes(mention)).slice(0, 6)
  }, [employees, mention])

  const submit = async () => {
    const prompt = draft.trim()
    if (!prompt || sending) return
    await onSend(prompt)
  }

  const insertMention = (employee: CyberEmployee) => {
    const marker = draft.lastIndexOf('@')
    const next = marker < 0
      ? `${draft}@${employee.displayName} `
      : `${draft.slice(0, marker)}@${employee.displayName} `
    onDraftChange(next)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <section className="chat-workbench" aria-label="多角色协作会话">
      <header className="chat-header">
        <div>
          <h1>{session?.title ?? '新会话'}</h1>
          <p>{session === undefined ? '点名一名或多名员工开始真实协作' : `${messages.length} 条消息 · 当前世界独立上下文`}</p>
        </div>
        <button className="text-button" type="button">会话成员 <span>{participantCount(messages)}</span></button>
      </header>

      <div className="message-scroll" aria-live="polite" aria-busy={sending}>
        {messages.length === 0 ? (
          <div className="conversation-empty">
            <TerminalWindow size={34} />
            <h2>{employees.length === 0 ? '当前世界还没有员工' : '向当前世界的员工下达任务'}</h2>
            <p>{employees.length === 0
              ? '从员工市场明确招聘第一位角色。招聘后会创建当前世界专属、可持续的独立 Agent。'
              : '输入 @员工名 可直接和独立 Agent 对话；同时点名多人会创建真实群组会话。'}</p>
            {employees.length === 0 ? <button className="primary-button" type="button" onClick={onRecruit}>招聘第一位员工</button> : null}
          </div>
        ) : messages.map((message, index) => {
          const employee = employees.find((item) => item.id === message.senderId)
          const owner = message.senderKind === 'owner'
          if (message.kind === 'reasoning') {
            return <ReasoningMessage key={message.id} message={message} employee={employee} />
          }
          if (message.kind === 'tool-call' || message.kind === 'tool-result') {
            return <ToolEventMessage key={message.id} message={message} employee={employee} />
          }
          return (
            <article key={message.id} className={`message${owner ? ' message--owner' : ''}`}>
              {owner ? null : (
                <button
                  className="avatar-button"
                  type="button"
                  onClick={() => employee && onOpenDossier(employee.id)}
                  aria-label={`查看${employee?.displayName ?? '员工'}档案`}
                >
                  <Avatar index={employee?.avatarIndex ?? 7} label={employee?.displayName ?? '员工'} />
                </button>
              )}
              <div className="message__body">
                <header className="message__meta">
                  <strong>{owner ? '老板' : employee?.displayName ?? '员工'}</strong>
                  {owner ? null : <span>{employee?.role} · 独立 Agent</span>}
                  <time>{displayTime(message)}</time>
                </header>
                <div className="message__content"><RichText value={message.content} /></div>
                {demoMode && index === 1 ? <ArtifactAttachment onOpen={onOpenArtifact} /> : null}
              </div>
            </article>
          )
        })}
        {liveTurns.map((turn) => <LiveTurn key={`${turn.sessionId}:${turn.agentId}`} turn={turn} employee={employees.find((item) => item.id === turn.agentId)} />)}
        {sending && liveTurns.length === 0 ? <div className="stream-state"><CircleNotch size={16} className="spin" /><span>正在连接员工的独立 Agent…</span><span className="stream-caret" /></div> : null}
      </div>

      <div className="composer-zone">
        <div className="composer">
          {suggestions.length === 0 ? null : (
            <div className="mention-menu" role="listbox" aria-label="当前世界角色">
              {suggestions.map((employee) => (
                <button key={employee.id} type="button" onClick={() => insertMention(employee)}>
                  <Avatar index={employee.avatarIndex} size="sm" label={employee.displayName} />
                  <span><strong>{employee.displayName}</strong><small>{employee.role} · 独立 Agent</small></span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            disabled={employees.length === 0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={employees.length === 0 ? '请先招聘一名员工…' : '@员工 下达任务，或同时点名多人召开协作会…'}
            rows={2}
            aria-label="给当前世界的员工发送消息"
          />
          <div className="composer__toolbar">
            <div>
              <button className="icon-button" type="button" aria-label="添加附件"><Paperclip size={18} /></button>
              <button className="icon-button" type="button" aria-label="插入代码或命令"><BracketsCurly size={18} /></button>
              <span className="composer__hint">Enter 发送 · Shift+Enter 换行 · @ 仅显示当前世界角色</span>
            </div>
            <button className="send-button" type="button" aria-label={sending ? '员工处理中' : '发送'} disabled={sending || employees.length === 0 || !draft.trim()} onClick={() => void submit()}>
              {sending ? <CircleNotch size={19} className="spin" /> : <PaperPlaneRight size={19} weight="fill" />}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function LiveTurn({ turn, employee }: { turn: LiveAgentTurn; employee: CyberEmployee | undefined }) {
  const [reasoningOpen, setReasoningOpen] = useState(true)
  return (
    <article className={`live-turn live-turn--${turn.status}`}>
      <header>
        <span>{turn.status === 'failed' ? <WarningCircle size={16} /> : <CircleNotch size={16} className={turn.status === 'completed' ? '' : 'spin'} />}</span>
        <div><strong>{employee?.displayName ?? '员工'}</strong><small>{liveStatusLabel(turn.status)}</small></div>
      </header>
      {turn.reasoning ? (
        <div className="trace-stack">
          <button className="trace-disclosure" type="button" onClick={() => setReasoningOpen((value) => !value)}>
            <span><TerminalWindow size={15} />实时思考过程</span><CaretDown size={14} className={reasoningOpen ? 'is-open' : ''} />
          </button>
          {reasoningOpen ? <p className="live-turn__reasoning">{turn.reasoning}</p> : null}
        </div>
      ) : null}
      {turn.tools.length > 0 ? <ToolTimeline tools={turn.tools} /> : null}
      {turn.text ? <p className="live-turn__text">{turn.text}<span className="stream-caret" /></p> : null}
    </article>
  )
}

function ReasoningMessage({ message, employee }: { message: WorkMessage; employee: CyberEmployee | undefined }) {
  return (
    <details className="reasoning-message">
      <summary>
        <span><CircleNotch size={14} />{employee?.displayName ?? '员工'}的思考过程</span>
        <span>{displayTime(message)}</span>
      </summary>
      <div>{message.content}</div>
    </details>
  )
}

function ToolEventMessage({ message, employee }: { message: WorkMessage; employee: CyberEmployee | undefined }) {
  const failed = message.metadata.failed === true
  const started = message.kind === 'tool-call'
  const toolName = typeof message.metadata.toolName === 'string' ? message.metadata.toolName : 'tool'
  const callId = typeof message.metadata.callId === 'string' ? message.metadata.callId : message.id
  return (
    <div className={`tool-event-message${failed ? ' is-failed' : ''}`}>
      {failed ? <WarningCircle size={15} /> : started ? <CircleNotch size={15} className="spin" /> : <CheckCircle size={15} weight="fill" />}
      <span><strong>{employee?.displayName ?? '员工'} · {started ? '调用工具' : '工具结果'}</strong><code>{toolName}</code></span>
      <small>{callId}</small>
    </div>
  )
}

function RichText({ value }: { value: string }) {
  return value.split('\n').map((line, lineIndex) => (
    <p key={`${lineIndex}-${line}`}>
      {line.split(/(@[^\s，。；：]+)/g).map((part, partIndex) =>
        part.startsWith('@')
          ? <mark key={`${partIndex}-${part}`}>{part}</mark>
          : <span key={`${partIndex}-${part}`}>{part}</span>,
      )}
    </p>
  ))
}

function ArtifactAttachment({ onOpen }: { onOpen(): void }) {
  return (
    <button className="artifact-attachment" type="button" onClick={onOpen}>
      <span className="artifact-attachment__icon"><BracketsCurly size={18} /></span>
      <span><strong>v0.3.0-架构设计.md</strong><small>1.2 MB · 已保存到世界产物</small></span>
      <span>预览</span>
    </button>
  )
}

function ToolTimeline({ tools }: { tools: ToolStep[] }) {
  return (
    <ol className="tool-timeline">
      {tools.map((tool) => (
        <li key={tool.id} className={`tool-step tool-step--${tool.status}`}>
          <span className="tool-step__rail" />
          {tool.status === 'complete'
            ? <CheckCircle size={16} weight="fill" />
            : <CircleNotch size={16} className="spin" />}
          <span><strong>{tool.label}</strong><code>{tool.target}</code></span>
          <time>{tool.duration ?? '运行中'}</time>
        </li>
      ))}
    </ol>
  )
}

function liveStatusLabel(status: LiveAgentTurn['status']): string {
  return ({ thinking: '正在思考', working: '正在调用工具', completed: '本轮完成', failed: '执行失败' })[status]
}

function displayTime(message: WorkMessage): string {
  const metadataTime = message.metadata.displayTime
  return typeof metadataTime === 'string'
    ? metadataTime
    : new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function participantCount(messages: WorkMessage[]): number {
  return new Set(messages.map((message) => message.senderId)).size
}

function currentMention(value: string): string | undefined {
  const match = /@([^\s@]*)$/.exec(value)
  return match?.[1]
}
