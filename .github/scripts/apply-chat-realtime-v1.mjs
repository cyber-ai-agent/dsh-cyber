import { appendFile, readFile, writeFile } from 'node:fs/promises'

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search)
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`)
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`
}

function replaceBetween(source, start, end, replacement, label) {
  const startIndex = source.indexOf(start)
  if (startIndex < 0) throw new Error(`Missing patch start: ${label}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  if (endIndex < 0) throw new Error(`Missing patch end: ${label}`)
  return `${source.slice(0, startIndex)}${replacement}${source.slice(endIndex)}`
}

async function patch(path, transform) {
  const before = await readFile(path, 'utf8')
  const after = transform(before)
  if (after === before) throw new Error(`Patch made no changes: ${path}`)
  await writeFile(path, after)
}

await patch('packages/server/src/routes/conversation-routes.ts', (source) => replaceOnce(
  source,
  `    if (employeeIds.length === 0) throw new HttpError(422, 'agent_required', '请选择或 @ 至少一个角色')\n    const metadata: JsonObject = {\n      participantIds: employeeIds,\n      permissionMode,\n      interactionKind: body.interactionKind === 'task' || body.interactionKind === 'meeting' ? body.interactionKind : 'chat',\n      ...(attachments.length === 0 ? {} : { attachments: attachments.map(chatAttachmentJson) }),\n    }`,
  `    if (employeeIds.length === 0) throw new HttpError(422, 'agent_required', '请选择或 @ 至少一个角色')\n    const clientTurnId = optionalString(body.clientTurnId)\n    if (clientTurnId !== undefined && clientTurnId.length > 128) {\n      throw new HttpError(422, 'invalid_client_turn_id', 'clientTurnId cannot exceed 128 characters')\n    }\n    const metadata: JsonObject = {\n      participantIds: employeeIds,\n      permissionMode,\n      interactionKind: body.interactionKind === 'task' || body.interactionKind === 'meeting' ? body.interactionKind : 'chat',\n      ...(attachments.length === 0 ? {} : { attachments: attachments.map(chatAttachmentJson) }),\n      ...(clientTurnId === undefined ? {} : { clientTurnId }),\n    }`,
  'conversation client turn metadata',
))

await patch('packages/orchestration/src/conversation-orchestrator.ts', (initial) => {
  let source = initial
  source = replaceOnce(
    source,
    `    const reply = await this.#runAgent(session, employee, input.runtimePrompt?.trim() || prompt, input.reasoningEffort, input.permissionMode)`,
    `    const reply = await this.#runAgent(\n      session,\n      employee,\n      input.runtimePrompt?.trim() || prompt,\n      input.reasoningEffort,\n      input.permissionMode,\n      clientTurnIdFrom(input.metadata),\n    )`,
    'direct turn client id',
  )
  source = replaceOnce(
    source,
    `        replies.push(await this.#runAgent(session, employee, collaborationPrompt, input.reasoningEffort, input.permissionMode))`,
    `        replies.push(await this.#runAgent(\n          session,\n          employee,\n          collaborationPrompt,\n          input.reasoningEffort,\n          input.permissionMode,\n          clientTurnIdFrom(input.metadata),\n        ))`,
    'group turn client id',
  )
  source = replaceOnce(
    source,
    `    permissionMode?: AgentPermissionMode,\n  ): Promise<AgentReply> {`,
    `    permissionMode?: AgentPermissionMode,\n    clientTurnId?: string,\n  ): Promise<AgentReply> {`,
    'run agent client id argument',
  )
  source = replaceOnce(
    source,
    `            ...event,\n            metadata: { ...event.metadata, traceTurnId },\n          }`,
    `            ...event,\n            metadata: {\n              ...event.metadata,\n              traceTurnId,\n              ...(clientTurnId === undefined ? {} : { clientTurnId }),\n            },\n          }`,
    'realtime event client id',
  )
  source = replaceOnce(
    source,
    `            source: 'runtime-final-response',\n            agentSessionId: result.agentSessionId,\n            traceTurnId,\n          },`,
    `            source: 'runtime-final-response',\n            agentSessionId: result.agentSessionId,\n            traceTurnId,\n            ...(clientTurnId === undefined ? {} : { clientTurnId }),\n          },`,
    'fallback assistant client id',
  )
  source = replaceOnce(
    source,
    `function requiredText(value: string, label: string): string {`,
    `function clientTurnIdFrom(metadata?: JsonObject): string | undefined {\n  const value = metadata?.clientTurnId\n  return typeof value === 'string' && value.trim().length > 0 ? value : undefined\n}\n\nfunction requiredText(value: string, label: string): string {`,
    'client id metadata helper',
  )
  return source
})

