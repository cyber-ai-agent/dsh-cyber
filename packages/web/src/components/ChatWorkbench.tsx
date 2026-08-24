import {
  BracketsCurly,
  CaretDown,
  CircleNotch,
  File as FileIcon,
  PaperPlaneRight,
  Paperclip,
  PuzzlePiece,
  TerminalWindow,
  UserCircle,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatAttachment, InstalledPluginCommand, JsonObject, LocalAssetMimeType, WorkMessage, WorkSession, World } from '@dsh-cyber/contracts'

import { mentionPlugin } from './mention-plugin.js'
import type { ConversationIntent, CyberEmployee } from '../types.js'
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
  installedPlugins?: InstalledPluginCommand[]
  sending?: boolean
  pendingCount?: number
  queuedCount?: number
  draft: string
  focusRequest?: number
  onDraftChange(value: string): void
  onSend(prompt: string, attachments: ChatAttachment[]): Promise<void>
  onUploadAttachment(file: File): Promise<ChatAttachment>
  onOpenDossier(employeeId: string): void
  onOpenArtifact(): void
  onRecruit(): void
  onOpenPluginMarket?(): void
}

export function ChatWorkbench({ demoMode, world, session, intent, participantIds = [], messages, employees, installedPlugins = [], sending = false, pendingCount = 0, queuedCount = 0, draft, focusRequest = 0, onDraftChange, onSend, onUploadAttachment, onOpenDossier, onOpenArtifact, onRecruit, onOpenPluginMarket }: ChatWorkbenchProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string>()
  const experience = worldExperience(world)
  const mention = useMemo(() => currentMention(draft), [draft])
  const suggestions = useMemo(() => mention === undefined ? [] : employees.filter((employee) => employee.displayName.includes(mention)).slice(0, 6), [employees, mention])
  const participantEmployees = participantIds.map((employeeId) => employees.find((employee) => employee.id === employeeId)).filter((employee): employee is CyberEmployee => employee !== undefined)
  const conversationTitle = session?.title ?? intent?.title ?? '选择角色开始对话'
  const conversationKind = session?.kind ?? intent?.kind
  const visibleMessages = useMemo(() => messages.filter(isChatMessage), [messages])

  useEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 160
    if (nearBottom || pendingCount > 0 || sending) container.scrollTop = container.scrollHeight
  }, [visibleMessages, pendingCount, sending])

  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus()
  }, [focusRequest])

  const lastSessionIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (session?.id === undefined || lastSessionIdRef.current === session.id) return
    lastSessionIdRef.current = session.id
    const container = scrollRef.current
    if (container === null) return
    let attempts = 0
    const timer = window.setInterval(() => {
      container.scrollTop = container.scrollHeight
      attempts += 1
      if (container.scrollHeight - container.scrollTop - container.clientHeight <= 2 || attempts >= 20) window.clearInterval(timer)
    }, 100)
    return () => window.clearInterval(timer)
  }, [session?.id])

  const submit = async () => {
    const prompt = draft.trim()
    if ((!prompt && attachments.length === 0) || sending || uploading) return
    await onSend(prompt || '请查看随消息发送的附件。', attachments)
    setAttachments([])
  }

  const uploadAttachment = async (file: File) => {
    setAttachmentError(undefined)
    if (file.size < 1 || file.size > 5 * 1024 * 1024) { setAttachmentError('附件大小需在 1 byte 到 5 MiB 之间。'); return }
    if (attachments.length >= 8) { setAttachmentError('每条消息最多附加 8 个文件。'); return }
    setUploading(true)
    try {
      const attachment = demoMode ? await onUploadAttachment(file) : await uploadWorldAttachment(world.id, file)
      setAttachments((current) => [...current, attachment])
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '附件上传失败')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const insertMention = (employee: CyberEmployee) => {
    const marker = draft.lastIndexOf('@')
    onDraftChange(marker < 0 ? `${draft}@${employee.displayName} ` : `${draft.slice(0, marker)}@${employee.displayName} `)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <section className="chat-workbench" aria-label="当前世界多角色会话">
      <header className="chat-header">
        <div className="chat-header__identity">
          <span className="chat-header__avatars" aria-hidden="true">{participantEmployees.slice(0, 3).map((employee) => <Avatar key={employee.id} index={employee.avatarIndex} size="sm" label={employee.displayName} />)}</span>
          <span><h1>{conversationTitle}</h1><p>{conversationKind === undefined ? `从左侧会话列表进入私聊，或创建群聊` : `${conversationKind === 'group' ? '群聊' : '私聊'} · ${participantEmployees.length} 名成员 · ${world.name}`}</p></span>
        </div>
        <div className="chat-header__count"><span>{visibleMessages.length} 条消息</span></div>
      </header>

      <div className="message-scroll" ref={scrollRef} aria-live="polite" aria-busy={pendingCount > 0 || sending}>
        {visibleMessages.length === 0 ? (
          <div className="conversation-empty">
            <TerminalWindow size={34} />
            <h2>{employees.length === 0 ? experience.emptyTitle : conversationKind === 'group' ? '群聊已准备好' : conversationKind === 'direct' ? `开始与${participantEmployees[0]?.displayName ?? experience.personLabel}对话` : '选择会话开始互动'}</h2>
            <p>{employees.length === 0 ? experience.emptyCopy : conversationKind === 'group' ? '发送第一条消息后，群聊和多人协作才会正式创建。关闭或切换不会让角色提前进入会议状态。' : conversationKind === 'direct' ? '历史记录会保留在当前世界；发送消息后角色才会进入真实运行过程。' : '左侧只保留会话：每个角色固定一个私聊，也可以创建多人群聊；角色新增与管理统一在右侧档案。'}</p>
          </div>
        ) : visibleMessages.map((message, index) => {
          const employee = employees.find((item) => item.id === message.senderId)
          const owner = message.senderKind === 'owner'
          const streaming = message.metadata.streaming === true
          if (message.kind === 'system') return <div key={message.id} className="chat-system-notice" role="status">{message.content}</div>
          return (
            <article key={message.id} className={`message${owner ? ' message--owner' : ''}${streaming ? ' message--streaming' : ''}`}>
              {owner ? null : <button className="avatar-button" type="button" onClick={() => employee && onOpenDossier(employee.id)} aria-label={`查看${employee?.displayName ?? experience.personLabel}档案`}><Avatar index={employee?.avatarIndex ?? 7} label={employee?.displayName ?? '角色'} /></button>}
              <div className="message__body">
                <header className="message__meta">{owner ? <span className="sr-only">我的消息</span> : <><strong>{employee?.displayName ?? experience.personLabel}</strong><span>{employee?.role}</span></>}<time>{displayTime(message)}</time></header>
                <div className="message__content">{streaming && message.content.length === 0 ? <span className="stream-placeholder">正在生成回复…</span> : <RichText value={message.content} />}{streaming ? <span className="stream-cursor" aria-hidden="true" /> : null}</div>
                <MessageAttachments attachments={messageAttachments(message.metadata)} />
                {demoMode && experience.kind === 'company' && index === 1 ? <ArtifactAttachment onOpen={onOpenArtifact} /> : null}
              </div>
              {owner ? <span className="owner-avatar" role="img" aria-label="我的头像"><UserCircle size={28} weight="fill" /></span> : null}
            </article>
          )
        })}
        {pendingCount > 0 ? <div className="stream-state" role="status"><CircleNotch size={16} className="spin" /><span>角色正在回复，你可以继续补充，也可以切换到其他会话。</span>{queuedCount > 0 ? <strong>另有 {queuedCount} 条已排队</strong> : null}</div> : sending ? <div className="stream-state" role="status"><CircleNotch size={16} className="spin" /><span>处理中…</span></div> : null}
      </div>

      <div className="composer-zone"><div className="composer">
        {suggestions.length === 0 ? null : <div className="mention-menu" role="listbox" aria-label="当前世界角色">{suggestions.map((employee) => <button key={employee.id} type="button" onClick={() => insertMention(employee)}><Avatar index={employee.avatarIndex} size="sm" label={employee.displayName} /><span><strong>{employee.displayName}</strong><small>{employee.role} · 独立角色</small></span></button>)}</div>}
        {attachments.length > 0 ? <div className="composer-attachments" aria-label="待发送附件">{attachments.map((attachment) => <span key={attachment.assetId}><FileIcon size={15} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.byteLength)}</small></span><button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.assetId !== attachment.assetId))}><X size={13} /></button></span>)}</div> : null}
        {attachmentError === undefined ? null : <p className="composer-error" role="alert">{attachmentError}</p>}
        <textarea ref={inputRef} value={draft} onChange={(event) => onDraftChange(event.target.value)} disabled={employees.length === 0} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} placeholder={employees.length === 0 ? experience.emptyTitle : conversationKind === 'group' ? `发送消息给 ${participantEmployees.map((employee) => employee.displayName).join('、')}` : conversationKind === 'direct' ? `发送消息给 ${participantEmployees[0]?.displayName ?? experience.personLabel}` : '先从左侧选择会话，或输入 @角色名'} rows={2} aria-label={`给当前世界的${experience.peopleLabel}发送消息`} />
        <div className="composer__toolbar"><div>
          <input ref={fileInputRef} className="composer-file-input" type="file" accept=".png,.jpg,.jpeg,.webp,.txt,.md,.json,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAttachment(file) }} />
          <button className="icon-button" type="button" aria-label={uploading ? '正在上传附件' : '添加附件'} disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <CircleNotch size={18} className="spin" /> : <Paperclip size={18} />}</button>
          <PluginPicker plugins={installedPlugins} draft={draft} onDraftChange={onDraftChange} {...(onOpenPluginMarket === undefined ? {} : { onOpenMarket: onOpenPluginMarket })} onFocus={() => inputRef.current?.focus()} />
        </div><button className="send-button" type="button" aria-label={sending ? '角色处理中' : '发送'} disabled={sending || uploading || employees.length === 0 || (!draft.trim() && attachments.length === 0)} onClick={() => void submit()}>{sending ? <CircleNotch size={19} className="spin" /> : <PaperPlaneRight size={19} weight="fill" />}{queuedCount > 0 ? <span className="send-button__queue" aria-label={`${queuedCount} 条消息已排队`}>{queuedCount}</span> : null}</button></div>
      </div></div>
    </section>
  )
}

