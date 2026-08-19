import {
  BracketsCurly,
  CaretDown,
  CheckCircle,
  CircleNotch,
  PaperPlaneRight,
  Paperclip,
  StopCircle,
  TerminalWindow,
} from '@phosphor-icons/react'
import { useMemo, useRef, useState } from 'react'
import type { WorkMessage, WorkSession } from '@dsh-cyber/contracts'

import type { CyberEmployee, ToolStep } from '../types.js'
import { Avatar } from './Avatar.js'

interface ChatWorkbenchProps {
  session?: WorkSession
  messages: WorkMessage[]
  employees: CyberEmployee[]
  sending: boolean
  draft: string
  onDraftChange(value: string): void
  onSend(prompt: string): Promise<void>
  onStop(): void
  onOpenDossier(employeeId: string): void
}

const demoTools: ToolStep[] = [
  { id: 'read', label: '读取文档', target: 'read_file', status: 'complete', duration: '0.4s' },
  { id: 'search', label: '搜索代码', target: 'search_code', status: 'complete', duration: '0.8s' },
  { id: 'write', label: '写入文件', target: 'write_file', status: 'complete', duration: '0.2s' },
  { id: 'test', label: '运行测试', target: 'run_tests', status: 'complete', duration: '2.1s' },
  { id: 'scan', label: '安全扫描', target: 'sec_scan', status: 'running' },
]

export function ChatWorkbench({
  session,
  messages,
  employees,
  sending,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onOpenDossier,
}: ChatWorkbenchProps) {
  const [traceOpen, setTraceOpen] = useState(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mention = useMemo(() => currentMention(draft), [draft])
  const suggestions = useMemo(() => {
    if (mention === undefined) return []
    return employees.filter((employee) => employee.displayName.includes(mention)).slice(0, 6)
  }, [employees, mention])
  const lastAssistantIndex = messages.findLastIndex((message) => message.kind === 'assistant')

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
            <h2>向当前世界的员工下达任务</h2>
            <p>输入 @员工名 可直接和独立 Agent 对话；同时点名多人会创建真实群组会话。</p>
          </div>
        ) : messages.map((message, index) => {
          const employee = employees.find((item) => item.id === message.senderId)
          const owner = message.senderKind === 'owner'
          if (message.kind === 'reasoning') {
            return <ReasoningMessage key={message.id} message={message} employee={employee} />
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
                {index === 1 ? <ArtifactAttachment /> : null}
                {index === lastAssistantIndex ? (
                  <div className="trace-stack">
                    <button className="trace-disclosure" type="button" onClick={() => setTraceOpen((value) => !value)}>
                      <span><TerminalWindow size={15} />工具调用时间线（{demoTools.length}）</span>
                      <CaretDown size={14} className={traceOpen ? 'is-open' : ''} />
                    </button>
                    {traceOpen ? <ToolTimeline tools={demoTools} /> : null}
                  </div>
                ) : null}
              </div>
            </article>
          )
        })}
        {sending ? (
          <div className="stream-state">
            <CircleNotch size={16} className="spin" />
            <span>员工正在思考并执行任务</span>
            <span className="stream-caret" />
          </div>
        ) : null}
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
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder="@员工 下达任务，或同时点名多人召开协作会…"
            rows={2}
            aria-label="给当前世界的员工发送消息"
          />
          <div className="composer__toolbar">
            <div>
              <button className="icon-button" type="button" aria-label="添加附件"><Paperclip size={18} /></button>
              <button className="icon-button" type="button" aria-label="插入代码或命令"><BracketsCurly size={18} /></button>
              <span className="composer__hint">Enter 发送 · Shift+Enter 换行 · @ 仅显示当前世界角色</span>
            </div>
            {sending ? (
              <button className="send-button send-button--stop" type="button" aria-label="停止生成" onClick={onStop}>
                <StopCircle size={19} weight="fill" />
              </button>
            ) : (
              <button className="send-button" type="button" aria-label="发送" disabled={!draft.trim()} onClick={() => void submit()}>
                <PaperPlaneRight size={19} weight="fill" />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
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

function ArtifactAttachment() {
  return (
    <button className="artifact-attachment" type="button">
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
