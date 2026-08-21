import {
  BracketsCurly,
  CaretDown,
  CheckCircle,
  CircleNotch,
  File as FileIcon,
  PaperPlaneRight,
  Paperclip,
  TerminalWindow,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatAttachment, JsonObject, WorkMessage, WorkSession, World } from '@dsh-cyber/contracts'

import { mentionPlugin } from './mention-plugin.js'

import type { ConversationIntent, CyberEmployee, LiveAgentTurn, ToolStep } from '../types.js'
import { worldExperience } from '../world-experience.js'
import { Avatar } from './Avatar.js'

interface ChatWorkbenchProps {
  demoMode: boolean
  world: World
  session?: WorkSession
  intent?: ConversationIntent
  participantIds?: string[]
  messages: WorkMessage[]
  employees: CyberEmployee[]
  liveTurns: LiveAgentTurn[]
  sending: boolean
  draft: string
  onDraftChange(value: string): void
  onSend(prompt: string, attachments: ChatAttachment[]): Promise<void>
  onUploadAttachment(file: File): Promise<ChatAttachment>
  onOpenDossier(employeeId: string): void
  onOpenArtifact(): void
  onRecruit(): void
}

export function ChatWorkbench({
  demoMode,
  world,
  session,
  intent,
  participantIds = [],
  messages,
  employees,
  liveTurns,
  sending,
  draft,
  onDraftChange,
  onSend,
  onUploadAttachment,
  onOpenDossier,
  onOpenArtifact,
  onRecruit,
}: ChatWorkbenchProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string>()
  const experience = worldExperience(world)
  const mention = useMemo(() => currentMention(draft), [draft])
  const suggestions = useMemo(() => {
    if (mention === undefined) return []
    return employees.filter((employee) => employee.displayName.includes(mention)).slice(0, 6)
  }, [employees, mention])
  const participantEmployees = participantIds
    .map((employeeId) => employees.find((employee) => employee.id === employeeId))
    .filter((employee): employee is CyberEmployee => employee !== undefined)
  const conversationTitle = session?.title ?? intent?.title ?? '选择员工开始对话'
  const conversationKind = session?.kind ?? intent?.kind

  const submit = async () => {
    const prompt = draft.trim()
    if ((!prompt && attachments.length === 0) || sending || uploading) return
    await onSend(prompt || '请查看随消息发送的附件。', attachments)
    setAttachments([])
  }

  const uploadAttachment = async (file: File) => {
    setAttachmentError(undefined)
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      setAttachmentError('附件大小需在 1 byte 到 5 MiB 之间。')
      return
    }
    if (attachments.length >= 8) {
      setAttachmentError('每条消息最多附加 8 个文件。')
      return
    }
    setUploading(true)
    try {
      const attachment = await onUploadAttachment(file)
      setAttachments((current) => [...current, attachment])
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '附件上传失败')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const insertCodeBlock = () => {
    const next = `${draft}${draft && !draft.endsWith('\n') ? '\n' : ''}\`\`\`\n\n\`\`\``
    onDraftChange(next)
    requestAnimationFrame(() => inputRef.current?.focus())
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
    <section className="chat-workbench" aria-label="当前世界多角色会话">
      <header className="chat-header">
        <div className="chat-header__identity">
          <span className="chat-header__avatars" aria-hidden="true">
            {participantEmployees.slice(0, 3).map((employee) => <Avatar key={employee.id} index={employee.avatarIndex} size="sm" label={employee.displayName} />)}
          </span>
          <span>
            <h1>{conversationTitle}</h1>
            <p>{conversationKind === undefined
              ? `从左侧通讯录选择一名${experience.personLabel}，或创建群聊`
              : `${conversationKind === 'group' ? '群聊' : '私聊'} · ${participantEmployees.length} 名成员 · ${world.name}`}</p>
          </span>
        </div>
        <div className="chat-header__count">{messages.length}<span>条消息</span></div>
      </header>

      <div className="message-scroll" aria-live="polite" aria-busy={sending}>
        {messages.length === 0 ? (
          <div className="conversation-empty">
            <TerminalWindow size={34} />
            <h2>{employees.length === 0 ? experience.emptyTitle : conversationKind === 'group' ? '群聊已准备好' : conversationKind === 'direct' ? `开始与${participantEmployees[0]?.displayName ?? experience.personLabel}对话` : '选择联系人开始工作'}</h2>
            <p>{employees.length === 0
              ? experience.emptyCopy
              : conversationKind === 'group'
                ? '发送第一条消息后，群聊和多人协作任务才会正式创建。关闭或切换不会让员工提前进入会议状态。'
                : conversationKind === 'direct'
                  ? '历史记录会保留在当前世界；发送消息后员工才会进入真实任务生命周期。'
                  : '员工像通讯录联系人一样工作：单击私聊，也可以从左上角创建多人群聊。'}</p>
            {employees.length === 0 ? <button className="primary-button" type="button" onClick={onRecruit}>{experience.kind === 'tavern' ? '邀请第一张角色卡' : `添加第一名${experience.personLabel}`}</button> : null}
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
                  aria-label={`查看${employee?.displayName ?? experience.personLabel}档案`}
                >
                  <Avatar index={employee?.avatarIndex ?? 7} label={employee?.displayName ?? '员工'} />
                </button>
              )}
              <div className="message__body">
                <header className="message__meta">
                  <strong>{owner ? (experience.kind === 'tavern' ? '你' : '老板') : employee?.displayName ?? experience.personLabel}</strong>
                  {owner ? null : <span>{employee?.role} · 独立角色</span>}
                  <time>{displayTime(message)}</time>
                </header>
                <div className="message__content"><RichText value={message.content} /></div>
                <MessageAttachments attachments={messageAttachments(message.metadata)} />
                {demoMode && experience.kind === 'company' && index === 1 ? <ArtifactAttachment onOpen={onOpenArtifact} /> : null}
              </div>
            </article>
          )
        })}
        {liveTurns.map((turn) => <LiveTurn key={`${turn.sessionId}:${turn.agentId}`} turn={turn} employee={employees.find((item) => item.id === turn.agentId)} />)}
        {sending && liveTurns.length === 0 ? <div className="stream-state"><CircleNotch size={16} className="spin" /><span>正在连接{experience.personLabel}的独立 Agent…</span><span className="stream-caret" /></div> : null}
      </div>

      <div className="composer-zone">
        <div className="composer">
          {suggestions.length === 0 ? null : (
            <div className="mention-menu" role="listbox" aria-label="当前世界角色">
              {suggestions.map((employee) => (
                <button key={employee.id} type="button" onClick={() => insertMention(employee)}>
                  <Avatar index={employee.avatarIndex} size="sm" label={employee.displayName} />
                  <span><strong>{employee.displayName}</strong><small>{employee.role} · 独立角色</small></span>
                </button>
              ))}
            </div>
          )}
          {attachments.length > 0 ? (
            <div className="composer-attachments" aria-label="待发送附件">
              {attachments.map((attachment) => (
                <span key={attachment.assetId}>
                  <FileIcon size={15} />
                  <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.byteLength)}</small></span>
                  <button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.assetId !== attachment.assetId))}><X size={13} /></button>
                </span>
              ))}
            </div>
          ) : null}
          {attachmentError === undefined ? null : <p className="composer-error" role="alert">{attachmentError}</p>}
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
            placeholder={employees.length === 0
              ? experience.emptyTitle
              : conversationKind === 'group'
                ? `发送消息给 ${participantEmployees.map((employee) => employee.displayName).join('、')}`
                : conversationKind === 'direct'
                  ? `发送消息给 ${participantEmployees[0]?.displayName ?? experience.personLabel}`
                  : '先从左侧选择联系人，或输入 @员工名'}
            rows={2}
            aria-label={`给当前世界的${experience.peopleLabel}发送消息`}
          />
          <div className="composer__toolbar">
            <div>
              <input
                ref={fileInputRef}
                className="composer-file-input"
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.txt,.md,.json,.pdf"
                onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAttachment(file) }}
              />
              <button className="icon-button" type="button" aria-label={uploading ? '正在上传附件' : '添加附件'} disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <CircleNotch size={18} className="spin" /> : <Paperclip size={18} />}</button>
              <button className="icon-button" type="button" aria-label="插入代码或命令" onClick={insertCodeBlock}><BracketsCurly size={18} /></button>
              <span className="composer__hint">Enter 发送 · Shift+Enter 换行 · @ 仅显示当前世界角色</span>
            </div>
            <button className="send-button" type="button" aria-label={sending ? '员工处理中' : '发送'} disabled={sending || uploading || employees.length === 0 || (!draft.trim() && attachments.length === 0)} onClick={() => void submit()}>
              {sending ? <CircleNotch size={19} className="spin" /> : <PaperPlaneRight size={19} weight="fill" />}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) return null
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => attachment.mimeType.startsWith('image/') ? (
        <a key={attachment.assetId} className="message-attachment message-attachment--image" href={attachment.url} target="_blank" rel="noreferrer">
          <img src={attachment.url} alt={attachment.name} />
          <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.byteLength)}</small></span>
        </a>
      ) : (
        <a key={attachment.assetId} className="message-attachment" href={attachment.url} target="_blank" rel="noreferrer">
          <FileIcon size={19} />
          <span><strong>{attachment.name}</strong><small>{attachment.mimeType} · {formatBytes(attachment.byteLength)}</small></span>
          <span>打开</span>
        </a>
      ))}
    </div>
  )
}

function messageAttachments(metadata: JsonObject): ChatAttachment[] {
  const value = metadata.attachments
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const attachment = item as Record<string, unknown>
    return typeof attachment.assetId === 'string' &&
      typeof attachment.name === 'string' &&
      typeof attachment.mimeType === 'string' &&
      typeof attachment.byteLength === 'number' &&
      typeof attachment.url === 'string'
      ? [attachment as unknown as ChatAttachment]
      : []
  })
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
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
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, mentionPlugin]}>{value}</ReactMarkdown>
    </div>
  )
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

function currentMention(value: string): string | undefined {
  const match = /@([^\s@]*)$/.exec(value)
  return match?.[1]
}
