import {
  ArrowDown,
  ArrowUp,
  CircleNotch,
  ClockCounterClockwise,
  Copy,
  File as FileIcon,
  FilePlus,
  PaperPlaneRight,
  Paperclip,
  Stop,
  TerminalWindow,
  UserCircle,
  X,
} from '@phosphor-icons/react'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { WORLD_CHARACTER_MANAGEMENT_PERMISSIONS, type ChatAttachment, type CompletionJob, type EmployeeDossier, type InstalledPluginCommand, type JsonObject, type LocalAssetMimeType, type ModelAssignment, type ModelProfile, type WorkMessage, type WorkSession, type World, type WorldCharacterPermission, type WorldPermissionDecisionScope, type WorldPermissionRequest } from '@dsh-cyber/contracts'

import { api } from '../api.js'
import { formatDateTime, formatTime } from '../i18n/format.js'
import { useI18n } from '../i18n/runtime.js'
import type { ConversationIntent, CyberEmployee } from '../types.js'
import type { PendingChatTurn } from '../chat-realtime.js'
import { worldExperience } from '../world-experience.js'
import { ApprovalRequests, type ApprovalRequestsProps } from './ApprovalRequests.js'
import { Avatar, GroupAvatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { CommandPicker } from './CommandPicker.js'
import { ContextMenu, type ContextMenuPosition } from './ContextMenu.js'
import { ConversationPermissionControl, type ConversationPermissionMode } from './ConversationPermissionControl.js'
import { ModelPicker } from '../features/models/ModelPicker.js'
import { MessageSpeechButton } from '../features/voice/MessageSpeechButton.js'
import { ComposerReplySpeaker } from '../features/voice/ComposerReplySpeaker.js'
import type { SpeechInputSurface } from '../features/voice/SpeechCoordinator.js'
import { VoiceConversationControl } from '../features/voice/VoiceConversationControl.js'
import type { ComposerAttachmentDraft } from '../composer-draft-store.js'

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
  dossiers?: Record<string, EmployeeDossier>
  installedPlugins?: InstalledPluginCommand[]
  models?: ModelProfile[]
  modelAssignments?: readonly ModelAssignment[]
  modelProfileId?: string
  onChangeModelProfile?(modelProfileId: string | undefined): void
  attachments?: ComposerAttachmentDraft[]
  onAttachmentsChange?(updater: (current: readonly ComposerAttachmentDraft[]) => ComposerAttachmentDraft[]): void
  /** Owner key used to invalidate late upload callbacks after navigation or clear. */
  composerOwnerKey?: string
  /** Clears the complete local owner draft, including temporary model state. */
  onClearDraft?(): void
  sending?: boolean
  pendingCount?: number
  queuedCount?: number
  queueItems?: PendingChatTurn[]
  draft: string
  focusRequest?: number
  onDraftChange(value: string): void
  onSend(prompt: string, attachments: ChatAttachment[], queueMode?: 'normal' | 'next', speechSurface?: SpeechInputSurface): Promise<void>
  onUploadAttachment(file: File, signal?: AbortSignal): Promise<ChatAttachment>
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
  onCancelQueuedTurn?(turnId: string): Promise<void>
  onStopTurn?(turnId: string): Promise<void>
  /** Stable queue identity used to reject late speech from another session. */
  speechConversationKey?: string
}