function PluginPicker({ plugins, draft, onDraftChange, onOpenMarket, onFocus }: { plugins: InstalledPluginCommand[]; draft: string; onDraftChange(value: string): void; onOpenMarket?: () => void; onFocus(): void }) {
  return (
    <details className="composer-plugin-picker">
      <summary aria-label="打开已安装插件"><PuzzlePiece size={17} /><span>插件</span>{plugins.length > 0 ? <b>{plugins.length}</b> : null}<CaretDown size={13} /></summary>
      <div className="composer-plugin-picker__menu" role="menu" aria-label="已安装插件">
        <header><strong>已安装插件</strong><span>点击后把指令放入输入框</span></header>
        {plugins.length === 0 ? <div className="composer-plugin-picker__empty"><PuzzlePiece size={22} /><span>还没有可用插件</span>{onOpenMarket === undefined ? null : <button type="button" onClick={onOpenMarket}>前往插件市场</button>}</div> : plugins.map((plugin) => {
          const copy = pluginCopy(plugin)
          const automatic = plugin.automatic || plugin.trigger === 'always'
          return <button key={`${plugin.packageId}:${plugin.packageVersion}:${plugin.trigger}`} className="composer-plugin-picker__item" type="button" role="menuitem" disabled={automatic} onClick={(event) => { onDraftChange(insertPluginTrigger(draft, plugin.displayTrigger)); event.currentTarget.closest('details')?.removeAttribute('open'); onFocus() }}>
            <span className="composer-plugin-picker__icon"><PuzzlePiece size={17} weight="duotone" /></span>
            <span className="composer-plugin-picker__copy"><strong>{copy.name}</strong><small>{copy.description}</small><code>{automatic ? '自动运行' : plugin.displayTrigger}</code></span>
            <span className="composer-plugin-picker__version">v{plugin.packageVersion}</span>
          </button>
        })}
      </div>
    </details>
  )
}

