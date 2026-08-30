import { ArrowsClockwise, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { World, WorldRuntimeEntityState } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../../../types.js'
import { motionCueForState, speechTextFromMessage, visualStateForEntity } from '../../digital-human-motion.js'
import { RegisteredDigitalHumanRenderer, selectRenderer } from '../renderer/RendererRegistry.js'
import { detectRenderingQuality, nextLowerQuality, type RenderingQuality } from '../renderer/RenderingQuality.js'
import { appendKokoroSpeech, KOKORO_CHINESE_VOICES, playKokoroSpeech, stopKokoroSpeech } from '../speech/KokoroSpeechAdapter.js'
import { normalizeSpeechVoices, resolveSpeechVoice } from '../speech/speech-voice-catalog.js'
import { SpriteRuntimeRenderer } from '../sprite/SpriteRuntimeRenderer.js'
import { VoiceConversationControl } from '../../../voice/VoiceConversationControl.js'
import { StreamingSentenceChunker } from '../../../voice/StreamingSentenceChunker.js'
import { subscribeStreamingSpeech } from '../../../voice/streaming-speech-bus.js'
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
  entity?: WorldRuntimeEntityState
  collaborators: FocusCollaborator[]
  connected: boolean
  staticMode: boolean
  rendererMode: CharacterRendererMode
  latestUtterance?: { messageId: string; employeeId: string; text: string }
  onFocusEmployee(employeeId: string): void
  onStaticModeChange(value: boolean): void
  onVoiceFinal(text: string): Promise<void>
}

