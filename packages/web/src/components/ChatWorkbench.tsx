import {
  ArrowUp,
  CircleNotch,
  ClockCounterClockwise,
  Copy,
  File as FileIcon,
  PaperPlaneRight,
  Paperclip,
  Stop,
  TerminalWindow,
  UserCircle,
  X,
} from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { WORLD_CHARACTER_MANAGEMENT_PERMISSIONS, type ChatAttachment, type CompletionJob, type InstalledPluginCommand, type JsonObject, type LocalAssetMimeType, type WorkMessage, type WorkSession, type World, type WorldCharacterPermission, type WorldPermissionDecisionScope, type WorldPermissionRequest } from '@dsh-cyber/contracts'

import { api } from '../api.js'
import type { ConversationIntent, CyberEmployee } from '../types.js'
import type { PendingChatTurn } from '../chat-realtime.js'
import type { ChatQueueMode } from '../chat-realtime.js'
import { worldExperience } from '../world-experience.js'
import { ApprovalRequests, type ApprovalRequestsProps } from './ApprovalRequests.js'
import { Avatar, GroupAvatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { CommandPicker } from './CommandPicker.js'
import { ContextMenu, type ContextMenuPosition } from './ContextMenu.js'
import { collaborationModeOf } from './group-collaboration.js'
import { ConversationPermissionControl, type ConversationPermissionMode } from './ConversationPermissionControl.js'
import { TaskCollaborationSummary } from './TaskCollaborationSummary.js'

const MarkdownMessage = lazy(async () => ({ default: (await import('./MarkdownMessage.js')).MarkdownMessage }))
const ArtifactReferenceCards = lazy(async () => ({ default: (await import('../features/artifacts/ArtifactCenter.js')).ArtifactReferenceCards }))

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
  queueItems?: PendingChatTurn[]
  draft: string
  focusRequest?: number
  onDraftChange(value: string): void
  onSend(prompt: string, attachments: ChatAttachment[], queueMode?: ChatQueueMode): Promise<void>
  onUploadAttachment(file: File): Promise<ChatAttachment>
  onOpenDossier(employeeId: string): void
  onOpenArtifact(artifactId?: string): void
  onRetryCompletionJob?(jobId: string): Promise<void>
  onCompletionJobSettled?(): void
  onRecruit(): void
  onOpenPluginMarket?(): void
  onOpenHistory?(): void
  hasOlderMessages?: boolean
  loadingOlderMessages?: boolean
  onLoadOlderMessages?(): void
  /** Real-world actions this world is holding until a person decides. */
  approvals?: ApprovalRequestsProps['items']
  onDecideApproval?: ApprovalRequestsProps['onDecide']
  permissionRequests?: WorldPermissionRequest[]
  onDecideWorldPermissionRequest?(requestId: string, scope: WorldPermissionDecisionScope | 'reject'): Promise<void>
  permissionMode?: ConversationPermissionMode
  onChangePermissionMode?(mode: ConversationPermissionMode): void
  onRequestFullAccess?(): void
  onChangeCollaborationMode?(mode: 'discussion' | 'task'): Promise<void>
  onCancelQueuedTurn?(turnId: string): Promise<void>
  onPromoteQueuedTurn?(turnId: string): Promise<void>
  onStopTurn?(turnId: string): Promise<void>
}