function insertPluginTrigger(draft: string, trigger: string): string {
  if (trigger === 'always') return draft
  const separator = draft.trim().length === 0 ? '' : ' '
  return `${draft.trimEnd()}${separator}${trigger} `
}

function pluginCopy(plugin: InstalledPluginCommand): { name: string; description: string } {
  const localized: Record<string, { name: string; description: string }> = {
    'official-decision-log': { name: '决策记录', description: '整理背景、决策、取舍与复核事项。' },
    'official-meeting-notes': { name: '会议纪要助手', description: '整理会议事实、行动项和风险。' },
    'official-release-check': { name: '发布检查', description: '检查阻断项、证据、风险与回滚。' },
    'official-research-brief': { name: '研究简报', description: '整理结论、证据、不确定性和下一步。' },
  }
  return localized[plugin.packageId] ?? { name: plugin.displayName, description: plugin.description || plugin.summary }
}

async function uploadWorldAttachment(worldId: string, file: File): Promise<ChatAttachment> {
  const mimeType = attachmentMimeType(file)
  const response = await fetch(`/api/worlds/${encodeURIComponent(worldId)}/assets/attachment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mimeType, dataBase64: await fileToBase64(file) }),
  })
  const result = await response.json() as { attachment?: ChatAttachment; error?: { message?: string } }
  if (!response.ok || result.attachment === undefined) throw new Error(result.error?.message ?? '世界附件上传失败')
  return result.attachment
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

function attachmentMimeType(file: File): LocalAssetMimeType {
  const supported: LocalAssetMimeType[] = ['image/png','image/jpeg','image/webp','text/plain','text/markdown','application/json','application/pdf']
  const declared = file.type.toLowerCase()
  if (supported.includes(declared as LocalAssetMimeType)) return declared as LocalAssetMimeType
  const extension = file.name.toLowerCase().split('.').pop()
  const byExtension: Record<string, LocalAssetMimeType> = { png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',txt:'text/plain',md:'text/markdown',json:'application/json',pdf:'application/pdf' }
  const inferred = extension === undefined ? undefined : byExtension[extension]
  if (inferred === undefined) throw new Error('仅支持 PNG、JPEG、WebP、TXT、Markdown、JSON 和 PDF 附件。')
  return inferred
}

function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) return null
  return <div className="message-attachments">{attachments.map((attachment) => attachment.mimeType.startsWith('image/') ? <a key={attachment.assetId} className="message-attachment message-attachment--image" href={attachment.url} target="_blank" rel="noreferrer"><img src={attachment.url} alt={attachment.name} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.byteLength)}</small></span></a> : <a key={attachment.assetId} className="message-attachment" href={attachment.url} target="_blank" rel="noreferrer"><FileIcon size={19} /><span><strong>{attachment.name}</strong><small>{attachment.mimeType} · {formatBytes(attachment.byteLength)}</small></span><span>打开</span></a>)}</div>
}

function messageAttachments(metadata: JsonObject): ChatAttachment[] {
  const value = metadata.attachments
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const attachment = item as Record<string, unknown>
    return typeof attachment.assetId === 'string' && typeof attachment.name === 'string' && typeof attachment.mimeType === 'string' && typeof attachment.byteLength === 'number' && typeof attachment.url === 'string' ? [attachment as unknown as ChatAttachment] : []
  })
}

function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB` }

function RichText({ value }: { value: string }) { return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm, mentionPlugin]}>{value}</ReactMarkdown></div> }
function ArtifactAttachment({ onOpen }: { onOpen(): void }) { return <button className="artifact-attachment" type="button" onClick={onOpen}><span className="artifact-attachment__icon"><BracketsCurly size={18} /></span><span><strong>v0.3.0-架构设计.md</strong><small>1.2 MB · 已保存到世界产物</small></span><span>预览</span></button> }
function displayTime(message: WorkMessage): string { const metadataTime = message.metadata.displayTime; return typeof metadataTime === 'string' ? metadataTime : new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }
function currentMention(value: string): string | undefined { return /@([^\s@]*)$/.exec(value)?.[1] }
export function isChatMessage(message: WorkMessage): boolean {
  if (message.kind === 'user' || message.kind === 'assistant') return true
  return message.kind === 'system' && message.metadata.productNotice === true
}