await patch('packages/orchestration/tests/conversation-orchestrator.test.ts', (initial) => {
  let source = initial
  source = replaceOnce(
    source,
    `      employeeId: employee.id,\n      prompt: '检查登录性能',\n    })`,
    `      employeeId: employee.id,\n      prompt: '检查登录性能',\n      metadata: { clientTurnId: 'client-turn-direct' },\n    })`,
    'first direct client id fixture',
  )
  source = replaceOnce(
    source,
    `      sessionId: first.session.id,\n      prompt: '继续给出验收标准',\n    })`,
    `      sessionId: first.session.id,\n      prompt: '继续给出验收标准',\n      metadata: { clientTurnId: 'client-turn-direct' },\n    })`,
    'second direct client id fixture',
  )
  source = replaceOnce(
    source,
    `    expect(realtime.some((event) => event.kind === 'reasoning.delta')).toBe(true)`,
    `    expect(realtime.some((event) => event.kind === 'reasoning.delta')).toBe(true)\n    expect(realtime.every((event) => event.metadata.clientTurnId === 'client-turn-direct')).toBe(true)`,
    'client id realtime assertion',
  )
  return source
})

await patch('packages/web/src/components/ChatWorkbench.tsx', (initial) => {
  let source = initial
  source = replaceOnce(
    source,
    `  installedPlugins?: InstalledPluginCommand[]\n  sending: boolean\n  draft: string`,
    `  installedPlugins?: InstalledPluginCommand[]\n  pendingCount?: number\n  queuedCount?: number\n  draft: string`,
    'chat workbench pending props',
  )
  source = replaceOnce(
    source,
    `export function ChatWorkbench({ demoMode, world, session, intent, participantIds = [], messages, employees, installedPlugins = [], sending, draft, focusRequest = 0, onDraftChange, onSend, onUploadAttachment, onOpenDossier, onOpenArtifact, onRecruit, onOpenPluginMarket }: ChatWorkbenchProps) {`,
    `export function ChatWorkbench({ demoMode, world, session, intent, participantIds = [], messages, employees, installedPlugins = [], pendingCount = 0, queuedCount = 0, draft, focusRequest = 0, onDraftChange, onSend, onUploadAttachment, onOpenDossier, onOpenArtifact, onRecruit, onOpenPluginMarket }: ChatWorkbenchProps) {`,
    'chat workbench destructuring',
  )
  source = replaceOnce(
    source,
    `    if (nearBottom || sending) container.scrollTop = container.scrollHeight\n  }, [visibleMessages, sending])`,
    `    if (nearBottom || pendingCount > 0) container.scrollTop = container.scrollHeight\n  }, [visibleMessages, pendingCount])`,
    'chat auto scroll',
  )
  source = replaceOnce(
    source,
    `    if ((!prompt && attachments.length === 0) || sending || uploading) return`,
    `    if ((!prompt && attachments.length === 0) || uploading) return`,
    'composer submission lock',
  )
  source = replaceOnce(
    source,
    `<div className="message-scroll" ref={scrollRef} aria-live="polite" aria-busy={sending}>`,
    `<div className="message-scroll" ref={scrollRef} aria-live="polite" aria-busy={pendingCount > 0}>`,
    'message aria busy',
  )
  source = replaceOnce(
    source,
    `          const owner = message.senderKind === 'owner'\n          if (message.kind === 'system') return <div key={message.id} className="chat-system-notice" role="status">{message.content}</div>`,
    `          const owner = message.senderKind === 'owner'\n          const streaming = message.metadata.streaming === true\n          if (message.kind === 'system') return <div key={message.id} className="chat-system-notice" role="status">{message.content}</div>`,
    'streaming message marker',
  )
  source = replaceOnce(
    source,
    `<article key={message.id} className={\`message\${owner ? ' message--owner' : ''}\`}>`,
    `<article key={message.id} className={\`message\${owner ? ' message--owner' : ''}\${streaming ? ' message--streaming' : ''}\`}>`,
    'streaming message class',
  )
  source = replaceOnce(
    source,
    `<div className="message__content"><RichText value={message.content} /></div>`,
    `<div className="message__content">{streaming && message.content.length === 0 ? <span className="stream-placeholder">正在生成回复…</span> : <RichText value={message.content} />}{streaming ? <span className="stream-cursor" aria-hidden="true" /> : null}</div>`,
    'streaming message content',
  )
  source = replaceOnce(
    source,
    `{sending ? <div className="stream-state"><CircleNotch size={16} className="spin" /><span>处理中…</span></div> : null}`,
    `{pendingCount > 0 ? <div className="stream-state" role="status"><CircleNotch size={16} className="spin" /><span>角色正在回复，你可以继续补充，也可以切换到其他会话。</span>{queuedCount > 0 ? <strong>另有 {queuedCount} 条已排队</strong> : null}</div> : null}`,
    'non blocking stream status',
  )
  source = replaceOnce(
    source,
    `<button className="send-button" type="button" aria-label={sending ? '角色处理中' : '发送'} disabled={sending || uploading || employees.length === 0 || (!draft.trim() && attachments.length === 0)} onClick={() => void submit()}>{sending ? <CircleNotch size={19} className="spin" /> : <PaperPlaneRight size={19} weight="fill" />}</button>`,
    `<button className="send-button" type="button" aria-label="发送" disabled={uploading || employees.length === 0 || (!draft.trim() && attachments.length === 0)} onClick={() => void submit()}><PaperPlaneRight size={19} weight="fill" />{queuedCount > 0 ? <span className="send-button__queue" aria-label={\`\${queuedCount} 条消息已排队\`}>{queuedCount}</span> : null}</button>`,
    'always available send button',
  )
  return source
})