export function ChatWorkbench({ demoMode, world, session, intent, participantIds = [], messages, employees, installedPlugins = [], sending = false, pendingCount = 0, queuedCount = 0, queueItems = [], draft, focusRequest = 0, onDraftChange, onSend, onUploadAttachment, onOpenDossier, onOpenArtifact, onRetryCompletionJob, onCompletionJobSettled, onRecruit, onOpenPluginMarket, onOpenHistory, hasOlderMessages = false, loadingOlderMessages = false, onLoadOlderMessages, approvals = [], onDecideApproval, permissionRequests = [], onDecideWorldPermissionRequest, permissionMode = 'read-only', onChangePermissionMode, onRequestFullAccess, onChangeCollaborationMode, onCancelQueuedTurn, onPromoteQueuedTurn, onStopTurn }: ChatWorkbenchProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string>()
  const [messageMenu, setMessageMenu] = useState<{ message: WorkMessage; position: ContextMenuPosition }>()
  const [rememberingMessageId, setRememberingMessageId] = useState<string>()
  const [rememberedMessageIds, setRememberedMessageIds] = useState<Set<string>>(() => new Set())
  const [knowledgeError, setKnowledgeError] = useState<string>()
  const [copiedMessageId, setCopiedMessageId] = useState<string>()
  const [copyError, setCopyError] = useState<string>()
  const [queueMode, setQueueMode] = useState<ChatQueueMode>('normal')
  const [topicNotice, setTopicNotice] = useState(false)
  const experience = worldExperience(world)
  const mention = useMemo(() => currentMention(draft), [draft])
  const suggestions = useMemo(() => mention === undefined ? [] : employees.filter((employee) => employee.displayName.includes(mention)).slice(0, 6), [employees, mention])
  const participantEmployees = participantIds.map((employeeId) => employees.find((employee) => employee.id === employeeId)).filter((employee): employee is CyberEmployee => employee !== undefined)
  const conversationKind = session?.kind ?? intent?.kind
  const collaborationMode = conversationKind === 'group' ? collaborationModeOf(session ?? intent) : 'discussion'
  const directEmployee = conversationKind === 'direct' ? participantEmployees[0] : undefined
  const conversationTitle = conversationKind === 'direct'
    ? directEmployee?.displayName ?? displayDirectConversationTitle(session?.title ?? intent?.title) ?? '选择角色开始对话'
    : session?.title ?? intent?.title ?? '选择角色开始对话'
  const visibleMessages = useMemo(() => messages.filter(isChatMessage), [messages])
  const runningLaneCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const turn of queueItems) if (turn.status === 'running') for (const employeeId of turn.employeeIds) counts.set(employeeId, (counts.get(employeeId) ?? 0) + 1)
    return counts
  }, [queueItems])
  const saturatedWaiting = queueItems.some((turn) => turn.status === 'queued' && turn.employeeIds.some((employeeId) => (runningLaneCounts.get(employeeId) ?? 0) >= 2))
  const activeTurn = useMemo(() => queueItems.find((turn) => turn.status === 'running' || turn.status === 'waiting-approval'), [queueItems])
  const canStopCurrentTurn = activeTurn !== undefined && onStopTurn !== undefined
  const hasQueueActions = pendingCount > 0 || queuedCount > 0 || queueItems.some((turn) => turn.status === 'running' || turn.status === 'waiting-approval' || turn.status === 'queued')

  useEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 160
    if (nearBottom || pendingCount > 0 || sending) container.scrollTop = container.scrollHeight
  }, [visibleMessages, pendingCount, sending])

  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus()
  }, [focusRequest])

  useEffect(() => {
    setTopicNotice(false)
  }, [session?.id])

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

  const executeLocalCommand = async (prompt: string): Promise<boolean> => {
    const command = prompt.split(/\s+/, 1)[0]
    if (command === '/换个话题') {
      setTopicNotice(true)
      onDraftChange('')
      setAttachments([])
      setQueueMode('normal')
      return true
    }
    if (command === '/查看历史') {
      onOpenHistory?.()
      onDraftChange('')
      return true
    }
    if (command === '/清空输入') {
      onDraftChange('')
      setAttachments([])
      setQueueMode('normal')
      return true
    }
    if (command === '/停止回复') {
      if (canStopCurrentTurn && activeTurn !== undefined && onStopTurn !== undefined) await onStopTurn(activeTurn.id)
      onDraftChange('')
      return true
    }
    const skillMatch = /^\/技能\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(prompt)
    if (skillMatch !== null) {
      const skillName = skillMatch[1] ?? '当前技能'
      const task = skillMatch[2]?.trim() ?? ''
      if (task.length === 0) {
        onDraftChange(`请告诉我需要使用“${skillName}”技能处理什么。`)
        return true
      }
      await onSend(`请使用“${skillName}”技能处理以下内容：\n${task}`, attachments, queueMode)
      setAttachments([])
      setQueueMode('normal')
      return true
    }
    return false
  }

  const submit = async () => {
    const prompt = draft.trim()
    if ((!prompt && attachments.length === 0) || uploading) return
    if (prompt.length > 0 && await executeLocalCommand(prompt)) return
    await onSend(prompt || '请查看随消息发送的附件。', attachments, queueMode)
    setAttachments([])
    setQueueMode('normal')
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

  const rememberMessage = async (message: WorkMessage) => {
    if (session === undefined || rememberingMessageId !== undefined || rememberedMessageIds.has(message.id)) return
    setMessageMenu(undefined)
    setKnowledgeError(undefined)
    setRememberingMessageId(message.id)
    try {
      const response = await fetch(`/api/worlds/${encodeURIComponent(world.id)}/knowledge/consolidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: 'conversation',
          sourceId: session.id,
          fromCursor: Math.max(0, message.sequence - 1),
          toCursor: message.sequence,
        }),
      })
      const result = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(result.error?.message ?? '这条消息暂时无法加入长期知识')
      setRememberedMessageIds((current) => new Set(current).add(message.id))
    } catch (cause) {
      setKnowledgeError(cause instanceof Error ? cause.message : '这条消息暂时无法加入长期知识')
    } finally {
      setRememberingMessageId(undefined)
    }
  }

  const copyMessage = async (message: WorkMessage) => {
    setMessageMenu(undefined)
    setCopyError(undefined)
    if (await copyTextToClipboard(message.content)) {
      setCopiedMessageId(message.id)
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? undefined : current), 1_600)
      return
    }
    setCopyError('复制回复失败，请检查剪贴板权限')
  }

  return (
    <section className={`chat-workbench${visibleMessages.length > 0 ? ' has-messages' : ''}`} aria-label="当前世界多角色会话">
      <div className="skin-stage" aria-hidden="true">
        <div className="skin-stage__backdrop" />
        <div className="skin-stage__character skin-stage__character--left" />
        <div className="skin-stage__character skin-stage__character--right" />
      </div>
      <header className="chat-header">
        <div className="chat-header__identity">
          <span className={`chat-header__avatars${conversationKind === 'group' || conversationKind === 'meeting' ? ' chat-header__avatars--group' : ''}`} aria-hidden={directEmployee === undefined}>
            {directEmployee !== undefined
              ? <button className="chat-header__avatar-button" type="button" onClick={() => onOpenDossier(directEmployee.id)} aria-label={`打开${directEmployee.displayName}角色`} title={`打开${directEmployee.displayName}角色`}><Avatar index={directEmployee.avatarIndex} size="sm" label={directEmployee.displayName} authorityRole={directEmployee.authorityRole} /></button>
              : <GroupAvatar participants={participantEmployees} size="md" />}
          </span>
          <span><h1>{conversationTitle}{conversationKind === 'direct' ? <AuthorityBadge role={directEmployee?.authorityRole} /> : null}</h1><p>{conversationKind === undefined ? `从左侧会话列表进入私聊，或创建群聊` : `${conversationKind === 'group' ? collaborationMode === 'task' ? '协作' : '讨论' : '私聊'} · ${world.name}`}</p></span>
          {conversationKind === 'group' && onChangeCollaborationMode !== undefined ? <div className="chat-header__collaboration-mode" role="group" aria-label="群聊协作模式"><button type="button" className={collaborationMode === 'discussion' ? 'is-active' : ''} aria-pressed={collaborationMode === 'discussion'} onClick={() => void onChangeCollaborationMode('discussion')}>讨论</button><button type="button" className={collaborationMode === 'task' ? 'is-active' : ''} aria-pressed={collaborationMode === 'task'} onClick={() => void onChangeCollaborationMode('task')}>协作</button></div> : null}
        </div>
        <div className="chat-header__actions">
          {onOpenHistory === undefined || session === undefined ? null : <button className="chat-header__history" type="button" aria-label="查看历史消息" title="查看历史消息" onClick={onOpenHistory}><ClockCounterClockwise size={19} /><span>历史消息</span></button>}
        </div>
      </header>

      <div className="message-scroll" ref={scrollRef} aria-live="polite" aria-busy={pendingCount > 0 || sending}>
        <div className="conversation-column">
          {queueItems.length > 0 ? <div className="chat-turn-queue" aria-label="消息队列">{saturatedWaiting ? <p className="chat-turn-queue__lane-note" role="status">同一角色已有 2 条通道运行，第三条消息等待中</p> : null}{queueItems.map((turn) => <article key={turn.id} className={`chat-turn-queue__item chat-turn-queue__item--${turn.status}`}><div><strong>{turn.status === 'running' ? '正在回复中' : turn.status === 'waiting-approval' ? '等待批准' : turn.status === 'queued' ? '等待中' : turn.status === 'interrupted' ? '已停止' : turn.status === 'cancelled' ? '已撤销' : '发送失败'}</strong><small>{turn.title}</small></div><span>{(turn.status === 'running' || turn.status === 'waiting-approval') && onStopTurn !== undefined ? <button type="button" onClick={() => void onStopTurn(turn.id)}>■ 停止</button> : turn.status === 'queued' && onPromoteQueuedTurn !== undefined ? <button type="button" onClick={() => void onPromoteQueuedTurn(turn.id)}>插入</button> : null}{turn.status === 'queued' && onCancelQueuedTurn !== undefined ? <button type="button" onClick={() => void onCancelQueuedTurn(turn.id)}>撤销</button> : null}</span></article>)}</div> : null}
          {conversationKind === 'group' && collaborationMode === 'task' && session?.id !== undefined ? <TaskCollaborationSummary worldId={world.id} sessionId={session.id} employees={participantEmployees} demoMode={demoMode} /> : null}
          {hasOlderMessages && onLoadOlderMessages !== undefined ? <button className="message-history-more" type="button" disabled={loadingOlderMessages} onClick={onLoadOlderMessages}>{loadingOlderMessages ? <CircleNotch size={15} className="spin" /> : <ArrowUp size={15} />}<span>{loadingOlderMessages ? '正在加载更早消息…' : '加载更早消息'}</span></button> : null}
          {visibleMessages.length === 0 ? (
            <div className="conversation-empty">
              <TerminalWindow size={34} />
              <h2>{employees.length === 0 ? experience.emptyTitle : conversationKind === 'group' ? '群聊已准备好' : conversationKind === 'direct' ? `开始与${participantEmployees[0]?.displayName ?? experience.personLabel}对话` : '选择会话开始互动'}</h2>
              <p>{employees.length === 0 ? experience.emptyCopy : conversationKind === 'group' ? collaborationMode === 'task' ? '协作已经创建，发送目标后按分工推进；详细执行过程请查看轨迹。' : '讨论已经创建并保存在当前世界，发送消息开始多人讨论。' : conversationKind === 'direct' ? '历史记录会保留在当前世界；发送消息后角色才会进入真实运行过程。' : '左侧只保留会话：每个角色固定一个私聊，也可以创建多人群聊；角色新增与管理统一在右侧角色。'}</p>
            </div>
          ) : visibleMessages.map((message) => {
            const employee = employees.find((item) => item.id === message.senderId)
            const owner = message.senderKind === 'owner'
            const streaming = message.metadata.streaming === true
            if (message.kind === 'system') return <div key={message.id} className="chat-system-notice" role="status">{message.content}</div>
            return (
              <article key={message.id} className={`message${owner ? ' message--owner' : ''}${streaming ? ' message--streaming' : ''}`} onContextMenu={(event) => { if (streaming) return; event.preventDefault(); setMessageMenu({ message, position: { x: event.clientX, y: event.clientY } }) }} onKeyDown={(event) => { if (streaming || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMessageMenu({ message, position: { x: rect.left + Math.min(rect.width, 220), y: rect.top + 28 } }) }} tabIndex={streaming ? undefined : 0}>
                {owner ? null : <button className="avatar-button" type="button" onClick={() => employee && onOpenDossier(employee.id)} aria-label={`打开${employee?.displayName ?? experience.personLabel}角色`}><Avatar index={employee?.avatarIndex ?? 7} label={employee?.displayName ?? '角色'} authorityRole={employee?.authorityRole} /></button>}
                <div className="message__body">
                  <header className="message__meta">{owner ? <span className="sr-only">我的消息</span> : <><strong>{employee?.displayName ?? experience.personLabel}<AuthorityBadge role={employee?.authorityRole} /></strong><span>{employee?.role}</span></>}<time>{displayTime(message)}</time>{copiedMessageId === message.id ? <span role="status">已复制</span> : rememberingMessageId === message.id ? <span role="status">正在整理…</span> : rememberedMessageIds.has(message.id) ? <span role="status">已加入长期知识</span> : null}</header>
                  <div className="message__content">{streaming && message.content.length === 0 ? <span className="stream-placeholder">正在回复中…</span> : <RichText value={message.content} worldId={world.id} />}{streaming ? <span className="stream-cursor" aria-hidden="true" /> : null}</div>
                  <MessageAttachments attachments={messageAttachments(message.metadata)} />
                  <CompletionJobStatus metadata={message.metadata} {...(onRetryCompletionJob === undefined ? {} : { onRetry: onRetryCompletionJob })} {...(onCompletionJobSettled === undefined ? {} : { onSettled: onCompletionJobSettled })} />
                  {artifactRefsFromMetadata(message.metadata).length === 0 ? null : <Suspense fallback={<div className="chat-artifact-refs" role="status">正在载入产物卡…</div>}><ArtifactReferenceCards worldId={world.id} artifactRefs={artifactRefsFromMetadata(message.metadata)} onOpen={onOpenArtifact} /></Suspense>}
                </div>
                {owner ? <span className="owner-avatar" role="img" aria-label="我的头像"><UserCircle size={28} weight="fill" /></span> : null}
              </article>
            )
          })}
          {pendingCount > 0 ? <div className="stream-state" role="status"><CircleNotch size={16} className="spin" /><span>正在回复中，你可以继续补充，也可以切换到其他会话。</span>{queuedCount > 0 ? <strong>另有 {queuedCount} 条已排队</strong> : null}</div> : sending ? <div className="stream-state" role="status"><CircleNotch size={16} className="spin" /><span>正在回复中…</span></div> : null}
        </div>
      </div>

      {messageMenu === undefined ? null : <ContextMenu label="消息操作" position={messageMenu.position} onClose={() => setMessageMenu(undefined)} items={[
        ...(messageMenu.message.senderKind === 'employee' && messageMenu.message.content.trim().length > 0 ? [{
          id: 'copy-message',
          label: copiedMessageId === messageMenu.message.id ? '已复制' : '复制回复',
          description: '复制这条回复的完整内容到剪贴板',
          icon: <Copy size={17} />,
          disabled: copiedMessageId === messageMenu.message.id,
          onSelect: () => { void copyMessage(messageMenu.message) },
        }] : []),
        {
          id: 'remember-message',
          label: rememberedMessageIds.has(messageMenu.message.id) ? '已加入长期知识' : '加入长期知识',
          description: '引用这条消息作为证据，在后台整理为可追溯知识',
          icon: <ClockCounterClockwise size={17} />,
          disabled: rememberingMessageId !== undefined || rememberedMessageIds.has(messageMenu.message.id),
          onSelect: () => { void rememberMessage(messageMenu.message) },
        },
      ]} />}
      <div className="composer-zone">
        {copyError === undefined ? null : <div className="chat-knowledge-error" role="alert"><span>{copyError}</span><button type="button" onClick={() => setCopyError(undefined)} aria-label="关闭提示"><X size={14} /></button></div>}
        {knowledgeError === undefined ? null : <div className="chat-knowledge-error" role="alert"><span>{knowledgeError}</span><button type="button" onClick={() => setKnowledgeError(undefined)} aria-label="关闭提示"><X size={14} /></button></div>}
        {onDecideWorldPermissionRequest === undefined ? null : <WorldPermissionRequests items={permissionRequests} employees={employees} activeSessionId={session?.id} onDecide={onDecideWorldPermissionRequest} />}
        {onDecideApproval === undefined ? null : <ApprovalRequests items={approvals} onDecide={onDecideApproval} />}
        {topicNotice ? <div className="composer-topic-notice" role="status"><span>已开启新话题，之前的对话记录已保留</span></div> : null}
        <div className="composer">
        {suggestions.length === 0 ? null : <div className="mention-menu" role="listbox" aria-label="当前世界角色">{suggestions.map((employee) => <button key={employee.id} type="button" onClick={() => insertMention(employee)}><Avatar index={employee.avatarIndex} size="sm" label={employee.displayName} authorityRole={employee.authorityRole} /><span><strong>{employee.displayName}<AuthorityBadge role={employee.authorityRole} /></strong><small>{employee.role} · 独立角色</small></span></button>)}</div>}
        {attachments.length > 0 ? <div className="composer-attachments" aria-label="待发送附件">{attachments.map((attachment) => <span key={attachment.assetId}><FileIcon size={15} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.byteLength)}</small></span><button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.assetId !== attachment.assetId))}><X size={13} /></button></span>)}</div> : null}
        {attachmentError === undefined ? null : <p className="composer-error" role="alert">{attachmentError}</p>}
        <textarea ref={inputRef} value={draft} onChange={(event) => onDraftChange(event.target.value)} disabled={employees.length === 0} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} placeholder={employees.length === 0 ? experience.emptyTitle : conversationKind === 'group' ? `发送消息给 ${participantEmployees.map((employee) => employee.displayName).join('、')}` : conversationKind === 'direct' ? `发送消息给 ${participantEmployees[0]?.displayName ?? experience.personLabel}` : '先从左侧选择会话，或输入 @角色名'} rows={2} aria-label={`给当前世界的${experience.peopleLabel}发送消息`} />
        <div className="composer__toolbar">{hasQueueActions ? <div className="composer__queue-mode" role="group" aria-label="队列操作"><button type="button" aria-label="排队发送" title="排队发送" className={queueMode === 'normal' ? 'is-active' : ''} aria-pressed={queueMode === 'normal'} onClick={() => setQueueMode('normal')}>排队</button><button type="button" aria-label="插入队列前方" title="插入队列前方" className={queueMode === 'next' ? 'is-active' : ''} aria-pressed={queueMode === 'next'} onClick={() => setQueueMode('next')}>插入</button></div> : null}<div>
          {onChangePermissionMode === undefined ? null : <ConversationPermissionControl value={permissionMode} onChange={onChangePermissionMode} {...(onRequestFullAccess === undefined ? {} : { onRequestFullAccess })} />}
          <input ref={fileInputRef} className="composer-file-input" type="file" accept=".png,.jpg,.jpeg,.webp,.txt,.md,.json,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAttachment(file) }} />
          <button className="icon-button" type="button" aria-label={uploading ? '正在上传附件' : '添加附件'} disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <CircleNotch size={18} className="spin" /> : <Paperclip size={18} />}</button>
          <CommandPicker commands={installedPlugins} draft={draft} onDraftChange={onDraftChange} {...(onOpenPluginMarket === undefined ? {} : { onOpenMarket: onOpenPluginMarket })} onFocus={() => inputRef.current?.focus()} />
        </div><button className={`send-button${canStopCurrentTurn ? ' send-button--stop' : ''}`} type="button" aria-label={canStopCurrentTurn ? '停止当前回复' : sending ? '正在回复中，发送新消息' : queueMode === 'next' ? '插入并发送' : hasQueueActions ? '排队发送' : '发送'} title={canStopCurrentTurn ? '停止当前回复' : sending ? '继续发送消息' : queueMode === 'next' ? '插入并发送' : hasQueueActions ? '排队发送' : '发送'} disabled={canStopCurrentTurn ? false : uploading || employees.length === 0 || (!draft.trim() && attachments.length === 0)} onClick={() => { if (canStopCurrentTurn) void onStopTurn(activeTurn.id); else void submit() }}>{canStopCurrentTurn ? <Stop size={19} weight="bold" /> : sending ? <CircleNotch size={19} className="spin" /> : <PaperPlaneRight size={19} weight="fill" />}{canStopCurrentTurn ? null : queuedCount > 0 ? <span className="send-button__queue" aria-label={`${queuedCount} 条消息已排队`}>{queuedCount}</span> : null}</button></div>
      </div></div>
    </section>
  )
}

function displayDirectConversationTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined
  const displayTitle = title.replace(/^与\s*/, '').replace(/\s*对话$/, '').trim()
  return displayTitle.length > 0 ? displayTitle : undefined
}

export async function copyTextToClipboard(value: string): Promise<boolean> {
  if (value.trim().length === 0) return false
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // The textarea fallback covers browsers that deny clipboard access for
      // the current document while still allowing a user-initiated copy.
    }
  }
  if (typeof document === 'undefined' || document.body === null) return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.inset = '0 auto auto 0'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
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

function artifactRefsFromMetadata(metadata: JsonObject): string[] {
  const value = metadata.artifactRefs
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.length > 0 && !/[\\/]/.test(entry)) return [entry]
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' && entry.id.length > 0 && !/[\\/]/.test(entry.id)) return [entry.id]
    return []
  })
}

function CompletionJobStatus({ metadata, onRetry, onSettled }: {
  metadata: JsonObject
  onRetry?: (jobId: string) => Promise<void>
  onSettled?: () => void
}) {
  const jobId = typeof metadata.completionJobId === 'string' ? metadata.completionJobId : undefined
  const initialStatus = completionStatus(metadata.completionStatus)
  const [status, setStatus] = useState<CompletionJob['status'] | undefined>(initialStatus)
  const [retrying, setRetrying] = useState(false)
  const settledRef = useRef(false)

  useEffect(() => {
    setStatus(initialStatus)
    settledRef.current = false
  }, [initialStatus, jobId])

  useEffect(() => {
    if (jobId === undefined || status === 'completed' || status === 'failed' || status === 'cancelled') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await api<{ job: CompletionJob }>(`/api/completion-jobs/${encodeURIComponent(jobId)}`)
        if (cancelled) return
        setStatus(result.job.status)
        if (result.job.status === 'completed' || result.job.status === 'failed' || result.job.status === 'cancelled') {
          if (!settledRef.current) {
            settledRef.current = true
            onSettled?.()
          }
          return
        }
      } catch {
        if (cancelled) return
      }
      timer = setTimeout(() => { void poll() }, 1_000)
    }
    void poll()
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer) }
  }, [jobId, onSettled, status])

  if (jobId === undefined || status === undefined) return null
  const label = status === 'completed'
    ? '产物可用'
    : status === 'failed'
      ? '产物整理失败'
      : status === 'cancelled'
        ? '产物整理已取消'
        : '产物整理中'
  return <div className={`completion-job-status completion-job-status--${status}`} role="status">
    {status === 'pending' || status === 'running' || status === 'retrying' ? <CircleNotch size={14} className="spin" aria-hidden="true" /> : null}
    <span>{label}</span>
    {status === 'failed' && onRetry !== undefined ? <button type="button" disabled={retrying} onClick={() => {
      setRetrying(true)
      void onRetry(jobId).then(() => setStatus('retrying')).finally(() => setRetrying(false))
    }}>{retrying ? '正在重试…' : '重试'}</button> : null}
  </div>
}

function completionStatus(value: unknown): CompletionJob['status'] | undefined {
  return value === 'pending' || value === 'running' || value === 'retrying' || value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : undefined
}

function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB` }

function RichText({ value, worldId }: { value: string; worldId: string }) {
  return <Suspense fallback={<div className="markdown-body"><p>{value}</p></div>}><MarkdownMessage value={value} worldId={worldId} /></Suspense>
}

export function WorldPermissionRequests({
  items,
  employees,
  activeSessionId,
  onDecide,
}: {
  items: WorldPermissionRequest[]
  employees: CyberEmployee[]
  activeSessionId?: string | undefined
  onDecide(requestId: string, scope: WorldPermissionDecisionScope | 'reject'): Promise<void>
}) {
  const allPending = items.filter((item) => item.status === 'pending')
  // A decision belongs above the conversation that produced it. Cards from
  // other conversations are counted rather than hidden: a decision surface
  // that silently shows nothing is worse than one that is merely elsewhere.
  const pending = activeSessionId === undefined
    ? allPending
    : allPending.filter((item) => item.sessionId === undefined || item.sessionId === activeSessionId)
  const elsewhere = allPending.length - pending.length
  if (pending.length === 0 && elsewhere === 0) return null
  if (pending.length === 0) {
    return (
      <div className="world-permission-requests" aria-label="其他会话的待处理请求">
        <p className="world-permission-request__blocked" role="note">
          另有 {elsewhere} 个待处理的世界权限请求属于其他会话，请切换到对应会话处理。
        </p>
      </div>
    )
  }
  return (
    <div className="world-permission-requests" aria-label="待处理的世界权限请求">
      {pending.map((request) => {
        const employee = employees.find((item) => item.id === request.employeeId)
        const integrationMutation = request.permission === 'world.integrations.manage'
        const persistentNeedsAdministrator = employee?.authorityRole !== 'administrator'
          && (WORLD_CHARACTER_MANAGEMENT_PERMISSIONS as readonly WorldCharacterPermission[]).includes(request.permission)
        const persistentDisabled = integrationMutation || persistentNeedsAdministrator
        return (
          <article key={request.id} className="world-permission-request" aria-labelledby={`permission-request-${request.id}`}>
            <header>
              <div><strong id={`permission-request-${request.id}`}>需要世界权限</strong><span>当前世界 · {employee?.displayName ?? '角色'}</span></div>
              <span className="world-permission-request__tag">权限请求</span>
            </header>
            <p>{employee?.displayName ?? '当前角色'}想要{worldPermissionLabel(request.permission)}，仅用于这次工作回合。长期授权仍会记录在角色设置中。</p>
            {integrationMutation ? <p className="world-permission-request__blocked" role="note">连接管理权限暂不可在这里授予，需要通过连接管理流程单独安全审批。</p> : null}
            {persistentNeedsAdministrator && !integrationMutation ? <p className="world-permission-request__blocked" role="note">这类世界管理动作只支持本次批准；角色的默认文件运行权限请在“角色设置 → 对话权限”中配置。</p> : null}
            <dl>
              {subjectOf(request) === undefined ? null : (
                <>
                  <div><dt>具体动作</dt><dd>{subjectOf(request)!.label}</dd></div>
                  <div><dt>调用</dt><dd><code>{subjectOf(request)!.action}</code></dd></div>
                  <div><dt>目标</dt><dd><code>{subjectOf(request)!.target}</code></dd></div>
                  {Object.entries(subjectOf(request)!.parameters ?? {}).length === 0 ? null : (
                    <div className="world-permission-request__parameters">
                      <dt>参数</dt>
                      <dd>{Object.entries(subjectOf(request)!.parameters ?? {}).map(([key, value]) => (
                        <code key={key}>{key}={typeof value === 'string' ? value : JSON.stringify(value)}</code>
                      ))}</dd>
                    </div>
                  )}
                </>
              )}
              <div><dt>请求权限</dt><dd><code>{request.permission}</code></dd></div>
              <div><dt>到期时间</dt><dd>{formatPermissionExpiry(request.expiresAt)}</dd></div>
            </dl>
            {elsewhere === 0 ? null : (
              <p className="world-permission-request__blocked" role="note">另有 {elsewhere} 个请求属于其他会话。</p>
            )}
            <footer>
              <button className="primary-button" type="button" disabled={integrationMutation} onClick={() => void onDecide(request.id, 'once')}>仅本次允许</button>
              <button className="secondary-button" type="button" disabled={persistentDisabled} onClick={() => void onDecide(request.id, 'persistent')}>{integrationMutation ? '暂不可授予' : persistentNeedsAdministrator ? '需先设为管理员' : '授予该权限并执行'}</button>
              <button className="danger-button" type="button" onClick={() => void onDecide(request.id, 'reject')}>拒绝</button>
            </footer>
          </article>
        )
      })}
    </div>
  )
}

/** The concrete action a request is gating, when the server supplied one. */
function subjectOf(request: WorldPermissionRequest): {
  action: string
  target: string
  label: string
  parameters?: Record<string, unknown>
} | undefined {
  const subject = (request as { subject?: unknown }).subject
  if (subject === null || typeof subject !== 'object') return undefined
  const value = subject as { action?: unknown; target?: unknown; label?: unknown; parameters?: unknown }
  if (typeof value.action !== 'string' || typeof value.target !== 'string' || typeof value.label !== 'string') return undefined
  return {
    action: value.action,
    target: value.target,
    label: value.label,
    ...(value.parameters !== null && typeof value.parameters === 'object'
      ? { parameters: value.parameters as Record<string, unknown> }
      : {}),
  }
}

function worldPermissionLabel(permission: WorldCharacterPermission): string {
  const labels: Record<WorldCharacterPermission, string> = {
    'world.files.read': '读取当前世界文件',
    'world.files.write': '修改当前世界文件',
    'world.settings.read': '查看世界设置',
    'world.settings.write': '修改世界设置',
    'world.characters.read': '查看其他角色',
    'world.characters.manage': '管理其他角色',
    'world.permissions.read': '查看角色权限',
    'world.permissions.manage': '管理角色权限',
    'world.packages.read': '查看当前世界扩展',
    'world.packages.manage': '管理当前世界扩展',
    'world.integrations.read': '查看连接状态',
    'world.integrations.manage': '管理世界连接',
    'world.model.read': '查看模型',
    'world.model.assign': '修改世界模型',
    'world.approvals.read': '查看审批',
    'world.trace.read': '查看轨迹',
    'world.conversations.read-metadata': '查看会话列表与元数据',
    'world.conversations.read-content': '读取其他会话正文',
    'world.artifacts.read': '浏览世界产物',
    'world.artifacts.manage': '管理世界产物',
    'world.knowledge.read': '浏览世界知识',
    'world.knowledge.manage': '管理世界知识',
  }
  return labels[permission]
}

function formatPermissionExpiry(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function displayTime(message: WorkMessage): string { const metadataTime = message.metadata.displayTime; return typeof metadataTime === 'string' ? metadataTime : new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }
function currentMention(value: string): string | undefined { return /@([^\s@]*)$/.exec(value)?.[1] }
export function isChatMessage(message: WorkMessage): boolean {
  if (message.kind === 'user' || message.kind === 'assistant') return true
  return message.kind === 'system' && message.metadata.productNotice === true
}