export function EmployeeFocusMode({ world, employee, entity, collaborators, connected, staticMode, rendererMode, latestUtterance, onFocusEmployee, onStaticModeChange, onVoiceFinal }: EmployeeFocusModeProps) {
  const [rendererReady, setRendererReady] = useState(false)
  const [rendererArmed, setRendererArmed] = useState(false)
  const [rendererNotice, setRendererNotice] = useState<string>()
  const [quality, setQuality] = useState<RenderingQuality>('static')
  const [speaking, setSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | undefined>(undefined)
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(() => readVoiceMode(world.id, employee.id))
  const [voiceId, setVoiceId] = useState(() => readVoiceId(world.id, employee.id))
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceNotice, setVoiceNotice] = useState<string>()
  const [voiceBusy, setVoiceBusy] = useState(false)
  const streamChunkerRef = useRef(new StreamingSentenceChunker())
  const streamTurnRef = useRef<string | undefined>(undefined)
  const streamChainRef = useRef<Promise<void>>(Promise.resolve())
  const streamPendingRef = useRef(0)
  const streamCompleteRef = useRef(false)
  const streamedSpeechRef = useRef(false)
  const streamGenerationRef = useRef(0)
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
  const systemVoiceId = voiceId.startsWith('system:') ? voiceId.slice('system:'.length) : ''
  const selectedSystemVoice = resolveSpeechVoice(chineseSystemVoices, systemVoiceId)
  const selectedKokoroVoice = KOKORO_CHINESE_VOICES.find((voice) => voice.id === voiceId)
  const selectedVoiceMissing = selectedKokoroVoice === undefined && selectedSystemVoice === undefined

  useEffect(() => { setRendererReady(false); setRendererNotice(undefined) }, [employee.id, employee.avatarProfile?.assetId, quality, rendererMode])
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
    } catch { /* localStorage is optional */ }
  }, [employee.id, voiceId, voiceMode, world.id])

  const stopSpeech = useCallback(() => {
    stopKokoroSpeech()
    if (speechSupported) window.speechSynthesis.cancel()
    utteranceRef.current = undefined
    setSpeaking(false)
    setVoiceBusy(false)
  }, [speechSupported])

  const speak = useCallback(async (text: string) => {
    if (text.trim().length === 0) return
    stopSpeech()
    if (voiceId.startsWith('kokoro:')) {
      setVoiceBusy(true)
      try {
        await playKokoroSpeech({
          text,
          voiceId,
          onStatus: setVoiceNotice,
          onStart: () => { setVoiceBusy(false); setSpeaking(true) },
          onEnd: () => { setVoiceBusy(false); setSpeaking(false) },
        })
      } catch (cause) {
        setVoiceBusy(false)
        setSpeaking(false)
        console.error('Local Kokoro speech failed', cause)
        setVoiceNotice(cause instanceof Error && !/fetch|network/iu.test(cause.message)
          ? `本地中文语音失败：${cause.message}`
          : '无法连接本地语音服务，请确认服务已启动。')
      }
      return
    }
    if (!speechSupported) { setVoiceNotice('当前浏览器不支持系统语音，请选择本地 AI 中文声音。'); return }
    const exactVoice = resolveSpeechVoice(chineseSystemVoices, systemVoiceId)
    if (exactVoice === undefined) { setVoiceNotice('所选系统中文声音当前不可用，请刷新或改用本地 AI 中文声音。'); return }
    const value = new SpeechSynthesisUtterance(text)
    value.lang = exactVoice.lang
    value.rate = 0.96
    value.pitch = 1
    value.voice = exactVoice
    setVoiceNotice(undefined)
    value.onstart = () => setSpeaking(true)
    value.onend = () => { utteranceRef.current = undefined; setSpeaking(false) }
    value.onerror = () => { utteranceRef.current = undefined; setSpeaking(false); setVoiceNotice('系统语音播放失败，请刷新声音目录或更换声音。') }
    utteranceRef.current = value
    setSpeaking(true)
    window.speechSynthesis.speak(value)
  }, [chineseSystemVoices, speechSupported, stopSpeech, systemVoiceId, voiceId])

  const changeVoiceMode = useCallback((mode: VoiceMode) => {
    if (mode === 'off') stopSpeech()
    if (mode === 'auto' && utterance !== undefined) {
      lastAutoSpokenRef.current = utterance.messageId
      persistLastSpoken(world.id, employee.id, utterance.messageId)
    }
    setVoiceMode(mode)
  }, [employee.id, stopSpeech, utterance, world.id])

  const enqueueStreamChunk = useCallback((content: string) => {
    const text = speechTextFromMessage(content)
    if (!text || !voiceId.startsWith('kokoro:')) return
    streamedSpeechRef.current = true
    streamPendingRef.current += 1
    const queueGeneration = streamGenerationRef.current
    setVoiceBusy(true)
    const run = streamChainRef.current.catch(() => undefined).then(() => {
      if (queueGeneration !== streamGenerationRef.current) return
      return appendKokoroSpeech({
      text,
      voiceId,
      onStatus: setVoiceNotice,
      onStart: () => { setVoiceBusy(false); setSpeaking(true) },
      onEnd: () => {
        streamPendingRef.current = Math.max(0, streamPendingRef.current - 1)
        if (streamCompleteRef.current && streamPendingRef.current === 0) setSpeaking(false)
      },
      })
    }).catch((cause: unknown) => {
      streamPendingRef.current = Math.max(0, streamPendingRef.current - 1)
      setVoiceBusy(false)
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setVoiceNotice(cause instanceof Error ? `本地流式语音失败：${cause.message}` : '本地流式语音失败')
    })
    streamChainRef.current = run
  }, [voiceId])

  useEffect(() => {
    if (voiceMode !== 'auto' || !voiceId.startsWith('kokoro:')) return
    return subscribeStreamingSpeech((event) => {
      if (event.employeeId !== employee.id) return
      if (event.kind === 'start') {
        streamGenerationRef.current += 1; stopSpeech(); streamChunkerRef.current.reset(); streamTurnRef.current = event.turnId
        streamChainRef.current = Promise.resolve(); streamPendingRef.current = 0; streamCompleteRef.current = false; streamedSpeechRef.current = false
        return
      }
      if (streamTurnRef.current !== event.turnId) return
      if (event.kind === 'delta' && event.content !== undefined) {
        for (const chunk of streamChunkerRef.current.push(event.content)) enqueueStreamChunk(chunk)
      } else if (event.kind === 'complete') {
        for (const chunk of streamChunkerRef.current.flush()) enqueueStreamChunk(chunk)
        streamCompleteRef.current = true
        if (streamPendingRef.current === 0) setSpeaking(false)
      } else if (event.kind === 'cancel') {
        streamGenerationRef.current += 1; streamChunkerRef.current.reset(); streamCompleteRef.current = true; stopSpeech()
      }
    })
  }, [employee.id, enqueueStreamChunk, stopSpeech, voiceId, voiceMode])

  useEffect(() => {
    if (voiceMode !== 'auto' || utterance === undefined || utterance.messageId === lastAutoSpokenRef.current) return
    lastAutoSpokenRef.current = utterance.messageId
    persistLastSpoken(world.id, employee.id, utterance.messageId)
    if (streamedSpeechRef.current) return
    void speak(spokenText)
  }, [employee.id, speak, spokenText, utterance, voiceMode, world.id])
  useEffect(() => () => stopSpeech(), [stopSpeech])

  const fallback = useCallback((reason: string) => {
    setRendererReady(false)
    setRendererNotice(reason.includes('FPS') ? reason : `3D 形象暂时不可用，已切回 2D：${reason}`)
    setQuality((current) => reason.includes('FPS') ? nextLowerQuality(current) : 'static')
  }, [])

  const visibleCollaborators = collaborators.slice(0, 2)
  const remainingCollaborators = Math.max(0, collaborators.length - visibleCollaborators.length)
  const requestedVrmFallback = rendererMode !== '3d' || usesVrm
    ? undefined
    : employee.avatarProfile?.rendererKind !== 'vrm-3d'
      ? '当前角色未发布可用 VRM，正在显示 2D 备用形象。'
      : '当前设备或动态效果设置不适合 3D，正在显示 2D 备用形象。'

  return <section className="employee-focus" aria-label={`${employee.displayName}员工聚焦`} data-state={state} data-renderer={selectedRenderer.kind} data-view-mode={rendererMode} data-quality={quality}>
    <div className="employee-focus__scrim" aria-hidden="true" />
    <header className="employee-focus__header">
      <div className="employee-focus__identity"><strong>{employee.displayName}</strong><span>{employee.role}</span></div>
      <div className="employee-focus__header-actions">
        <span className={`employee-focus__status is-${state}`}><i aria-hidden="true" />{stateLabel(state)}</span>
        <details className="employee-focus__voice"><summary role="button" aria-label="语音设置">{speaking ? <SpeakerSlash size={17} aria-hidden="true" /> : <SpeakerHigh size={17} aria-hidden="true" />}语音</summary><div>
          <header><span><strong>{employee.displayName}的语音</strong><small>{KOKORO_CHINESE_VOICES.length} 个本地 AI 中文声音{chineseSystemVoices.length > 0 ? ` · ${chineseSystemVoices.length} 个系统中文声音` : ''}</small></span><button type="button" aria-label="刷新系统声音" onClick={refreshVoices}><ArrowsClockwise size={16} aria-hidden="true" /></button></header>
          <label><span>播报模式</span><select aria-label="播报模式" value={voiceMode} onChange={(event) => changeVoiceMode(event.target.value as VoiceMode)}><option value="off">关闭</option><option value="manual">手动</option><option value="auto">自动播报新回复</option></select></label>
          <label><span>角色声音</span><select aria-label="角色声音" value={voiceId} onChange={(event) => { setVoiceId(event.target.value); setVoiceNotice(undefined) }}>{selectedVoiceMissing ? <option value={voiceId}>原声音当前不可用</option> : null}<optgroup label="本地 AI 中文女声">{KOKORO_CHINESE_VOICES.filter((voice) => voice.gender === '女声').map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</optgroup><optgroup label="本地 AI 中文男声">{KOKORO_CHINESE_VOICES.filter((voice) => voice.gender === '男声').map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</optgroup>{chineseSystemVoices.length === 0 ? null : <optgroup label="Windows / 浏览器中文声音">{chineseSystemVoices.map((voice) => <option key={`${voice.voiceURI}:${voice.lang}`} value={`system:${voice.voiceURI}`}>{voice.name} · {voice.lang}{voice.localService ? ' · 本机' : ''}</option>)}</optgroup>}</select></label>
          <div className="employee-focus__voice-preview"><span><strong>当前播报</strong><small>{spokenText.length === 0 ? `当前会话里还没有 ${employee.displayName} 的最终回复` : `${employee.displayName}：${spokenText.slice(0, 72)}${spokenText.length > 72 ? '…' : ''}`}</small></span></div>
          <label className="employee-focus__motion"><input type="checkbox" checked={!staticMode} onChange={(event) => onStaticModeChange(!event.target.checked)} />启用角色动效</label>
          <div className="employee-focus__voice-buttons"><button type="button" disabled={voiceBusy} onClick={() => void speak(`你好，我是${employee.displayName}。这是当前声音的试听。`)}>{voiceBusy ? '正在准备…' : '试听声音'}</button><button type="button" disabled={voiceBusy || spokenText.length === 0 || voiceMode === 'off'} onClick={speaking ? stopSpeech : () => void speak(spokenText)}>{voiceBusy ? '正在生成…' : speaking ? '停止播报' : `播放${employee.displayName}的回复`}</button></div>
          {voiceNotice === undefined ? null : <small className="employee-focus__voice-notice" role="status">{voiceNotice}</small>}
        </div></details>
      </div>
    </header>
    <div className="employee-focus__activity" aria-live="polite"><strong>{stateLabel(state)}</strong><span>{connected ? entity?.activityLabel ?? '等待事件触发' : '实时连接中断，正在重连'}</span></div>

    <div className="employee-focus__avatar-stage">
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
    </div>
    <VoiceConversationControl employeeName={employee.displayName} onFinal={onVoiceFinal} onBargeIn={() => {
      streamGenerationRef.current += 1; streamPendingRef.current = 0; streamCompleteRef.current = true; streamChunkerRef.current.reset(); stopSpeech()
    }} />
    {(rendererNotice ?? requestedVrmFallback) === undefined ? null : <div className="employee-focus__notice" role="status">{rendererNotice ?? requestedVrmFallback}</div>}
  </section>
}

function stateLabel(state: ReturnType<typeof visualStateForEntity>): string {
  return ({ idle: '待命', thinking: '思考中', executing: '执行中', speaking: '说话中', approval: '等待审批', failed: '失败' })[state]
}

function voiceModeKey(worldId: string, employeeId: string): string { return `dsh-cyber-digital-voice-mode:${worldId}:${employeeId}` }
function voiceIdKey(worldId: string, employeeId: string): string { return `dsh-cyber-digital-voice-id:${worldId}:${employeeId}` }
function lastSpokenKey(worldId: string, employeeId: string): string { return `dsh-cyber-digital-last-spoken:${worldId}:${employeeId}` }
function readVoiceMode(worldId: string, employeeId: string): VoiceMode { try { const value = localStorage.getItem(voiceModeKey(worldId, employeeId)) ?? localStorage.getItem(`dsh-cyber-digital-voice-mode:${worldId}`); return value === 'off' || value === 'auto' ? value : 'manual' } catch { return 'manual' } }
function readVoiceId(worldId: string, employeeId: string): string { try { const saved = localStorage.getItem(voiceIdKey(worldId, employeeId)); return saved?.startsWith('system:') || KOKORO_CHINESE_VOICES.some((voice) => voice.id === saved) ? saved! : defaultVoiceId(employeeId) } catch { return defaultVoiceId(employeeId) } }
function defaultVoiceId(employeeId: string): string { let hash = 0; for (const character of employeeId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return KOKORO_CHINESE_VOICES[hash % KOKORO_CHINESE_VOICES.length]!.id }
function readLastSpoken(worldId: string, employeeId: string): string | undefined { try { return localStorage.getItem(lastSpokenKey(worldId, employeeId)) ?? undefined } catch { return undefined } }
function persistLastSpoken(worldId: string, employeeId: string, messageId: string): void { try { localStorage.setItem(lastSpokenKey(worldId, employeeId), messageId) } catch { /* localStorage is optional */ } }