await patch('packages/web/src/App.tsx', (initial) => {
  let source = initial
  source = replaceOnce(
    source,
    `import { ApiError, api } from './api.js'`,
    `import { ApiError, api } from './api.js'\nimport {\n  ChatTurnQueue,\n  mergeChatTimeline,\n  messageClientTurnId,\n  type PendingChatTurn,\n  type StreamingChatReply,\n} from './chat-realtime.js'`,
    'chat realtime imports',
  )
  source = replaceOnce(
    source,
    `  const [draft, setDraft] = useState('')\n  const [composerFocusRequest, setComposerFocusRequest] = useState(0)\n  const [sending, setSending] = useState(false)`,
    `  const [draft, setDraft] = useState('')\n  const [composerFocusRequest, setComposerFocusRequest] = useState(0)\n  const [pendingTurns, setPendingTurns] = useState<PendingChatTurn[]>([])\n  const [outboxMessages, setOutboxMessages] = useState<Record<string, WorkMessage[]>>({})\n  const [streamingReplies, setStreamingReplies] = useState<Record<string, StreamingChatReply>>({})\n  const turnQueueRef = useRef(new ChatTurnQueue())\n  const sessionByQueueKeyRef = useRef(new Map<string, string>())\n  const queueKeyBySessionRef = useRef(new Map<string, string>())\n  const pendingTurnsRef = useRef<PendingChatTurn[]>([])\n  const activeWorldRef = useRef<World | undefined>(undefined)\n  const activeSessionIdRef = useRef<string | undefined>(undefined)\n  const activeConversationKeyRef = useRef<string | undefined>(undefined)`,
    'chat realtime state',
  )
  source = replaceOnce(
    source,
    `  const supportsWorldRuntime = worldRuntimeV2Enabled && worldRuntimeAvailable\n\n  const loadWorld`,
    `  const supportsWorldRuntime = worldRuntimeV2Enabled && worldRuntimeAvailable\n  const activeConversationKey = conversationQueueKey(\n    conversationIntent,\n    activeSession,\n    activeParticipantIds,\n    queueKeyBySessionRef.current,\n  )\n  const activePendingTurns = pendingTurns.filter((turn) =>\n    turn.worldId === activeWorld?.id && turn.queueKey === activeConversationKey,\n  )\n  const activeStreamingReplies = Object.values(streamingReplies).filter((reply) =>\n    reply.worldId === activeWorld?.id && reply.queueKey === activeConversationKey,\n  )\n  const activeOutboxMessages = activeConversationKey === undefined ? [] : outboxMessages[activeConversationKey] ?? []\n  const chatMessages = useMemo(\n    () => mergeChatTimeline(messages, activeOutboxMessages, activePendingTurns, activeStreamingReplies),\n    [activeOutboxMessages, activePendingTurns, activeStreamingReplies, messages],\n  )\n  const activePendingCount = activePendingTurns.filter((turn) => turn.status === 'queued' || turn.status === 'running').length\n  const activeQueuedCount = activePendingTurns.filter((turn) => turn.status === 'queued').length\n  activeWorldRef.current = activeWorld\n  activeSessionIdRef.current = activeSessionId\n  activeConversationKeyRef.current = activeConversationKey\n  pendingTurnsRef.current = pendingTurns\n\n  const loadWorld`,
    'active chat realtime derivations',
  )

  const sessionEffectStart = `  useEffect(() => {\n    if (demoMode || activeSessionId === undefined) return\n    let cancelled = false\n    void api<{ items: WorkMessage[] }>(\`/api/sessions/\${activeSessionId}/messages\`)`
  source = replaceOnce(
    source,
    sessionEffectStart,
    `  const patchPendingTurn = useCallback((turnId: string, patch: Partial<PendingChatTurn>) => {\n    setPendingTurns((current) => {\n      const next = current.map((turn) => turn.id === turnId ? { ...turn, ...patch } : turn)\n      pendingTurnsRef.current = next\n      return next\n    })\n  }, [])\n\n  const removePendingTurn = useCallback((turnId: string) => {\n    setPendingTurns((current) => {\n      const next = current.filter((turn) => turn.id !== turnId)\n      pendingTurnsRef.current = next\n      return next\n    })\n  }, [])\n\n  const bindConversationSession = useCallback((queueKey: string, session: WorkSession, employeeIds: string[]) => {\n    sessionByQueueKeyRef.current.set(queueKey, session.id)\n    queueKeyBySessionRef.current.set(session.id, queueKey)\n    setPendingTurns((current) => {\n      const next = current.map((turn) => turn.queueKey === queueKey && turn.sessionId === undefined\n        ? { ...turn, sessionId: session.id }\n        : turn)\n      pendingTurnsRef.current = next\n      return next\n    })\n    if (activeWorldRef.current?.id !== session.worldId) return\n    setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])\n    setSessionParticipants((current) => ({ ...current, [session.id]: employeeIds }))\n    if (activeConversationKeyRef.current === queueKey) {\n      setActiveSessionId(session.id)\n      setConversationIntent(undefined)\n    }\n  }, [])\n\n  const refreshConversationTranscript = useCallback(async (sessionId: string, queueKey: string, worldId: string, reportError = false) => {\n    try {\n      const result = await api<{ items: WorkMessage[] }>(\`/api/sessions/\${sessionId}/messages\`)\n      setOutboxMessages((current) => reconcileOutboxMessages(current, queueKey, result.items))\n      if (activeWorldRef.current?.id === worldId && activeConversationKeyRef.current === queueKey) {\n        setMessages(result.items)\n        const participantIds = participantIdsFromMessages(result.items)\n        if (participantIds.length > 0) {\n          setSessionParticipants((current) => ({ ...current, [sessionId]: participantIds }))\n        }\n      }\n      return result.items\n    } catch (cause) {\n      if (reportError && activeWorldRef.current?.id === worldId && activeConversationKeyRef.current === queueKey) {\n        setError(cause instanceof Error ? cause.message : '会话加载失败')\n      }\n      return undefined\n    }\n  }, [])\n\n${sessionEffectStart}`,
    'chat realtime callbacks',
  )

  source = replaceBetween(
    source,
    `  useEffect(() => {\n    if (demoMode || activeSessionId === undefined) return\n    let cancelled = false\n    void api<{ items: WorkMessage[] }>(\`/api/sessions/\${activeSessionId}/messages\`)`,
    `  useEffect(() => {\n    if (demoMode || activeWorld === undefined) return\n    const stream = new EventSource`,
    `  useEffect(() => {\n    if (demoMode || activeSessionId === undefined) return\n    let cancelled = false\n    const queueKey = queueKeyBySessionRef.current.get(activeSessionId) ?? activeConversationKeyRef.current\n    void api<{ items: WorkMessage[] }>(\`/api/sessions/\${activeSessionId}/messages\`)\n      .then((result) => {\n        if (cancelled) return\n        setMessages(result.items)\n        if (queueKey !== undefined) {\n          sessionByQueueKeyRef.current.set(queueKey, activeSessionId)\n          queueKeyBySessionRef.current.set(activeSessionId, queueKey)\n          setOutboxMessages((current) => reconcileOutboxMessages(current, queueKey, result.items))\n        }\n        const participantIds = participantIdsFromMessages(result.items)\n        if (participantIds.length > 0) {\n          setSessionParticipants((current) => ({ ...current, [activeSessionId]: participantIds }))\n        }\n      })\n      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '会话加载失败') })\n    return () => { cancelled = true }\n  }, [activeSessionId])\n\n`,
    'active session transcript effect',
  )

  source = replaceBetween(
    source,
    `  useEffect(() => {\n    if (demoMode || activeWorld === undefined) return\n    const stream = new EventSource`,
    `  useEffect(() => {\n    const root = document.documentElement`,
    `  useEffect(() => {\n    if (demoMode || activeWorld === undefined) return\n    const world = activeWorld\n    const stream = new EventSource(\`/api/worlds/\${encodeURIComponent(world.id)}/live\`)\n    const onRuntime = (raw: Event) => {\n      const message = raw as MessageEvent<string>\n      try {\n        const envelope = JSON.parse(message.data) as RuntimeEnvelope\n        if (envelope.worldId !== world.id) return\n        const status = runtimeEmployeeStatus(envelope.event)\n        if (status !== undefined) {\n          setEmployees((current) => current.map((employee) => employee.id === envelope.agentId\n            ? { ...employee, status, currentActivity: runtimeActivity(envelope.event, employee.role) }\n            : employee))\n        }\n\n        const clientTurnId = metadataText(envelope.event.metadata.clientTurnId)\n        const traceTurnId = metadataText(envelope.event.metadata.traceTurnId)\n        if (clientTurnId === undefined || traceTurnId === undefined) return\n        const pending = pendingTurnsRef.current.find((turn) => turn.id === clientTurnId)\n        const queueKey = pending?.queueKey\n          ?? queueKeyBySessionRef.current.get(envelope.sessionId)\n          ?? (activeSessionIdRef.current === envelope.sessionId ? activeConversationKeyRef.current : undefined)\n        if (queueKey === undefined) return\n\n        if (pending !== undefined && pending.sessionId !== envelope.sessionId) {\n          const timestamp = new Date().toISOString()\n          bindConversationSession(queueKey, {\n            id: envelope.sessionId,\n            workspaceId: world.workspaceId,\n            worldId: world.id,\n            kind: pending.employeeIds.length > 1 ? 'group' : 'direct',\n            title: pending.title,\n            status: 'open',\n            createdAt: timestamp,\n            updatedAt: timestamp,\n          }, pending.employeeIds)\n        } else {\n          sessionByQueueKeyRef.current.set(queueKey, envelope.sessionId)\n          queueKeyBySessionRef.current.set(envelope.sessionId, queueKey)\n        }\n\n        const streamId = \`stream-\${traceTurnId}\`\n        const upsertStream = (content: string, replaceContent: boolean) => {\n          setStreamingReplies((current) => {\n            const previous = current[streamId]\n            const createdAt = previous?.createdAt ?? new Date().toISOString()\n            return {\n              ...current,\n              [streamId]: {\n                id: streamId,\n                queueKey,\n                worldId: world.id,\n                sessionId: envelope.sessionId,\n                employeeId: envelope.agentId,\n                clientTurnId,\n                traceTurnId,\n                content: replaceContent ? content : \`\${previous?.content ?? ''}\${content}\`,\n                createdAt,\n              },\n            }\n          })\n        }\n\n        if (envelope.event.kind === 'turn.started') upsertStream('', true)\n        if (envelope.event.kind === 'text.delta' && envelope.event.content !== undefined) {\n          upsertStream(envelope.event.content, false)\n        }\n        if (envelope.event.kind === 'assistant.message' && envelope.event.content?.trim()) {\n          upsertStream(envelope.event.content, true)\n        }\n        if (envelope.event.kind === 'turn.completed' || envelope.event.kind === 'turn.failed') {\n          void refreshConversationTranscript(envelope.sessionId, queueKey, world.id).finally(() => {\n            setStreamingReplies((current) => {\n              if (current[streamId] === undefined) return current\n              const next = { ...current }\n              delete next[streamId]\n              return next\n            })\n          })\n        }\n      } catch {\n        // Ignore malformed transient data; the durable transcript remains authoritative.\n      }\n    }\n    stream.addEventListener('runtime', onRuntime)\n    return () => {\n      stream.removeEventListener('runtime', onRuntime)\n      stream.close()\n    }\n  }, [activeWorld, bindConversationSession, refreshConversationTranscript])\n\n`,
    'runtime streaming effect',
  )

  source = replaceOnce(
    source,
    `    setActiveSessionId(sessionId)\n    setDraft('')`,
    `    setActiveSessionId(sessionId)\n    if (!demoMode) setMessages([])\n    setDraft('')`,
    'clear stale session messages',
  )

  source = replaceBetween(
    source,
    `  const send = useCallback(async (prompt: string, attachments: ChatAttachment[]) => {`,
    `  const refreshTaskSchedules = useCallback`,
    `  const send = useCallback((prompt: string, attachments: ChatAttachment[]): Promise<void> => {\n    const world = activeWorld\n    if (world === undefined) return Promise.resolve()\n    const explicitEmployeeIds = conversationIntent?.employeeIds\n      ?? (activeSessionId === undefined ? [] : sessionParticipants[activeSessionId] ?? [])\n    const mentioned = employees.filter((employee) => prompt.includes(\`@\${employee.displayName}\`))\n    const targetIds = explicitEmployeeIds.length > 0 ? explicitEmployeeIds : mentioned.map((employee) => employee.id)\n    if (targetIds.length === 0) {\n      setError('请选择或 @ 至少一个角色')\n      return Promise.resolve()\n    }\n\n    const title = conversationIntent?.title\n      ?? activeSession?.title\n      ?? (targetIds.length === 1\n        ? \`与 \${employees.find((employee) => employee.id === targetIds[0])?.displayName ?? '角色'} 对话\`\n        : compactPrompt(prompt))\n    const queueKey = activeConversationKey ?? targetConversationQueueKey(targetIds, title)\n    const clientTurnId = crypto.randomUUID()\n    const createdAt = new Date().toISOString()\n    const capturedSessionId = activeSessionId\n    const interactionKind = conversationIntent?.kind === 'group' || targetIds.length > 1\n      ? 'meeting'\n      : /(?:^|\\s)任务[：:]/.test(prompt) ? 'task' : 'chat'\n    if (capturedSessionId !== undefined) {\n      sessionByQueueKeyRef.current.set(queueKey, capturedSessionId)\n      queueKeyBySessionRef.current.set(capturedSessionId, queueKey)\n    }\n\n    const pendingTurn: PendingChatTurn = {\n      id: clientTurnId,\n      queueKey,\n      worldId: world.id,\n      employeeIds: targetIds,\n      title,\n      status: 'queued',\n      createdAt,\n      ...(capturedSessionId === undefined ? {} : { sessionId: capturedSessionId }),\n    }\n    const optimisticMessage: WorkMessage = {\n      id: \`local-owner-\${clientTurnId}\`,\n      sessionId: capturedSessionId ?? \`pending-\${clientTurnId}\`,\n      sequence: Number.MAX_SAFE_INTEGER,\n      senderId: 'owner',\n      senderKind: 'owner',\n      kind: 'user',\n      content: prompt,\n      metadata: {\n        clientTurnId,\n        localPending: true,\n        displayTime: new Date(createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),\n        participantIds: targetIds,\n        ...(attachments.length === 0 ? {} : { attachments: serializableAttachments(attachments) }),\n      },\n      createdAt,\n    }\n\n    setDraft('')\n    setError(undefined)\n    setPendingTurns((current) => {\n      const next = [...current, pendingTurn]\n      pendingTurnsRef.current = next\n      return next\n    })\n    setOutboxMessages((current) => ({\n      ...current,\n      [queueKey]: [...(current[queueKey] ?? []), optimisticMessage],\n    }))\n\n    const runTurn = async () => {\n      patchPendingTurn(clientTurnId, { status: 'running' })\n      try {\n        const resolvedSessionId = sessionByQueueKeyRef.current.get(queueKey) ?? capturedSessionId\n        if (demoMode) {\n          const session = resolvedSessionId === undefined\n            ? makeDemoSession(world, prompt, targetIds.length > 1 ? 'group' : 'direct', title)\n            : {\n                id: resolvedSessionId,\n                workspaceId: world.workspaceId,\n                worldId: world.id,\n                kind: targetIds.length > 1 ? 'group' as const : 'direct' as const,\n                title,\n                status: 'open' as const,\n                createdAt,\n                updatedAt: new Date().toISOString(),\n              }\n          bindConversationSession(queueKey, session, targetIds)\n          await delay(650)\n          const targets = targetIds\n            .map((id) => employees.find((employee) => employee.id === id))\n            .filter((employee): employee is CyberEmployee => employee !== undefined)\n          const ownerMessage = makeDemoMessage(session.id, Date.now(), 'owner', 'owner', 'user', prompt, {\n            clientTurnId,\n            participantIds: targetIds,\n            ...(attachments.length === 0 ? {} : { attachments: serializableAttachments(attachments) }),\n          })\n          const replies = targets.map((employee, index) => makeDemoMessage(\n            session.id,\n            Date.now() + index + 1,\n            employee.id,\n            'employee',\n            'assistant',\n            worldExperience(world).kind === 'tavern'\n              ? tavernDemoReply(employee, prompt)\n              : \`\${employee.displayName}收到。我会以\${employee.role}的职责独立处理“\${compactPrompt(prompt)}”，完成后给出证据、产物和下一步。\`,\n            { clientTurnId },\n          ))\n          if (activeWorldRef.current?.id === world.id && activeConversationKeyRef.current === queueKey) {\n            setMessages((current) => [...current.filter((message) => messageClientTurnId(message) !== clientTurnId), ownerMessage, ...replies])\n          }\n          setOutboxMessages((current) => removeOutboxTurn(current, queueKey, clientTurnId))\n          removePendingTurn(clientTurnId)\n          return\n        }\n\n        const result = await api<ChatResult>(\`/api/worlds/\${world.id}/chat\`, {\n          method: 'POST',\n          body: JSON.stringify({\n            prompt,\n            clientTurnId,\n            reasoningEffort,\n            permissionMode,\n            interactionKind,\n            ...(attachments.length === 0 ? {} : { attachments }),\n            employeeIds: targetIds,\n            ...(conversationIntent === undefined ? {} : { title }),\n            ...(resolvedSessionId === undefined ? {} : { sessionId: resolvedSessionId }),\n          }),\n        })\n        bindConversationSession(queueKey, result.session, targetIds)\n        await refreshConversationTranscript(result.session.id, queueKey, world.id, true)\n        setStreamingReplies((current) => removeStreamingTurn(current, clientTurnId))\n        removePendingTurn(clientTurnId)\n      } catch (cause) {\n        const failure = cause instanceof Error ? cause.message : '消息发送失败'\n        const failedSessionId = sessionByQueueKeyRef.current.get(queueKey) ?? capturedSessionId\n        if (failedSessionId !== undefined && !demoMode) {\n          await refreshConversationTranscript(failedSessionId, queueKey, world.id)\n        }\n        patchPendingTurn(clientTurnId, {\n          status: 'failed',\n          error: failure,\n          ...(failedSessionId === undefined ? {} : { sessionId: failedSessionId }),\n        })\n        setStreamingReplies((current) => removeStreamingTurn(current, clientTurnId))\n        if (activeWorldRef.current?.id === world.id && activeConversationKeyRef.current === queueKey) setError(failure)\n      }\n    }\n\n    void turnQueueRef.current.enqueue(queueKey, runTurn)\n    return Promise.resolve()\n  }, [\n    activeConversationKey,\n    activeSession,\n    activeSessionId,\n    activeWorld,\n    bindConversationSession,\n    conversationIntent,\n    employees,\n    patchPendingTurn,\n    permissionMode,\n    reasoningEffort,\n    refreshConversationTranscript,\n    removePendingTurn,\n    sessionParticipants,\n  ])\n\n`,
    'non blocking queued send',
  )

  source = replaceOnce(
    source,
    `            messages={messages}\n            employees={employees}\n            installedPlugins={installedPluginCommands}\n            sending={sending}`,
    `            messages={chatMessages}\n            employees={employees}\n            installedPlugins={installedPluginCommands}\n            pendingCount={activePendingCount}\n            queuedCount={activeQueuedCount}`,
    'chat workbench realtime props',
  )

  source = replaceOnce(
    source,
    `function scheduleErrorLabel(code?: string): string {`,
    `function conversationQueueKey(\n  intent: ConversationIntent | undefined,\n  session: WorkSession | undefined,\n  participantIds: string[],\n  aliases: Map<string, string>,\n): string | undefined {\n  const kind = intent?.kind ?? session?.kind\n  const ids = intent?.employeeIds ?? participantIds\n  if (kind === 'direct' && ids[0] !== undefined) return \`direct:\${ids[0]}\`\n  if (session !== undefined) return aliases.get(session.id) ?? \`session:\${session.id}\`\n  if (intent !== undefined) return targetConversationQueueKey(intent.employeeIds, intent.title)\n  return undefined\n}\n\nfunction targetConversationQueueKey(employeeIds: string[], title: string): string {\n  if (employeeIds.length === 1) return \`direct:\${employeeIds[0]}\`\n  return \`intent:group:\${[...employeeIds].sort().join(',')}:\${title.trim()}\`\n}\n\nfunction metadataText(value: JsonObject[string]): string | undefined {\n  return typeof value === 'string' && value.length > 0 ? value : undefined\n}\n\nfunction reconcileOutboxMessages(\n  current: Record<string, WorkMessage[]>,\n  queueKey: string,\n  durableMessages: WorkMessage[],\n): Record<string, WorkMessage[]> {\n  const persistedTurnIds = new Set(durableMessages.flatMap((message) => {\n    const clientTurnId = messageClientTurnId(message)\n    return clientTurnId === undefined ? [] : [clientTurnId]\n  }))\n  const remaining = (current[queueKey] ?? []).filter((message) => {\n    const clientTurnId = messageClientTurnId(message)\n    return clientTurnId === undefined || !persistedTurnIds.has(clientTurnId)\n  })\n  if (remaining.length === (current[queueKey] ?? []).length) return current\n  const next = { ...current }\n  if (remaining.length === 0) delete next[queueKey]\n  else next[queueKey] = remaining\n  return next\n}\n\nfunction removeOutboxTurn(\n  current: Record<string, WorkMessage[]>,\n  queueKey: string,\n  clientTurnId: string,\n): Record<string, WorkMessage[]> {\n  const remaining = (current[queueKey] ?? []).filter((message) => messageClientTurnId(message) !== clientTurnId)\n  const next = { ...current }\n  if (remaining.length === 0) delete next[queueKey]\n  else next[queueKey] = remaining\n  return next\n}\n\nfunction removeStreamingTurn(\n  current: Record<string, StreamingChatReply>,\n  clientTurnId: string,\n): Record<string, StreamingChatReply> {\n  const entries = Object.entries(current).filter(([, reply]) => reply.clientTurnId !== clientTurnId)\n  return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries)\n}\n\nfunction scheduleErrorLabel(code?: string): string {`,
    'chat realtime utility helpers',
  )
  return source
})