export function ChatWorkbench({ demoMode, world, session, intent, participantIds = [], messages, employees, dossiers = {}, installedPlugins = [], models = [], modelAssignments = [], modelProfileId, onChangeModelProfile, attachments: controlledAttachments, onAttachmentsChange, composerOwnerKey, onClearDraft, sending = false, pendingCount = 0, queuedCount = 0, queueItems = [], draft, focusRequest = 0, onDraftChange, onSend, onUploadAttachment, onOpenDossier, onOpenArtifact, onRetryCompletionJob, onCompletionJobSettled, onRecruit, onOpenPluginMarket, onOpenHistory, hasOlderMessages = false, loadingOlderMessages = false, onLoadOlderMessages, approvals = [], onDecideApproval, permissionRequests = [], onDecideWorldPermissionRequest, permissionMode = 'read-only', onChangePermissionMode, onRequestFullAccess, onCancelQueuedTurn, onStopTurn, speechConversationKey }: ChatWorkbenchProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadGenerationRef = useRef(new Map<string, number>())
  const uploadAbortRef = useRef(new Map<string, AbortController>())
  const uploadOwnersRef = useRef(new Map<string, { update: (updater: (current: readonly ComposerAttachmentDraft[]) => ComposerAttachmentDraft[]) => void; external: boolean }>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldFollowOutputRef = useRef(true)
  const historyAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | undefined>(undefined)
  const [localAttachments, setLocalAttachments] = useState<ComposerAttachmentDraft[]>([])
  const attachments = controlledAttachments ?? localAttachments
  const updateAttachments = useCallback((updater: (current: readonly ComposerAttachmentDraft[]) => ComposerAttachmentDraft[]) => {
    if (onAttachmentsChange !== undefined) {
      onAttachmentsChange(updater)
      return
    }
    setLocalAttachments((current) => updater(current))
  }, [onAttachmentsChange])
  const uploadOwnerKey = composerOwnerKey ?? '__local__'
  const cancelUploads = useCallback(() => {
    const nextGeneration = (uploadGenerationRef.current.get(uploadOwnerKey) ?? 0) + 1
    uploadGenerationRef.current.set(uploadOwnerKey, nextGeneration)
    uploadAbortRef.current.get(uploadOwnerKey)?.abort()
    uploadAbortRef.current.delete(uploadOwnerKey)
    uploadOwnersRef.current.delete(uploadOwnerKey)
  }, [uploadOwnerKey])
  const cancelAllUploads = useCallback(() => {
    for (const { update, external } of uploadOwnersRef.current.values()) {
      if (!external) continue
      update((current) => current.map((item) => item.status === 'uploading'
        ? { ...item, status: 'interrupted', error: '离开当前页面时上传未完成，请重新选择文件。' }
        : item))
    }
    for (const [ownerKey, controller] of uploadAbortRef.current) {
      controller.abort()
      uploadGenerationRef.current.set(ownerKey, (uploadGenerationRef.current.get(ownerKey) ?? 0) + 1)
    }
    uploadAbortRef.current.clear()
    uploadOwnersRef.current.clear()
  }, [])
  // Clicking an image in the transcript enlarges it in place (portal overlay)
  // instead of spawning a browser tab per picture.
  const [zoomImage, setZoomImage] = useState<ChatAttachment>()
  useEffect(() => {
    if (zoomImage === undefined) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setZoomImage(undefined) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [zoomImage])
  const [attachmentError, setAttachmentError] = useState<{ ownerKey: string | undefined; message: string }>()
  const [messageMenu, setMessageMenu] = useState<{ message: WorkMessage; position: ContextMenuPosition }>()
  const [rememberingMessageId, setRememberingMessageId] = useState<string>()
  const [submittedKnowledgeMessageIds, setSubmittedKnowledgeMessageIds] = useState<Set<string>>(() => new Set())
  const [knowledgeError, setKnowledgeError] = useState<string>()
  const [copiedMessageId, setCopiedMessageId] = useState<string>()
  const [copyError, setCopyError] = useState<string>()
  const [savingDocumentMessageId, setSavingDocumentMessageId] = useState<string>()
  const [savedDocumentMessageIds, setSavedDocumentMessageIds] = useState<Set<string>>(() => new Set())
  const [saveDocumentError, setSaveDocumentError] = useState<string>()
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [topicNotice, setTopicNotice] = useState(false)
  const experience = worldExperience(world)
  const mention = useMemo(() => currentMention(draft), [draft])
  const suggestions = useMemo(() => mention === undefined ? [] : employees.filter((employee) => employee.displayName.includes(mention)).slice(0, 6), [employees, mention])
  const participantEmployees = participantIds.map((employeeId) => employees.find((employee) => employee.id === employeeId)).filter((employee): employee is CyberEmployee => employee !== undefined)
  const conversationKind = session?.kind ?? intent?.kind
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
  const queuedTurns = useMemo(() => queueItems.filter((turn) => turn.status === 'queued').sort((left, right) => left.createdAt.localeCompare(right.createdAt)), [queueItems])
  const canStopCurrentTurn = activeTurn !== undefined && onStopTurn !== undefined
  const hasRunningTurn = queueItems.some((turn) => turn.status === 'running' || turn.status === 'waiting-approval' || turn.status === 'stopping')
  const insertsNext = hasRunningTurn || queuedTurns.length > 0
  const nextQueueMode = hasRunningTurn && queuedTurns.length === 0 ? 'next' : 'normal'
  const readyAttachments = attachments.flatMap((item) => item.status === 'ready' && item.attachment !== undefined ? [item.attachment] : [])
  const uploading = attachments.some((item) => item.status === 'uploading')
  const activeAttachmentError = attachmentError === undefined || attachmentError.ownerKey !== composerOwnerKey
    ? undefined
    : attachmentError.message
  const showStopButton = canStopCurrentTurn && draft.trim().length === 0 && attachments.length === 0

  useEffect(() => {
    setAttachmentError(undefined)
    setTopicNotice(false)
  }, [composerOwnerKey])

  useEffect(() => cancelAllUploads, [cancelAllUploads])

  const clearComposerDraft = () => {
    cancelUploads()
    if (onClearDraft !== undefined) {
      onClearDraft()
      return
    }
    onDraftChange('')
    updateAttachments(() => [])
  }

  /**
   * The model a given character would actually run on.
   *
   * Mirrors the host's own resolution order (employee, then world, then
   * workspace, then the default profile). The composer used to apply the
   * employee step only to a private chat, so a group named one model while
   * its characters each ran on their own.
   */
  const modelForEmployee = useCallback((employeeId: string | undefined) => {
    if (employeeId !== undefined) {
      const assigned = modelAssignments.find((item) => item.scope === 'employee' && item.scopeId === employeeId)
      const found = assigned === undefined ? undefined : models.find((item) => item.id === assigned.modelProfileId)
      if (found) return found
    }
    const worldAssigned = modelAssignments.find((item) => item.scope === 'world' && item.scopeId === world.id)
    const world1 = worldAssigned === undefined ? undefined : models.find((item) => item.id === worldAssigned.modelProfileId)
    if (world1) return world1
    const worldSettingsModelId = (world as unknown as { settings?: { model?: { defaultModelProfileId?: string } } }).settings?.model?.defaultModelProfileId
    const world2 = worldSettingsModelId === undefined ? undefined : models.find((item) => item.id === worldSettingsModelId)
    if (world2) return world2
    const workspaceAssigned = modelAssignments.find((item) => item.scope === 'workspace')
    const workspace = workspaceAssigned === undefined ? undefined : models.find((item) => item.id === workspaceAssigned.modelProfileId)
    if (workspace) return workspace
    return models.find((item) => item.isDefault) ?? models[0]
  }, [modelAssignments, models, world])

  /** Distinct models the characters of this conversation would run on. */
  const participantModels = useMemo(() => {
    if (conversationKind !== 'group') return []
    const seen = new Map<string, string>()
    for (const employee of participantEmployees) {
      const model = modelForEmployee(employee.id)
      if (model !== undefined) seen.set(model.id, model.modelId || model.displayName)
    }
    return [...seen.values()]
  }, [conversationKind, participantEmployees, modelForEmployee])

  const effectiveDefaultModel = useMemo(() => {
    if (modelProfileId !== undefined) {
      return models.find((m) => m.id === modelProfileId)
    }
    if (directEmployee?.id && modelAssignments.length > 0) {
      const empAssign = modelAssignments.find((a) => a.scope === 'employee' && a.scopeId === directEmployee.id)
      if (empAssign) {
        const found = models.find((m) => m.id === empAssign.modelProfileId)
        if (found) return found
      }
    }
    if (modelAssignments.length > 0) {
      const worldAssign = modelAssignments.find((a) => a.scope === 'world' && a.scopeId === world.id)
      if (worldAssign) {
        const found = models.find((m) => m.id === worldAssign.modelProfileId)
        if (found) return found
      }
    }
    const worldSettingsModelId = (world as unknown as { settings?: { model?: { defaultModelProfileId?: string } } }).settings?.model?.defaultModelProfileId
    if (worldSettingsModelId) {
      const found = models.find((m) => m.id === worldSettingsModelId)
      if (found) return found
    }
    if (modelAssignments.length > 0) {
      const wsAssign = modelAssignments.find((a) => a.scope === 'workspace')
      if (wsAssign) {
        const found = models.find((m) => m.id === wsAssign.modelProfileId)
        if (found) return found
      }
    }
    return models.find((m) => m.isDefault) ?? models[0]
  }, [directEmployee?.id, modelAssignments, modelProfileId, models, world])

  const resolvedModelLabel = useMemo(() => {
    // Naming one model for a room whose characters run on several was the
    // visible half of a real bug: the composer's pick used to flatten them all
    // onto it, and without a pick it reported a model most of them never used.
    if (modelProfileId === undefined && participantModels.length > 1) {
      return t('workbench.modelPerCharacter', '按角色分配（{count} 个模型）', { count: participantModels.length })
    }
    if (!effectiveDefaultModel) return '未配置模型'
    return effectiveDefaultModel.modelId || effectiveDefaultModel.displayName
  }, [effectiveDefaultModel, modelProfileId, participantModels, t])

  /**
   * What "restore inherited" actually hands control to: the world → workspace
   * → default chain, deliberately skipping the character's own assignment (the
   * level being cleared) and the current selection. The panel's secondary text
   * used to echo the current model back, which read as a no-op.
   */
  const inheritResolutionLabel = useMemo(() => {
    const worldAssigned = modelAssignments.find((item) => item.scope === 'world' && item.scopeId === world.id)
    const byWorld = worldAssigned === undefined ? undefined : models.find((item) => item.id === worldAssigned.modelProfileId)
    if (byWorld !== undefined) return byWorld.modelId || byWorld.displayName
    const worldSettingsModelId = (world as unknown as { settings?: { model?: { defaultModelProfileId?: string } } }).settings?.model?.defaultModelProfileId
    const byWorldSettings = worldSettingsModelId === undefined ? undefined : models.find((item) => item.id === worldSettingsModelId)
    if (byWorldSettings !== undefined) return byWorldSettings.modelId || byWorldSettings.displayName
    const wsAssigned = modelAssignments.find((item) => item.scope === 'workspace')
    const byWorkspace = wsAssigned === undefined ? undefined : models.find((item) => item.id === wsAssigned.modelProfileId)
    if (byWorkspace !== undefined) return byWorkspace.modelId || byWorkspace.displayName
    const fallback = models.find((item) => item.isDefault) ?? models[0]
    return fallback === undefined ? '未配置模型' : fallback.modelId || fallback.displayName
  }, [modelAssignments, models, world])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = scrollRef.current
    if (container === null) return
    shouldFollowOutputRef.current = true
    setShowScrollToBottom(false)
    container.scrollTo({ top: container.scrollHeight, behavior })
  }, [])

  const updateScrollIntent = useCallback(() => {
    const container = scrollRef.current
    if (container === null) return
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 64
    shouldFollowOutputRef.current = atBottom
    setShowScrollToBottom(!atBottom)
  }, [])

  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current
    const container = scrollRef.current
    if (anchor === undefined || container === null || loadingOlderMessages) return
    historyAnchorRef.current = undefined
    container.scrollTop = anchor.scrollTop + Math.max(0, container.scrollHeight - anchor.scrollHeight)
    updateScrollIntent()
  }, [loadingOlderMessages, updateScrollIntent, visibleMessages.length])

  useEffect(() => {
    if (!shouldFollowOutputRef.current) return
    const frame = window.requestAnimationFrame(() => scrollToBottom())
    return () => window.cancelAnimationFrame(frame)
  }, [visibleMessages, pendingCount, sending, scrollToBottom])

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
    shouldFollowOutputRef.current = true
    setShowScrollToBottom(false)
    const frame = window.requestAnimationFrame(() => scrollToBottom())
    return () => window.cancelAnimationFrame(frame)
  }, [scrollToBottom, session?.id])

  const loadOlderMessages = () => {
    const container = scrollRef.current
    if (container !== null) {
      historyAnchorRef.current = { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop }
      shouldFollowOutputRef.current = false
    }
    onLoadOlderMessages?.()
  }

  const executeLocalCommand = async (prompt: string): Promise<boolean> => {
    const command = prompt.split(/\s+/, 1)[0]
    if (command === '/换个话题') {
      setTopicNotice(true)
      clearComposerDraft()
      return true
    }
    if (command === '/查看历史') {
      onOpenHistory?.()
      onDraftChange('')
      return true
    }
    if (command === '/清空草稿' || command === '/清空输入') {
      setTopicNotice(true)
      clearComposerDraft()
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
      shouldFollowOutputRef.current = true
      if (onAttachmentsChange === undefined && onClearDraft === undefined) {
        onDraftChange('')
        updateAttachments((current) => current.filter((item) => item.status !== 'ready'))
      }
      await onSend(`请使用“${skillName}”技能处理以下内容：\n${task}`, readyAttachments, nextQueueMode)
      return true
    }
    return false
  }

  const submit = async () => {
    const prompt = draft.trim()
    if ((!prompt && readyAttachments.length === 0) || uploading) return
    if (prompt.length > 0 && await executeLocalCommand(prompt)) return
    shouldFollowOutputRef.current = true
    setShowScrollToBottom(false)
    if (onAttachmentsChange === undefined && onClearDraft === undefined) {
      const submittedAttachmentIds = new Set(readyAttachments.map((attachment) => attachment.assetId))
      // Standalone/demo consumers still own their draft locally. Clear only
      // the submitted snapshot before awaiting; new text or uploads survive.
      onDraftChange('')
      updateAttachments((current) => current.filter((item) => (
        item.status !== 'ready'
        || item.attachment === undefined
        || !submittedAttachmentIds.has(item.attachment.assetId)
      )))
    }
    await onSend(prompt || '请查看随消息发送的附件。', readyAttachments, nextQueueMode)
  }

  const uploadAttachments = async (files: File[]) => {
    setAttachmentError(undefined)
    if (uploading) { setAttachmentError({ ownerKey: composerOwnerKey, message: '正在处理上一批附件，请稍候。' }); return }
    const available = 8 - attachments.length
    if (available <= 0) { setAttachmentError({ ownerKey: composerOwnerKey, message: '每条消息最多附加 8 个文件。' }); return }
    const candidates = files.slice(0, available)
    if (candidates.length === 0) return
    const ownerKey = uploadOwnerKey
    const generation = (uploadGenerationRef.current.get(ownerKey) ?? 0) + 1
    uploadGenerationRef.current.set(ownerKey, generation)
    const controller = new AbortController()
    uploadAbortRef.current.set(ownerKey, controller)
    uploadOwnersRef.current.set(ownerKey, { update: updateAttachments, external: onAttachmentsChange !== undefined })
    const pending = candidates.map<ComposerAttachmentDraft>((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      byteLength: file.size,
      status: 'uploading',
    }))
    updateAttachments((current) => [...current, ...pending].slice(0, 8))
    for (const [index, file] of candidates.entries()) {
      const pendingItem = pending[index]
      if (pendingItem === undefined || generation !== uploadGenerationRef.current.get(ownerKey) || controller.signal.aborted) break
      try {
        if (file.size < 1 || file.size > 5 * 1024 * 1024) throw new Error('附件大小需在 1 byte 到 5 MiB 之间。')
        const uploaded = demoMode
          ? await onUploadAttachment(file, controller.signal)
          : await uploadWorldAttachment(world.id, file, controller.signal)
        if (generation !== uploadGenerationRef.current.get(ownerKey) || controller.signal.aborted) break
        updateAttachments((current) => current.map((item) => {
          if (item.id !== pendingItem.id) return item
          const next = { ...item, status: 'ready' as const, mimeType: uploaded.mimeType, byteLength: uploaded.byteLength, attachment: uploaded }
          delete next.error
          return next
        }))
      } catch (cause) {
        if (generation !== uploadGenerationRef.current.get(ownerKey) || controller.signal.aborted) break
        updateAttachments((current) => current.map((item) => item.id === pendingItem.id
          ? { ...item, status: 'failed', error: cause instanceof Error ? cause.message : '附件上传失败' }
          : item))
      }
    }
    if (generation === uploadGenerationRef.current.get(ownerKey) && !controller.signal.aborted && files.length > candidates.length) setAttachmentError({ ownerKey: composerOwnerKey, message: `已选择 ${candidates.length} 个文件；每条消息最多附加 8 个文件。` })
    if (uploadAbortRef.current.get(ownerKey) === controller) {
      uploadAbortRef.current.delete(ownerKey)
      uploadOwnersRef.current.delete(ownerKey)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const pasteImages = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap((item, index) => {
        const file = item.getAsFile()
        return file === null ? [] : [namedClipboardImage(file, index)]
      })
    if (images.length === 0) return
    event.preventDefault()
    void uploadAttachments(images)
  }

  const insertMention = (employee: CyberEmployee) => {
    const marker = draft.lastIndexOf('@')
    onDraftChange(marker < 0 ? `${draft}@${employee.displayName} ` : `${draft.slice(0, marker)}@${employee.displayName} `)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const rememberMessage = async (message: WorkMessage) => {
    if (session === undefined || rememberingMessageId !== undefined || submittedKnowledgeMessageIds.has(message.id)) return
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
      const result = await response.json() as { job?: { id?: unknown }; error?: { message?: string } }
      if (!response.ok) throw new Error(result.error?.message ?? '这条消息暂时无法加入长期知识')
      if (typeof result.job?.id !== 'string') throw new Error('知识整理服务未返回可追踪的任务记录')
      setSubmittedKnowledgeMessageIds((current) => new Set(current).add(message.id))
    } catch (cause) {
      setKnowledgeError(cause instanceof Error ? cause.message : '这条消息暂时无法加入长期知识')
    } finally {
      setRememberingMessageId(undefined)
    }
  }

  /**
   * Keep one reply as a document in this world.
   *
   * Only the message id travels: the host reads the reply it already stored
   * and publishes it as the owner's own document. Nothing here turns the row
   * into a delivered file — the status says the reply was kept, not that a
   * character executed anything to produce it.
   */
  const saveReplyAsDocument = async (message: WorkMessage) => {
    if (savingDocumentMessageId !== undefined || savedDocumentMessageIds.has(message.id)) return
    setMessageMenu(undefined)
    setSaveDocumentError(undefined)
    setSavingDocumentMessageId(message.id)
    try {
      const response = await fetch(`/api/worlds/${encodeURIComponent(world.id)}/artifacts/save-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id }),
      })
      const result = await response.json() as { artifact?: { id?: unknown }; error?: { message?: string } }
      if (!response.ok) throw new Error(result.error?.message ?? '这条回复暂时无法保存为文档')
      if (typeof result.artifact?.id !== 'string') throw new Error('产物服务没有返回可查看的文档记录')
      setSavedDocumentMessageIds((current) => new Set(current).add(message.id))
    } catch (cause) {
      setSaveDocumentError(cause instanceof Error ? cause.message : '这条回复暂时无法保存为文档')
    } finally {
      setSavingDocumentMessageId(undefined)
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
          {/* 群聊头像自己带 role="img" 和成员名，是这里唯一的成员说明，不能被 aria-hidden 藏掉。 */}
          <span className={`chat-header__avatars${conversationKind === 'group' || conversationKind === 'meeting' ? ' chat-header__avatars--group' : ''}`}>
            {directEmployee !== undefined
              ? <button className="chat-header__avatar-button" type="button" onClick={() => onOpenDossier(directEmployee.id)} aria-label={`打开${directEmployee.displayName}角色`} title={`打开${directEmployee.displayName}角色`}><Avatar index={directEmployee.avatarIndex} size="sm" label={directEmployee.displayName} authorityRole={directEmployee.authorityRole} assetUrl={directEmployee.avatarAssetUrl} rendererKind={directEmployee.avatarProfile?.rendererKind} /></button>
              : <GroupAvatar participants={participantEmployees} size="md" />}
          </span>
          <span><h1>{conversationTitle}{conversationKind === 'direct' ? <AuthorityBadge role={directEmployee?.authorityRole} /> : null}</h1><p>{conversationKind === undefined ? `从左侧会话列表进入私聊，或创建群聊` : `${conversationKind === 'group' ? '群聊' : '私聊'} · ${world.name}`}</p></span>
        </div>
        <div className="chat-header__actions">
          {onOpenHistory === undefined || session === undefined ? null : <button className="chat-header__history" type="button" aria-label={t('workbench.history', '查看历史消息')} title={t('workbench.history', '查看历史消息')} onClick={onOpenHistory}><ClockCounterClockwise size={19} /><span>{t('workbench.history', '查看历史消息')}</span></button>}
        </div>
      </header>

      <div className="message-scroll" ref={scrollRef} aria-live="polite" aria-busy={pendingCount > 0 || sending} onScroll={updateScrollIntent} onWheelCapture={(event) => { if (event.deltaY < 0) shouldFollowOutputRef.current = false }}>
        <div className="conversation-column">
          {hasOlderMessages && onLoadOlderMessages !== undefined ? <button className="message-history-more" type="button" disabled={loadingOlderMessages} onClick={loadOlderMessages}>{loadingOlderMessages ? <CircleNotch size={15} className="spin" /> : <ArrowUp size={15} />}<span>{loadingOlderMessages ? '正在加载更早消息…' : '加载更早消息'}</span></button> : null}
          {visibleMessages.length === 0 ? (
            <div className="conversation-empty">
              <TerminalWindow size={34} />
              <h2>{employees.length === 0 ? experience.emptyTitle : conversationKind === 'group' ? '群聊已准备好' : conversationKind === 'direct' ? t('workbench.startChat', '开始与角色对话') : '选择会话开始互动'}</h2>
              <p>{employees.length === 0 ? experience.emptyCopy : conversationKind === 'group' ? '发送消息后，系统会根据意图自动组织讨论或分工协作；执行细节统一进入轨迹。' : conversationKind === 'direct' ? t('workbench.startChatHint', '历史记录保留在当前世界；发送消息后角色才会开始处理。') : '左侧只保留会话：每个角色固定一个私聊，也可以创建多人群聊；角色新增与管理统一在右侧角色。'}</p>
            </div>
          ) : visibleMessages.map((message) => {
            const employee = employees.find((item) => item.id === message.senderId)
            const owner = message.senderKind === 'owner'
            const streaming = message.metadata.streaming === true
            if (message.kind === 'system') return <div key={message.id} className="chat-system-notice" role="status">{message.content}</div>
            return (
              <article key={message.id} className={`message${owner ? ' message--owner' : ''}${streaming ? ' message--streaming' : ''}`} onContextMenu={(event) => { if (streaming) return; event.preventDefault(); setMessageMenu({ message, position: { x: event.clientX, y: event.clientY } }) }} onKeyDown={(event) => { if (streaming || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMessageMenu({ message, position: { x: rect.left + Math.min(rect.width, 220), y: rect.top + 28 } }) }} tabIndex={streaming ? undefined : 0}>
                {owner ? null : <button className="avatar-button" type="button" onClick={() => employee && onOpenDossier(employee.id)} aria-label={`打开${employee?.displayName ?? experience.personLabel}角色`}><Avatar index={employee?.avatarIndex ?? 7} label={employee?.displayName ?? '角色'} authorityRole={employee?.authorityRole} assetUrl={employee?.avatarAssetUrl} rendererKind={employee?.avatarProfile?.rendererKind} /></button>}
                <div className="message__body">
                  <header className="message__meta">{owner ? <span className="sr-only">我的消息</span> : <><strong>{employee?.displayName ?? experience.personLabel}<AuthorityBadge role={employee?.authorityRole} /></strong><span>{employee?.role}</span></>}{owner || employee === undefined ? null : <MessageSpeechButton employeeId={employee.id} employeeName={employee.displayName} {...(dossiers[employee.id]?.profile === undefined ? {} : { profile: dossiers[employee.id]!.profile })} text={message.content} />}<time>{displayTime(message)}</time>{copiedMessageId === message.id ? <span role="status">已复制</span> : savingDocumentMessageId === message.id ? <span role="status">正在保存为文档…</span> : savedDocumentMessageIds.has(message.id) ? <span role="status">已保存为文档</span> : rememberingMessageId === message.id ? <span role="status">正在提交整理…</span> : submittedKnowledgeMessageIds.has(message.id) ? <span role="status">已提交整理</span> : null}</header>
                  <div className="message__content">{streaming && message.content.length === 0 ? <span className="stream-placeholder">正在回复中…</span> : <RichText value={message.content} worldId={world.id} />}{streaming ? <span className="stream-cursor" aria-hidden="true" /> : null}</div>
                  <MessageAttachments attachments={messageAttachments(message.metadata)} onZoom={(attachment) => setZoomImage(attachment)} />
                  <CompletionJobStatus metadata={message.metadata} {...(onRetryCompletionJob === undefined ? {} : { onRetry: onRetryCompletionJob })} {...(onCompletionJobSettled === undefined ? {} : { onSettled: onCompletionJobSettled })} />
                  {artifactRefsFromMetadata(message.metadata).length === 0 ? null : <Suspense fallback={<div className="chat-artifact-refs" role="status">正在载入产物卡…</div>}><ArtifactReferenceCards worldId={world.id} artifactRefs={artifactRefsFromMetadata(message.metadata)} onOpen={onOpenArtifact} /></Suspense>}
                </div>
                {owner ? <span className="owner-avatar" role="img" aria-label="我的头像"><UserCircle size={28} weight="fill" /></span> : null}
              </article>
            )
          })}
          {pendingCount > 0 ? <div className="stream-state" role="status"><CircleNotch size={16} className="spin" /><span>{hasRunningTurn ? '正在回复中，你可以继续补充，也可以切换到其他会话。' : '消息已接收，正在等待角色处理。'}</span>{queuedCount > 0 ? <strong>另有 {queuedCount} 条等待执行</strong> : null}</div> : sending ? <div className="stream-state" role="status"><CircleNotch size={16} className="spin" /><span>正在回复中…</span></div> : null}
        </div>
        {showScrollToBottom ? <button className="message-scroll__jump" type="button" onClick={() => scrollToBottom('smooth')} aria-label="回到最新消息"><ArrowDown size={16} weight="bold" /><span>回到最新消息</span></button> : null}
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
        ...(canSaveReplyAsDocument(messageMenu.message) ? [{
          id: 'save-reply-as-document',
          label: savedDocumentMessageIds.has(messageMenu.message.id) ? '已保存为文档' : '将回复保存为文档',
          description: '把这段文字存成世界里的 Markdown 文档；不代表角色执行过任务',
          icon: <FilePlus size={17} />,
          disabled: savingDocumentMessageId !== undefined || savedDocumentMessageIds.has(messageMenu.message.id),
          onSelect: () => { void saveReplyAsDocument(messageMenu.message) },
        }] : []),
        {
          id: 'remember-message',
          label: submittedKnowledgeMessageIds.has(messageMenu.message.id) ? '已提交整理' : '加入长期知识',
          description: '引用这条消息作为证据，在后台整理为可追溯知识',
          icon: <ClockCounterClockwise size={17} />,
          disabled: rememberingMessageId !== undefined || submittedKnowledgeMessageIds.has(messageMenu.message.id),
          onSelect: () => { void rememberMessage(messageMenu.message) },
        },
      ]} />}
      <div className="composer-zone">
        {copyError === undefined ? null : <div className="chat-knowledge-error" role="alert"><span>{copyError}</span><button type="button" onClick={() => setCopyError(undefined)} aria-label="关闭提示"><X size={14} /></button></div>}
        {saveDocumentError === undefined ? null : <div className="chat-knowledge-error" role="alert"><span>{saveDocumentError}</span><button type="button" onClick={() => setSaveDocumentError(undefined)} aria-label="关闭提示"><X size={14} /></button></div>}
        {knowledgeError === undefined ? null : <div className="chat-knowledge-error" role="alert"><span>{knowledgeError}</span><button type="button" onClick={() => setKnowledgeError(undefined)} aria-label="关闭提示"><X size={14} /></button></div>}
        {onDecideWorldPermissionRequest === undefined ? null : <WorldPermissionRequests items={permissionRequests} employees={employees} activeSessionId={session?.id} onDecide={onDecideWorldPermissionRequest} />}
        {onDecideApproval === undefined ? null : <ApprovalRequests items={approvals} onDecide={onDecideApproval} />}
        {topicNotice ? <div className="composer-topic-notice" role="status"><span>已清空当前会话草稿，已发送消息和已上传资源仍保留</span></div> : null}
        {queuedTurns.length > 0 ? <section className="composer-inserts" aria-label="插入对话">
          <header><span>插入对话</span><small>当前回复结束后优先处理</small></header>
          {saturatedWaiting ? <p className="composer-inserts__note" role="status">角色通道已满，插入内容会在可用后立即继续。</p> : null}
          <div>{queuedTurns.map((turn) => <article key={turn.id} className="composer-insert"><span><strong>{turn.content ?? turn.title}</strong><small>等待插入</small></span>{onCancelQueuedTurn === undefined ? null : <button type="button" onClick={() => void onCancelQueuedTurn(turn.id)} aria-label={`撤销插入：${turn.content ?? turn.title}`}><X size={15} /></button>}</article>)}</div>
        </section> : null}
        <div className="composer">
        {suggestions.length === 0 ? null : <div className="mention-menu" role="listbox" aria-label="当前世界角色">{suggestions.map((employee) => <button key={employee.id} type="button" onClick={() => insertMention(employee)}><Avatar index={employee.avatarIndex} size="sm" label={employee.displayName} authorityRole={employee.authorityRole} assetUrl={employee.avatarAssetUrl} rendererKind={employee.avatarProfile?.rendererKind} /><span><strong>{employee.displayName}<AuthorityBadge role={employee.authorityRole} /></strong><small>{employee.role} · 独立角色</small></span></button>)}</div>}
        {attachments.length > 0 ? <div className="composer-attachments" aria-label="待发送附件">{attachments.map((item) => {
          const attachment = item.attachment
          const image = attachment?.mimeType.startsWith('image/') === true
          const statusLabel = item.status === 'uploading'
            ? '正在上传'
            : item.status === 'failed'
              ? `上传失败：${item.error ?? '请重试或移除'}`
              : item.status === 'interrupted'
                ? '上传已中断，请重新选择文件'
                : formatBytes(attachment?.byteLength ?? item.byteLength ?? 0)
          return <span key={item.id} className={`${image ? 'is-image ' : ''}composer-attachment--${item.status}`}>
            {image && attachment !== undefined ? <img className="composer-attachments__preview" src={attachment.url} alt={`${item.name}预览`} /> : item.status === 'uploading' ? <CircleNotch size={15} className="spin" aria-label="正在上传" /> : <FileIcon size={15} />}
            <span><strong>{item.name}</strong><small>{statusLabel}</small></span>
            <button type="button" aria-label={`移除附件 ${item.name}`} onClick={() => { cancelUploads(); updateAttachments((current) => current.filter((candidate) => candidate.id !== item.id && candidate.status !== 'uploading')) }}><X size={13} /></button>
          </span>
        })}</div> : null}
        {activeAttachmentError === undefined ? null : <p className="composer-error" role="alert">{activeAttachmentError}</p>}
        <textarea ref={inputRef} value={draft} onChange={(event) => onDraftChange(event.target.value)} onPaste={pasteImages} disabled={employees.length === 0} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} placeholder={employees.length === 0 ? experience.emptyTitle : conversationKind === 'group' ? t('workbench.composer', '发送消息给 {name}', { name: participantEmployees.map((employee) => employee.displayName).join('、') }) : conversationKind === 'direct' ? t('workbench.composer', '发送消息给 {name}', { name: participantEmployees[0]?.displayName ?? experience.personLabel }) : '先从左侧选择会话，或输入 @角色名'} rows={2} aria-label={`给当前世界的${experience.peopleLabel}发送消息`} />
        <div className="composer__toolbar">
          <div className="composer__actions-left">
            <input ref={fileInputRef} className="composer-file-input" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.txt,.md,.json,.pdf" onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length > 0) void uploadAttachments(files) }} />
            <button className="icon-button composer-attachment-button" type="button" aria-label={uploading ? '正在上传附件' : '添加附件'} title={uploading ? '正在上传附件' : '添加附件'} disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <CircleNotch size={18} className="spin" /> : <Paperclip size={18} />}</button>
            {onChangePermissionMode === undefined ? null : <ConversationPermissionControl value={permissionMode} onChange={onChangePermissionMode} {...(onRequestFullAccess === undefined ? {} : { onRequestFullAccess })} />}
            {onChangeModelProfile === undefined || conversationKind === 'group' ? null : <div className="composer-model-picker"><ModelPicker models={models} value={modelProfileId} inheritLabel={inheritResolutionLabel} ariaLabel={t('workbench.modelLabel', '当前会话模型')} onChange={onChangeModelProfile} /></div>}
            <CommandPicker commands={installedPlugins} draft={draft} onDraftChange={onDraftChange} {...(onOpenPluginMarket === undefined ? {} : { onOpenMarket: onOpenPluginMarket })} onFocus={() => inputRef.current?.focus()} />
          </div>
          <div className="composer__actions-right">
            <ComposerReplySpeaker {...(directEmployee === undefined ? { employeeId: undefined } : { employeeId: directEmployee.id })} {...(session?.id === undefined ? {} : { sessionId: session.id })} {...(speechConversationKey === undefined ? {} : { conversationKey: speechConversationKey })} dossiers={dossiers} />
            <VoiceConversationControl variant="compact" employeeName={directEmployee?.displayName ?? '当前会话角色'} disabled={employees.length === 0} onFinal={async (text) => { await onSend(text, [], nextQueueMode, 'composer') }} />
            <button className={`send-button${showStopButton ? ' send-button--stop' : ''}`} type="button" aria-label={showStopButton ? '停止当前回复' : insertsNext ? '插入对话' : sending ? '正在回复中，发送新消息' : '发送'} title={showStopButton ? '停止当前回复' : insertsNext ? '插入对话' : '发送'} disabled={showStopButton ? false : uploading || employees.length === 0 || (!draft.trim() && readyAttachments.length === 0)} onClick={() => { if (showStopButton && activeTurn !== undefined && onStopTurn !== undefined) void onStopTurn(activeTurn.id); else void submit() }}>{showStopButton ? <Stop size={19} weight="bold" /> : sending && !insertsNext ? <CircleNotch size={19} className="spin" /> : <PaperPlaneRight size={19} weight="fill" />}{showStopButton || queuedCount === 0 ? null : <span className="send-button__queue" aria-label={`${queuedCount} 条插入对话`}>{queuedCount}</span>}</button>
          </div>
        </div>
      </div></div>
      {zoomImage !== undefined ? createPortal(<div className="chat-image-zoom" role="dialog" aria-modal="true" aria-label={zoomImage.name} onMouseDown={(event) => { if (event.target === event.currentTarget) setZoomImage(undefined) }}>
        <img src={zoomImage.url} alt={zoomImage.name} />
        <button type="button" className="icon-button chat-image-zoom__close" aria-label={t('common.close', '关闭')} onClick={() => setZoomImage(undefined)}><X size={18} /></button>
      </div>, document.body) : null}
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

async function uploadWorldAttachment(worldId: string, file: File, signal?: AbortSignal): Promise<ChatAttachment> {
  const mimeType = attachmentMimeType(file)
  const response = await fetch(`/api/worlds/${encodeURIComponent(worldId)}/assets/attachment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(signal === undefined ? {} : { signal }),
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

function namedClipboardImage(file: File, index: number): File {
  if (file.name.trim().length > 0 && !/^(?:image|clipboard)(?:\.[a-z0-9]+)?$/iu.test(file.name)) return file
  const extension = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' } as Record<string, string>)[file.type] ?? 'png'
  return new File([file], `粘贴图片-${Date.now()}-${index + 1}.${extension}`, { type: file.type || 'image/png', lastModified: file.lastModified })
}

function MessageAttachments({ attachments, onZoom }: { attachments: ChatAttachment[]; onZoom?(attachment: ChatAttachment): void }) {
  if (attachments.length === 0) return null
  return <div className="message-attachments">{attachments.map((attachment) => attachment.mimeType.startsWith('image/') ? <a key={attachment.assetId} className="message-attachment message-attachment--image" href={attachment.url} target="_blank" rel="noreferrer" onClick={(event) => { if (onZoom === undefined) return; event.preventDefault(); onZoom(attachment) }}><img src={attachment.url} alt={attachment.name} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.byteLength)}</small></span></a> : <a key={attachment.assetId} className="message-attachment" href={attachment.url} target="_blank" rel="noreferrer"><FileIcon size={19} /><span><strong>{attachment.name}</strong><small>{attachment.mimeType} · {formatBytes(attachment.byteLength)}</small></span><span>打开</span></a>)}</div>
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

  const { t } = useI18n()
  if (jobId === undefined || status === undefined) return null
  const artifactRefs = artifactRefsFromMetadata(metadata)
  if (status === 'completed' && artifactRefs.length === 0) return null
  const label = status === 'completed'
    ? t('workbench.artifactReady', '产物可用')
    : status === 'failed'
      ? t('workbench.artifactFailed', '产物整理失败')
      : status === 'cancelled'
        ? t('workbench.artifactCancelled', '产物整理已取消')
        : t('workbench.artifactPending', '正在检查本轮产物…')
  return <div className={`completion-job-status completion-job-status--${status}`} role="status">
    {status === 'pending' || status === 'running' || status === 'retrying' ? <CircleNotch size={14} className="spin" aria-hidden="true" /> : null}
    <span>{label}</span>
    {status === 'failed' && onRetry !== undefined ? <button type="button" disabled={retrying} onClick={() => {
      setRetrying(true)
      void onRetry(jobId).then(() => setStatus('retrying')).finally(() => setRetrying(false))
    }}>{retrying ? t('workbench.retrying', '正在重试…') : t('workbench.retry', '重试')}</button> : null}
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
  return Number.isNaN(date.valueOf()) ? value : formatDateTime(date, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function displayTime(message: WorkMessage): string { const metadataTime = message.metadata.displayTime; return typeof metadataTime === 'string' ? metadataTime : formatTime(message.createdAt) }
function currentMention(value: string): string | undefined { return /@([^\s@]*)$/.exec(value)?.[1] }
/**
 * Is there a finished character reply here worth keeping as a document?
 *
 * The owner's own rows, product notices and anything still streaming have no
 * settled reply to save, and an empty row would publish an empty file. The
 * action is offered only where saving means something.
 */
export function canSaveReplyAsDocument(message: WorkMessage): boolean {
  return message.kind === 'assistant'
    && message.senderKind === 'employee'
    && message.metadata.streaming !== true
    && message.content.trim().length > 0
}

export function isChatMessage(message: WorkMessage): boolean {
  if (message.kind === 'user' || message.kind === 'assistant') return true
  return message.kind === 'system' && message.metadata.productNotice === true
}
