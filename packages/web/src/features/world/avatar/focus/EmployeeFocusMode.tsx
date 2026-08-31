import { ArrowsClockwise, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EmployeeProfile, EmployeeVoiceProfile, VoiceModelDescriptor, World, WorldRuntimeEntityState, VoiceModelVoice } from '@dsh-cyber/contracts'
import { normalizeMossVoiceId } from '@dsh-cyber/contracts'

import { api } from '../../../../api.js'
import type { CyberEmployee } from '../../../../types.js'
import { motionCueForState, speechTextFromMessage, visualStateForEntity } from '../../digital-human-motion.js'
import { RegisteredDigitalHumanRenderer, selectRenderer } from '../renderer/RendererRegistry.js'
import { detectRenderingQuality, nextLowerQuality, type RenderingQuality } from '../renderer/RenderingQuality.js'
import { appendKokoroSpeech, KOKORO_CHINESE_VOICES, playKokoroSpeech, playMossSpeech, stopKokoroSpeech } from '../speech/KokoroSpeechAdapter.js'
import { normalizeSpeechVoices, resolveSpeechVoice } from '../speech/speech-voice-catalog.js'
import { SpriteRuntimeRenderer } from '../sprite/SpriteRuntimeRenderer.js'
import { VoiceConversationControl } from '../../../voice/VoiceConversationControl.js'
import { VoiceModelPackPicker } from '../../../voice/VoiceModelPackPicker.js'
import { StreamingSentenceChunker } from '../../../voice/StreamingSentenceChunker.js'
import { subscribeStreamingSpeech } from '../../../voice/streaming-speech-bus.js'
import { MAX_VOICE_SPEED, MIN_VOICE_SPEED, normalizeVoiceSpeed, resolveEmployeeVoiceProfile } from '../../../voice/employee-voice-profile.js'
import { claimSpeech, type SpeechClaim, type SpeechOwner } from '../../../voice/SpeechCoordinator.js'
import './employee-focus-mode.css'

type VoiceMode = 'off' | 'manual' | 'auto'
type CharacterRendererMode = '2d' | '3d'

interface FocusCollaborator {
  employee: CyberEmployee
  entity?: WorldRuntimeEntityState | undefined
}

interface EmployeeFocusModeProps {
  world: World
  employee: CyberEmployee
  profile?: EmployeeProfile
  entity?: WorldRuntimeEntityState
  collaborators: FocusCollaborator[]
  connected: boolean
  staticMode: boolean
  rendererMode: CharacterRendererMode
  /**
   * The character is already in the world behind this panel.
   *
   * The 3D world draws the character itself, so building a second avatar
   * stage here would open a second WebGL context for the same person — the
   * thing that made the map and the digital human feel like two products.
   * The panel keeps its name, status, chat and voice; only the stage goes.
   */
  embedded?: boolean
  latestUtterance?: { messageId: string; employeeId: string; text: string; clientTurnId?: string }
  onFocusEmployee(employeeId: string): void
  onManageAvatar(): void
  onStaticModeChange(value: boolean): void
  onVoiceFinal(text: string): Promise<void>
}