await appendFile('packages/web/src/styles.css', `\n\n/* Realtime conversation UX: streamed answers stay readable while the composer remains available. */\n.message--streaming .message__content {\n  border-color: color-mix(in srgb, var(--info) 52%, var(--border));\n  box-shadow: 0 0 0 1px color-mix(in srgb, var(--info) 18%, transparent), 0 4px 16px rgb(0 0 0 / 14%);\n}\n.stream-placeholder { color: var(--text-muted); font-size: var(--text-sm); }\n.stream-cursor {\n  display: inline-block; width: 7px; height: 1.05em; margin-left: 3px; vertical-align: -2px;\n  background: var(--info); border-radius: 2px; animation: stream-cursor-blink 900ms steps(1, end) infinite;\n}\n.stream-state { flex-wrap: wrap; row-gap: 4px; }\n.stream-state strong { margin-left: auto; color: var(--text-soft); font-size: var(--text-xs); font-weight: 600; }\n.send-button { position: relative; }\n.send-button__queue {\n  position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 4px;\n  display: grid; place-items: center; border: 2px solid var(--surface-1); border-radius: 999px;\n  color: #071116; background: var(--info); font-size: 10px; line-height: 1; font-weight: 750;\n}\n@keyframes stream-cursor-blink { 0%, 48% { opacity: 1; } 49%, 100% { opacity: .18; } }\n@media (prefers-reduced-motion: reduce) { .stream-cursor { animation: none; } }\n`)

console.log('Applied chat realtime UX patch.')