export function EmployeeFocusMode({ world, employee, profile, entity, collaborators, connected, staticMode, rendererMode, embedded = false, latestUtterance, onFocusEmployee, onManageAvatar, onStaticModeChange, onVoiceFinal }: EmployeeFocusModeProps) {
  const [rendererReady, setRendererReady] = useState(false)
  const [rendererArmed, setRendererArmed] = useState(false)
  const [rendererNotice, setRendererNotice] = useState<string>()
  const [quality, setQuality] = useState<RenderingQuality>('static')
  const [speaking, setSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | undefined>(undefined)
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(() => readVoiceMode(world.id, employee.id))
  const initialVoiceProfile = resolveEmployeeVoiceProfile(employee.id, profile?.gender, profile?.voiceProfile)
  const [voiceId, setVoiceId] = useState(() => readCachedVoiceId(world.id, employee.id, initialVoiceProfile.voiceId))
  const [voiceSpeed, setVoiceSpeed] = useState(() => readCachedVoiceSpeed(world.id, employee.id, initialVoiceProfile.speed))
  const [configuredVoiceProvider, setConfiguredVoiceProvider] = useState<EmployeeVoiceProfile['provider']>(profile?.voiceProfile.provider ?? 'auto')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceNotice, setVoiceNotice] = useState<string>()
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false)
  const [mossReady, setMossReady] = useState(false)
  const [mossVoices, setMossVoices] = useState<VoiceModelVoice[]>([])
  const voiceSaveTimerRef = useRef<number | undefined>(undefined)
  const streamChunkerRef = useRef(new StreamingSentenceChunker())
  const streamTurnRef = useRef<string | undefined>(undefined)
  const streamChainRef = useRef<Promise<void>>(Promise.resolve())
  const streamPendingRef = useRef(0)
  const streamCompleteRef = useRef(false)
  const streamedSpeechRef = useRef(false)
  const streamGenerationRef = useRef(0)
  const speechClaimRef = useRef<SpeechClaim | undefined>(undefined)
  const manualSpeechSequenceRef = useRef(0)
  const pendingVoiceProfileRef = useRef<EmployeeVoiceProfile | undefined>(undefined)
  const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  const utterance = latestUtterance?.employeeId === employee.id ? latestUtterance : undefined
  const spokenText = utterance === undefined ? '' : speechTextFromMessage(utterance.text)
  const lastAutoSpokenRef = useRef(readLastSpoken(world.id, employee.id) ?? (voiceMode === 'auto' ? utterance?.messageId : undefined))
  const state = visualStateForEntity(entity, connected, speaking)
  const motionCue = motionCueForState(state)
  const preferredRenderer = rendererMode === '2d' ? 'sprite-2d' : 'vrm-3d'
  const selectedRenderer = selectRenderer(employee, quality, preferredRenderer)
  const usesVrm = selectedRenderer.kind === 'vrm-3d'
  const chineseSystemVoices = voices.filter((voice) => /^zh(?:-|_)/iu.test(voice.lang))
  const compatibleKokoroVoices = profile?.gender === 'female'
    ? KOKORO_CHINESE_VOICES.filter((voice) => voice.gender === '女声')
    : profile?.gender === 'male'
      ? KOKORO_CHINESE_VOICES.filter((voice) => voice.gender === '男声')
      : KOKORO_CHINESE_VOICES
  const systemVoiceId = voiceId.startsWith('system:') ? voiceId.slice('system:'.length) : ''
  const selectedSystemVoice = resolveSpeechVoice(chineseSystemVoices, systemVoiceId)
  const selectedKokoroVoice = KOKORO_CHINESE_VOICES.find((voice) => voice.id === voiceId)
  const selectedVoiceMissing = selectedKokoroVoice === undefined && selectedSystemVoice === undefined
  const activeVoiceProvider = configuredVoiceProvider === 'auto' ? (mossReady ? 'moss' : 'kokoro') : configuredVoiceProvider
  const mossVoiceCount = mossVoices.length
  const mossVoiceOptions = mossVoices.length > 0 ? mossVoices : [{ id: 'moss:Junhao', label: '君豪 · 默认声音', gender: 'male' as const }]
  const mossVoiceCatalogEmpty = mossVoices.length === 0
  const updateVoiceModels = useCallback((models: VoiceModelDescriptor[]) => {
    const moss = models.find((model) => model.provider === 'moss')
    setMossReady(moss?.state === 'ready')
    // Whatever the installed pack ships, normalized once at the UI boundary.
    // An empty descriptor is still a valid response while a provider is
    // warming, so retain one actionable fallback instead of rendering a
    // controlled select with no option.
    const normalized = new Map<string, VoiceModelVoice>()
    for (const voice of moss?.voices ?? []) {
      const id = normalizeMossVoiceId(voice.id)
      if (!normalized.has(id)) normalized.set(id, { ...voice, id })
    }
    setMossVoices(normalized.size > 0 ? [...normalized.values()] : (moss?.state === 'ready' ? [{ id: 'moss:Junhao', label: '君豪 · 自然男声', gender: 'male' }] : []))
  }, [])

  useEffect(() => { setRendererReady(false); setRendererNotice(undefined) }, [employee.id, employee.avatarProfile?.assetId, quality, rendererMode])
  useEffect(() => { setConfiguredVoiceProvider(profile?.voiceProfile.provider ?? 'auto') }, [employee.id, profile?.voiceProfile.provider])
  useEffect(() => {
    setRendererArmed(!usesVrm)
    if (!usesVrm) return
    const timer = window.setTimeout(() => setRendererArmed(true), 420)
    return () => window.clearTimeout(timer)
  }, [employee.id, employee.avatarProfile?.assetId, quality, usesVrm])
  useEffect(() => {
    setQuality('static')
    if (staticMode || rendererMode === '2d') return
    const timer = window.setTimeout(() => setQuality(detectRenderingQuality(false)), 320)
    return () => window.clearTimeout(timer)
  }, [rendererMode, staticMode])

  const refreshVoices = useCallback(() => {
    if (!speechSupported) return
    const next = normalizeSpeechVoices(window.speechSynthesis.getVoices())
    setVoices(next)
    setVoiceNotice(next.length === 0 ? '系统声音仍在加载，请稍后刷新。' : undefined)
  }, [speechSupported])

  useEffect(() => {
    if (!speechSupported) return
    refreshVoices()
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices)
    const timers = [80, 280, 900, 2_200].map((delay) => window.setTimeout(refreshVoices, delay))
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices)
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [refreshVoices, speechSupported])

  useEffect(() => {
    try {
      localStorage.setItem(voiceModeKey(world.id, employee.id), voiceMode)
      localStorage.setItem(voiceIdKey(world.id, employee.id), voiceId)
      localStorage.setItem(voiceSpeedKey(world.id, employee.id), String(voiceSpeed))
    } catch { /* localStorage is optional */ }
  }, [employee.id, voiceId, voiceMode, voiceSpeed, world.id])

  const persistVoiceProfile = useCallback(async (next: EmployeeVoiceProfile) => {
    setConfiguredVoiceProvider(next.provider)
    if (profile === undefined) return
    try {
      await api<{ profile: EmployeeProfile }>(`/api/employees/${encodeURIComponent(employee.id)}/profile`, {
        method: 'PUT',
        body: JSON.stringify({ gender: profile.gender, voiceProfile: next, reason: '更新角色语音档案' }),
      })
      setVoiceNotice('已保存到角色档案')
    } catch (cause) {
      setVoiceNotice(cause instanceof Error ? cause.message : '角色语音档案保存失败')
    }
  }, [employee.id, profile])

  /**
   * Saves a voice change shortly after the user stops making them.
   *
   * It used to only park the change and wait for the settings panel to be
   * collapsed through its own button — so choosing a voice and then switching
   * character, or closing the panel any other way, silently threw the choice
   * away. Debounced rather than immediate because dragging the speed slider
   * would otherwise be one request per pixel.
   */
  const scheduleVoiceProfile = useCallback((next: EmployeeVoiceProfile) => {
    pendingVoiceProfileRef.current = next
    if (voiceSaveTimerRef.current !== undefined) window.clearTimeout(voiceSaveTimerRef.current)
    voiceSaveTimerRef.current = window.setTimeout(() => {
      voiceSaveTimerRef.current = undefined
      const pending = pendingVoiceProfileRef.current
      if (pending === undefined) return
      pendingVoiceProfileRef.current = undefined
      void persistVoiceProfile(pending)
    }, 600)
  }, [persistVoiceProfile])

  const flushVoiceProfile = useCallback(() => {
    if (voiceSaveTimerRef.current !== undefined) {
      window.clearTimeout(voiceSaveTimerRef.current)
      voiceSaveTimerRef.current = undefined
    }
    const next = pendingVoiceProfileRef.current
    if (next === undefined) return
    pendingVoiceProfileRef.current = undefined
    void persistVoiceProfile(next)
  }, [persistVoiceProfile])

  // Leaving the character, or the panel, must not be a way to lose a choice.
  useEffect(() => flushVoiceProfile, [flushVoiceProfile, employee.id])

  const releaseSpeechClaim = useCallback((token?: string) => {
    const claim = speechClaimRef.current
    if (claim === undefined || (token !== undefined && claim.token !== token)) return
    claim.release()
    speechClaimRef.current = undefined
  }, [])

  const stopSpeech = useCallback(() => {
    releaseSpeechClaim()
    stopKokoroSpeech()
    if (speechSupported) window.speechSynthesis.cancel()
    utteranceRef.current = undefined
    setSpeaking(false)
    setVoiceBusy(false)
    setVoiceNotice(undefined)
  }, [releaseSpeechClaim, speechSupported])

  const speak = useCallback(async (text: string, claimInput?: { turnId: string; owner: SpeechOwner }) => {
    if (text.trim().length === 0) return
    // Manual preview and a non-streaming fallback both supersede queued stream
    // chunks. The next runtime `start` installs a fresh turn and generation.
    streamGenerationRef.current += 1
    streamChunkerRef.current.reset()
    streamTurnRef.current = undefined
    streamCompleteRef.current = true
    stopSpeech()
    const claim = claimSpeech({
      employeeId: employee.id,
      turnId: claimInput?.turnId ?? `manual:${employee.id}:${++manualSpeechSequenceRef.current}`,
      owner: claimInput?.owner ?? 'manual',
    })
    if (claim === undefined) return
    speechClaimRef.current = claim
    const releaseClaim = () => {
      claim.release()
      if (speechClaimRef.current?.token === claim.token) speechClaimRef.current = undefined
    }
    if (activeVoiceProvider === 'moss' || voiceId.startsWith('kokoro:')) {
      setVoiceBusy(true)
      try {
        const play = activeVoiceProvider === 'moss' ? playMossSpeech : playKokoroSpeech
        await play({
          text,
          voiceId,
          speed: voiceSpeed,
          onStatus: setVoiceNotice,
          onStart: () => { setVoiceBusy(false); setSpeaking(true) },
          onEnd: () => { releaseClaim(); setVoiceBusy(false); setSpeaking(false); setVoiceNotice(undefined) },
        })
      } catch (cause) {
        setVoiceBusy(false)
        setSpeaking(false)
        if (cause instanceof Error && cause.name === 'AbortError') { releaseClaim(); setVoiceNotice(undefined); return }
        if (activeVoiceProvider === 'moss') {
          const fallbackVoiceId = compatibleKokoroVoices[0]!.id
          setVoiceNotice('自然语音暂不可用，已切换快速语音')
          try {
            await playKokoroSpeech({ text, voiceId: fallbackVoiceId, speed: voiceSpeed, onStatus: setVoiceNotice, onStart: () => setSpeaking(true), onEnd: () => { releaseClaim(); setSpeaking(false); setVoiceNotice(undefined) } })
            return
          } catch (fallbackError) {
            releaseClaim()
            cause = fallbackError
          }
        }
        // A voice pack that is not installed is a configuration the user has
        // not finished, not a fault: now that replies are spoken by default,
        // logging it would put an error in the console for every reply on
        // every machine without one. The panel says what to do instead.
        const missing = cause instanceof Error && /未安装|没有生成可播放音频|not_installed/iu.test(cause.message)
        if (!missing) console.error('Local Kokoro speech failed', cause)
        setVoiceNotice(missing
          ? '还没有可用的本地语音包，先在上面的语音引擎里安装一个。'
          : cause instanceof Error && !/fetch|network/iu.test(cause.message)
            ? `本地中文语音失败：${cause.message}`
            : '无法连接本地语音服务，请确认服务已启动。')
      }
      releaseClaim()
      return
    }
    if (!speechSupported) { releaseClaim(); setVoiceNotice('当前浏览器不支持系统语音，请选择本地 AI 中文声音。'); return }
    const exactVoice = resolveSpeechVoice(chineseSystemVoices, systemVoiceId)
    if (exactVoice === undefined) { releaseClaim(); setVoiceNotice('所选系统中文声音当前不可用，请刷新或改用本地 AI 中文声音。'); return }
    const value = new SpeechSynthesisUtterance(text)
    value.lang = exactVoice.lang
    value.rate = voiceSpeed
    value.pitch = 1
    value.voice = exactVoice
    setVoiceNotice(undefined)
    value.onstart = () => setSpeaking(true)
    value.onend = () => { releaseClaim(); utteranceRef.current = undefined; setSpeaking(false) }
    value.onerror = () => { releaseClaim(); utteranceRef.current = undefined; setSpeaking(false); setVoiceNotice('系统语音播放失败，请刷新声音目录或更换声音。') }
    utteranceRef.current = value
    setSpeaking(true)
    try { window.speechSynthesis.speak(value) } catch (cause) {
      releaseClaim()
      utteranceRef.current = undefined
      setSpeaking(false)
      setVoiceNotice(cause instanceof Error ? cause.message : '系统语音播放失败，请刷新声音目录或更换声音。')
    }
  }, [activeVoiceProvider, chineseSystemVoices, compatibleKokoroVoices, employee.id, speechSupported, stopSpeech, systemVoiceId, voiceId, voiceSpeed])

  const changeVoiceMode = useCallback((mode: VoiceMode) => {
    if (mode === 'off') stopSpeech()
    if (mode === 'auto' && utterance !== undefined) {
      lastAutoSpokenRef.current = utterance.messageId
      persistLastSpoken(world.id, employee.id, utterance.messageId)
    }
    setVoiceMode(mode)
  }, [employee.id, stopSpeech, utterance, world.id])

  const activateVoiceProvider = useCallback((provider: Exclude<EmployeeVoiceProfile['provider'], 'auto'>) => {
    let nextVoiceId = voiceId
    if (provider === 'kokoro' && !voiceId.startsWith('kokoro:')) nextVoiceId = compatibleKokoroVoices[0]!.id
    if (provider === 'system' && !voiceId.startsWith('system:')) {
      const systemVoice = chineseSystemVoices[0]
      if (systemVoice === undefined) { setVoiceNotice('当前系统没有可用的中文声音'); return }
      nextVoiceId = `system:${systemVoice.voiceURI}`
    }
    if (provider === 'moss') nextVoiceId = voiceId.startsWith('moss:') ? normalizeMossVoiceId(voiceId) : 'moss:Junhao'
    setVoiceId(nextVoiceId)
    void persistVoiceProfile({ provider, voiceId: nextVoiceId, speed: voiceSpeed, pitch: profile?.voiceProfile.pitch ?? 1 })
  }, [chineseSystemVoices, compatibleKokoroVoices, persistVoiceProfile, profile?.voiceProfile.pitch, voiceId, voiceSpeed])

  const enqueueStreamChunk = useCallback((content: string) => {
    const text = speechTextFromMessage(content)
    const claim = speechClaimRef.current
    const claimToken = claim?.owner === 'focus-stream' ? claim.token : undefined
    if (!text || claimToken === undefined || (!voiceId.startsWith('kokoro:') && activeVoiceProvider !== 'moss')) return
    streamedSpeechRef.current = true
    streamPendingRef.current += 1
    const queueGeneration = streamGenerationRef.current
    setVoiceBusy(true)
    const run = streamChainRef.current.catch(() => undefined).then(() => {
      if (queueGeneration !== streamGenerationRef.current) return
      return appendKokoroSpeech({
      text,
      voiceId,
      ...(activeVoiceProvider === 'moss' ? { provider: 'moss' as const } : {}),
      speed: voiceSpeed,
      onStatus: setVoiceNotice,
      onStart: () => { setVoiceBusy(false); setSpeaking(true) },
      onEnd: () => {
        streamPendingRef.current = Math.max(0, streamPendingRef.current - 1)
        if (streamCompleteRef.current && streamPendingRef.current === 0) {
          releaseSpeechClaim(claimToken)
          setSpeaking(false); setVoiceNotice(undefined)
        }
      },
      })
    }).catch((cause: unknown) => {
      streamPendingRef.current = Math.max(0, streamPendingRef.current - 1)
      setVoiceBusy(false)
      if (streamCompleteRef.current && streamPendingRef.current === 0) releaseSpeechClaim(claimToken)
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setVoiceNotice(cause instanceof Error ? `本地流式语音失败：${cause.message}` : '本地流式语音失败')
    })
    streamChainRef.current = run
  }, [activeVoiceProvider, releaseSpeechClaim, voiceId, voiceSpeed])

  useEffect(() => {
    if (voiceMode !== 'auto' || (!voiceId.startsWith('kokoro:') && activeVoiceProvider !== 'moss')) return
    return subscribeStreamingSpeech((event) => {
      if (event.employeeId !== employee.id) return
      if (event.kind === 'start') {
        streamGenerationRef.current += 1; stopSpeech(); streamChunkerRef.current.reset(); streamTurnRef.current = event.turnId
        speechClaimRef.current = claimSpeech({ employeeId: employee.id, turnId: event.clientTurnId ?? event.turnId, owner: 'focus-stream' })
        streamChainRef.current = Promise.resolve(); streamPendingRef.current = 0; streamCompleteRef.current = false; streamedSpeechRef.current = false
        return
      }
      if (streamTurnRef.current !== event.turnId) return
      if (event.kind === 'delta' && event.content !== undefined) {
        for (const chunk of streamChunkerRef.current.push(event.content)) enqueueStreamChunk(chunk)
      } else if (event.kind === 'complete') {
        for (const chunk of streamChunkerRef.current.flush()) enqueueStreamChunk(chunk)
        streamCompleteRef.current = true
        if (streamPendingRef.current === 0) { releaseSpeechClaim(); setSpeaking(false) }
      } else if (event.kind === 'cancel') {
        streamGenerationRef.current += 1; streamChunkerRef.current.reset(); streamCompleteRef.current = true; stopSpeech()
      }
    })
  }, [activeVoiceProvider, employee.id, enqueueStreamChunk, stopSpeech, voiceId, voiceMode])

  useEffect(() => {
    if (voiceMode !== 'auto' || utterance === undefined || utterance.messageId === lastAutoSpokenRef.current) return
    lastAutoSpokenRef.current = utterance.messageId
    persistLastSpoken(world.id, employee.id, utterance.messageId)
    if (streamedSpeechRef.current) return
    void speak(spokenText, { turnId: utterance.clientTurnId ?? utterance.messageId, owner: 'focus-stream' })
  }, [employee.id, speak, spokenText, utterance, voiceMode, world.id])
  useEffect(() => () => {
    stopSpeech()
  }, [stopSpeech])

  const fallback = useCallback((reason: string) => {
    setRendererReady(false)
    setRendererNotice(reason.includes('FPS') ? reason : `3D 形象暂时不可用，已切回 2D：${reason}`)
    setQuality((current) => reason.includes('FPS') ? nextLowerQuality(current) : 'static')
  }, [])

  const visibleCollaborators = collaborators.slice(0, 2)
  const remainingCollaborators = Math.max(0, collaborators.length - visibleCollaborators.length)
  const requestedVrmFallback = rendererMode === '3d' && employee.avatarProfile?.rendererKind !== 'vrm-3d'
    ? `${employee.displayName}还没有 3D 形象，世界里先使用默认形象出场。`
    : undefined
  const focusNotice = rendererNotice ?? requestedVrmFallback

  return <section className="employee-focus" aria-label={`${employee.displayName}员工聚焦`} data-state={state} data-renderer={selectedRenderer.kind} data-view-mode={rendererMode} data-quality={quality}>
    <div className="employee-focus__scrim" aria-hidden="true" />
    <header className="employee-focus__header">
      <div className="employee-focus__identity"><strong>{employee.displayName}</strong><span>{employee.role}</span></div>
      <div className="employee-focus__header-actions">
        <span className={`employee-focus__status is-${state}`}><i aria-hidden="true" />{stateLabel(state)}</span>
        <div className="employee-focus__voice"><button type="button" className="employee-focus__voice-trigger" aria-label="语音设置" aria-expanded={voiceSettingsOpen} onClick={() => { setVoiceSettingsOpen((current) => { const next = !current; if (!next) flushVoiceProfile(); return next }) }}>{speaking ? <SpeakerSlash size={17} aria-hidden="true" /> : <SpeakerHigh size={17} aria-hidden="true" />}语音</button>{voiceSettingsOpen ? <div>
          <header><span><strong>{employee.displayName}的语音</strong><small>{activeVoiceProvider === 'moss' ? `自然语音 · 本地运行${mossVoiceCount > 0 ? ` · ${mossVoiceCount} 个声音` : ''}` : `${KOKORO_CHINESE_VOICES.length} 个中文声音${chineseSystemVoices.length > 0 ? ` · ${chineseSystemVoices.length} 个系统中文声音` : ''}`}</small></span><button type="button" aria-label="刷新系统声音" onClick={refreshVoices}><ArrowsClockwise size={16} aria-hidden="true" /></button></header>
          <VoiceModelPackPicker value={configuredVoiceProvider} onActivate={activateVoiceProvider} onModelsChange={updateVoiceModels} />
          <label><span>播报模式</span><select aria-label="播报模式" value={voiceMode} onChange={(event) => changeVoiceMode(event.target.value as VoiceMode)}><option value="off">关闭</option><option value="manual">手动</option><option value="auto">自动播报新回复</option></select></label>
          {activeVoiceProvider === 'moss' ? <><label><span>角色声音</span><select aria-label="角色声音" disabled={mossVoiceCatalogEmpty} value={mossVoiceOptions.some((voice) => voice.id === voiceId) ? voiceId : mossVoiceOptions[0]!.id} onChange={(event) => { const nextVoiceId = normalizeMossVoiceId(event.target.value); setVoiceId(nextVoiceId); scheduleVoiceProfile({ provider: 'moss', voiceId: nextVoiceId, speed: voiceSpeed, pitch: profile?.voiceProfile.pitch ?? 1 }) }}>{mossVoiceOptions.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select></label>{mossVoiceCatalogEmpty ? <small className="employee-focus__voice-notice" role="status">语音目录暂未返回可用声音，安装完成后请刷新。</small> : null}</> : <label><span>角色声音</span><select aria-label="角色声音" value={voiceId} onChange={(event) => { const nextVoiceId = event.target.value; setVoiceId(nextVoiceId); setVoiceNotice(undefined); scheduleVoiceProfile({ provider: nextVoiceId.startsWith('system:') ? 'system' : 'kokoro', voiceId: nextVoiceId, speed: voiceSpeed, pitch: profile?.voiceProfile.pitch ?? 1 }) }}>{selectedVoiceMissing ? <option value={voiceId}>原声音当前不可用</option> : null}{profile?.gender === 'male' ? null : <optgroup label="中文女声">{compatibleKokoroVoices.filter((voice) => voice.gender === '女声').map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</optgroup>}{profile?.gender === 'female' ? null : <optgroup label="中文男声">{compatibleKokoroVoices.filter((voice) => voice.gender === '男声').map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</optgroup>}{chineseSystemVoices.length === 0 ? null : <optgroup label="Windows / 浏览器中文声音">{chineseSystemVoices.map((voice) => <option key={`${voice.voiceURI}:${voice.lang}`} value={`system:${voice.voiceURI}`}>{voice.name} · {voice.lang}{voice.localService ? ' · 本机' : ''}</option>)}</optgroup>}</select></label>}
          <label className="employee-focus__voice-speed"><span>语速 <output>{voiceSpeed.toFixed(2)}×</output></span><input aria-label="语速" type="range" min={MIN_VOICE_SPEED} max={MAX_VOICE_SPEED} step="0.05" value={voiceSpeed} onChange={(event) => { const speed = Number(event.target.value); setVoiceSpeed(speed); scheduleVoiceProfile({ provider: configuredVoiceProvider, voiceId, speed, pitch: profile?.voiceProfile.pitch ?? 1 }) }} /></label>
          <div className="employee-focus__voice-preview"><span><strong>当前播报</strong><small>{spokenText.length === 0 ? `当前会话里还没有 ${employee.displayName} 的最终回复` : `${employee.displayName}：${spokenText.slice(0, 72)}${spokenText.length > 72 ? '…' : ''}`}</small></span></div>
          <label className="employee-focus__motion"><input type="checkbox" checked={!staticMode} onChange={(event) => onStaticModeChange(!event.target.checked)} />启用角色动效</label>
          <div className="employee-focus__voice-buttons"><button type="button" disabled={voiceBusy} onClick={() => void speak(`你好，我是${employee.displayName}。这是当前声音的试听。`)}>{voiceBusy ? '正在准备…' : '试听声音'}</button><button type="button" disabled={!voiceBusy && !speaking && (spokenText.length === 0 || voiceMode === 'off')} onClick={voiceBusy || speaking ? stopSpeech : () => void speak(spokenText)}>{voiceBusy ? '取消生成' : speaking ? '停止播报' : `播放${employee.displayName}的回复`}</button></div>
          {voiceNotice === undefined ? null : <small className="employee-focus__voice-notice" role="status">{voiceNotice}</small>}
        </div> : null}</div>
      </div>
    </header>
    {employee.avatarProfile?.rendererKind === 'vrm-3d' ? null : <div className="employee-focus__avatar-invite">
      <span>还没有 3D 形象，世界里先用默认形象出场。</span>
      <button type="button" onClick={onManageAvatar}>创建 3D 形象</button>
    </div>}

    <div className="employee-focus__activity" aria-live="polite"><strong>{stateLabel(state)}</strong><span>{connected ? entity?.activityLabel ?? '等待事件触发' : '实时连接中断，正在重连'}</span></div>

    {embedded ? null : <div className="employee-focus__avatar-stage">
      {visibleCollaborators.map(({ employee: collaborator, entity: collaboratorEntity }, index) => {
        const collaboratorState = visualStateForEntity(collaboratorEntity, connected, false)
        return <button key={collaborator.id} type="button" className={`employee-focus__participant employee-focus__participant--${index === 0 ? 'left' : 'right'}`} aria-label={`聚焦${collaborator.displayName}数字人`} onClick={() => onFocusEmployee(collaborator.id)}>
          <span className="employee-focus__participant-figure"><SpriteRuntimeRenderer employee={collaborator} entity={collaboratorEntity} state={collaboratorState} motionCue={motionCueForState(collaboratorState)} speaking={false} staticMode quality="static" onReady={() => undefined} onFallback={() => undefined} /></span>
          <span className="employee-focus__participant-label"><strong>{collaborator.displayName}</strong><small>{collaborator.role}</small></span>
        </button>
      })}
      {remainingCollaborators === 0 ? null : <span className="employee-focus__participant-more">另有 {remainingCollaborators} 名角色</span>}
      {usesVrm ? <div className={`employee-focus__sprite-bridge${rendererReady ? ' is-hidden' : ''}`}><SpriteRuntimeRenderer employee={employee} entity={entity} state={state} motionCue={motionCue} speaking={speaking} staticMode={staticMode} quality="static" onReady={() => undefined} onFallback={() => undefined} /></div> : null}
      {rendererArmed ? <RegisteredDigitalHumanRenderer key={`${selectedRenderer.id}:${quality}:${employee.avatarProfile?.assetId ?? employee.avatarIndex}`} employee={employee} entity={entity} state={state} motionCue={motionCue} speaking={speaking} staticMode={staticMode} quality={quality} preferredKind={preferredRenderer} onReady={() => setRendererReady(true)} onFallback={fallback} /> : <div className="focus-avatar__loading" role="status">正在切换 3D 渲染器…</div>}
    </div>}
    <VoiceConversationControl employeeName={employee.displayName} onFinal={onVoiceFinal} onBargeIn={() => {
      streamGenerationRef.current += 1; streamPendingRef.current = 0; streamCompleteRef.current = true; streamChunkerRef.current.reset(); stopSpeech()
    }} />
    {focusNotice === undefined ? null : <div className="employee-focus__notice" role="status"><span>{focusNotice}</span>{requestedVrmFallback === undefined || rendererNotice !== undefined ? null : <button type="button" onClick={onManageAvatar}>创建 3D 形象</button>}</div>}
  </section>
}

function stateLabel(state: ReturnType<typeof visualStateForEntity>): string {
  return ({ idle: '待命', thinking: '思考中', executing: '执行中', speaking: '说话中', approval: '等待审批', failed: '失败' })[state]
}

function voiceModeKey(worldId: string, employeeId: string): string { return `dsh-cyber-digital-voice-mode:${worldId}:${employeeId}` }
function voiceIdKey(worldId: string, employeeId: string): string { return `dsh-cyber-digital-voice-id:${worldId}:${employeeId}` }
function voiceSpeedKey(worldId: string, employeeId: string): string { return `dsh-cyber-digital-voice-speed:${worldId}:${employeeId}` }
function lastSpokenKey(worldId: string, employeeId: string): string { return `dsh-cyber-digital-last-spoken:${worldId}:${employeeId}` }
/**
 * Whether a character speaks its replies aloud.
 *
 * Defaults to speaking. Someone who has opened a character's panel and can
 * press a microphone is having a conversation, and a conversation where the
 * other side answers only when you press a second button is not one — the
 * streaming subscription bails unless this is `auto`, so the old default made
 * the whole voice path silent until the user found this setting.
 */
function readVoiceMode(worldId: string, employeeId: string): VoiceMode { try { const value = localStorage.getItem(voiceModeKey(worldId, employeeId)) ?? localStorage.getItem(`dsh-cyber-digital-voice-mode:${worldId}`); return value === 'off' || value === 'manual' ? value : 'auto' } catch { return 'auto' } }
function readCachedVoiceId(worldId: string, employeeId: string, fallback: string): string {
  try {
    const saved = localStorage.getItem(voiceIdKey(worldId, employeeId))
    if (saved === null) return fallback
    if (saved.startsWith('system:')) return saved
    if (saved.startsWith('moss:')) return normalizeMossVoiceId(saved)
    return KOKORO_CHINESE_VOICES.some((voice) => voice.id === saved) ? saved : fallback
  } catch { return fallback }
}
// The fourth copy of the 0.8–1.3 bound: a saved faster speed was read back and
// silently discarded. Bounds are stated once, in normalizeVoiceSpeed.
function readCachedVoiceSpeed(worldId: string, employeeId: string, fallback: number): number { try { const raw = localStorage.getItem(voiceSpeedKey(worldId, employeeId)); return raw === null ? fallback : normalizeVoiceSpeed(Number(raw)) } catch { return fallback } }
function readLastSpoken(worldId: string, employeeId: string): string | undefined { try { return localStorage.getItem(lastSpokenKey(worldId, employeeId)) ?? undefined } catch { return undefined } }
function persistLastSpoken(worldId: string, employeeId: string, messageId: string): void { try { localStorage.setItem(lastSpokenKey(worldId, employeeId), messageId) } catch { /* localStorage is optional */ } }
