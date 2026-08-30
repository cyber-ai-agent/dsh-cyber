import { ArrowLeft, DotsThree, GitBranch, IdentificationBadge, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { World, WorldRuntimeEntityState } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../../../types.js'
import { motionCueForState, speechTextFromMessage, visualStateForEntity } from '../../digital-human-motion.js'
import { RegisteredDigitalHumanRenderer, selectRenderer } from '../renderer/RendererRegistry.js'
import { detectRenderingQuality, nextLowerQuality, type RenderingQuality } from '../renderer/RenderingQuality.js'
import { SpriteRuntimeRenderer } from '../sprite/SpriteRuntimeRenderer.js'
import './employee-focus-mode.css'

interface EmployeeFocusModeProps {
  world: World
  employee: CyberEmployee
  entity?: WorldRuntimeEntityState
  connected: boolean
  staticMode: boolean
  latestUtterance?: { messageId: string; employeeId: string; text: string }
  onStaticModeChange(value: boolean): void
  onBack(): void
  onOpenDossier(): void
  onOpenTrace(): void
  onOpenConversation(): void
}

export function EmployeeFocusMode({ world, employee, entity, connected, staticMode, latestUtterance, onStaticModeChange, onBack, onOpenDossier, onOpenTrace, onOpenConversation }: EmployeeFocusModeProps) {
  const [rendererReady, setRendererReady] = useState(false)
  const [rendererArmed, setRendererArmed] = useState(false)
  const [rendererNotice, setRendererNotice] = useState<string>()
  const [quality, setQuality] = useState<RenderingQuality>('static')
  const [speaking, setSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | undefined>(undefined)
  const [voiceMode, setVoiceMode] = useState<'off' | 'manual' | 'auto'>(() => readVoiceMode(world.id))
  const [voiceId, setVoiceId] = useState(() => readVoiceId(world.id))
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const lastAutoSpokenRef = useRef(readLastSpoken(world.id))
  const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  const utterance = latestUtterance?.employeeId === employee.id ? latestUtterance : undefined
  const spokenText = utterance === undefined ? '' : speechTextFromMessage(utterance.text)
  const state = visualStateForEntity(entity, connected, speaking)
  const motionCue = motionCueForState(state)
  const selectedRenderer = selectRenderer(employee, quality)
  const usesVrm = selectedRenderer.kind === 'vrm-3d'

  useEffect(() => { setRendererReady(false); setRendererNotice(undefined) }, [employee.id, employee.avatarProfile?.assetId, quality])
  useEffect(() => {
    setRendererArmed(!usesVrm)
    if (!usesVrm) return
    // Give the Overview renderer one frame to dispose its Pixi/WebGL context
    // before Three requests a new one. This avoids transient dual-context GPU
    // pressure and software-renderer stalls while preserving the visual bridge.
    const timer = window.setTimeout(() => setRendererArmed(true), 420)
    return () => window.clearTimeout(timer)
  }, [employee.id, employee.avatarProfile?.assetId, quality, usesVrm])
  useEffect(() => {
    setQuality('static')
    if (staticMode) return
    // Context probing during render can overlap the outgoing Pixi context and
    // freeze software GPU drivers. Probe only after Overview cleanup settles.
    const timer = window.setTimeout(() => setQuality(detectRenderingQuality(false)), 320)
    return () => window.clearTimeout(timer)
  }, [staticMode])
  useEffect(() => {
    if (!speechSupported) return
    const update = () => setVoices([...window.speechSynthesis.getVoices()].sort((left, right) => Number(!/^zh/iu.test(left.lang)) - Number(!/^zh/iu.test(right.lang)) || left.name.localeCompare(right.name)))
    update(); window.speechSynthesis.addEventListener('voiceschanged', update)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update)
  }, [speechSupported])
  useEffect(() => {
    try { localStorage.setItem(`dsh-cyber-digital-voice-mode:${world.id}`, voiceMode); localStorage.setItem(`dsh-cyber-digital-voice-id:${world.id}`, voiceId) } catch { /* optional */ }
  }, [voiceId, voiceMode, world.id])

  const stopSpeech = useCallback(() => {
    if (speechSupported) window.speechSynthesis.cancel()
    utteranceRef.current = undefined
    setSpeaking(false)
  }, [speechSupported])
  const startSpeech = useCallback(() => {
    if (!speechSupported || spokenText.length === 0 || voiceMode === 'off') return
    stopSpeech()
    const value = new SpeechSynthesisUtterance(spokenText)
    value.lang = 'zh-CN'; value.rate = 0.96; value.pitch = 1
    const voice = voices.find((item) => item.voiceURI === voiceId) ?? voices.find((item) => /^zh/iu.test(item.lang))
    if (voice !== undefined) value.voice = voice
    value.onstart = () => setSpeaking(true)
    value.onend = () => { utteranceRef.current = undefined; setSpeaking(false) }
    value.onerror = () => { utteranceRef.current = undefined; setSpeaking(false) }
    utteranceRef.current = value
    setSpeaking(true)
    window.speechSynthesis.speak(value)
  }, [speechSupported, spokenText, stopSpeech, voiceId, voiceMode, voices])
  useEffect(() => {
    if (voiceMode !== 'auto' || utterance === undefined || utterance.messageId === lastAutoSpokenRef.current) return
    lastAutoSpokenRef.current = utterance.messageId
    try { localStorage.setItem(`dsh-cyber-digital-last-spoken:${world.id}`, utterance.messageId) } catch { /* optional */ }
    startSpeech()
  }, [startSpeech, utterance, voiceMode, world.id])
  useEffect(() => () => stopSpeech(), [stopSpeech])

  const fallback = useCallback((reason: string) => {
    setRendererReady(false)
    setRendererNotice(reason.includes('FPS') ? reason : `3D 形象暂时不可用，已切回 2D：${reason}`)
    setQuality((current) => reason.includes('FPS') ? nextLowerQuality(current) : 'static')
  }, [])

  return <section className="employee-focus" aria-label={`${employee.displayName}员工聚焦`} data-state={state} data-renderer={selectedRenderer.kind} data-quality={quality}>
    <div className="employee-focus__scrim" aria-hidden="true" />
    <header className="employee-focus__header">
      <button type="button" onClick={() => { stopSpeech(); onBack() }}><ArrowLeft size={17} aria-hidden="true" />世界</button>
      <div><strong>{employee.displayName}</strong><span>{employee.role}</span></div>
      <span className={`employee-focus__status is-${state}`}><i aria-hidden="true" />{stateLabel(state)}</span>
    </header>
    <div className="employee-focus__activity" aria-live="polite"><strong>{stateLabel(state)}</strong><span>{connected ? entity?.activityLabel ?? '等待事件触发' : '实时连接中断，正在重连'}</span></div>

    <div className="employee-focus__avatar-stage">
      {usesVrm ? <div className={`employee-focus__sprite-bridge${rendererReady ? ' is-hidden' : ''}`}><SpriteRuntimeRenderer employee={employee} entity={entity} state={state} motionCue={motionCue} speaking={speaking} staticMode={staticMode} quality="static" onReady={() => undefined} onFallback={() => undefined} /></div> : null}
      {rendererArmed ? <RegisteredDigitalHumanRenderer key={`${selectedRenderer.id}:${quality}:${employee.avatarProfile?.assetId ?? employee.avatarIndex}`} employee={employee} entity={entity} state={state} motionCue={motionCue} speaking={speaking} staticMode={staticMode} quality={quality} onReady={() => setRendererReady(true)} onFallback={fallback} /> : <div className="focus-avatar__loading" role="status">正在切换 3D 渲染器…</div>}
    </div>
    {rendererNotice === undefined ? null : <div className="employee-focus__notice" role="status">{rendererNotice}</div>}

    <footer className="employee-focus__actions">
      <button type="button" onClick={onOpenDossier}><IdentificationBadge size={17} aria-hidden="true" />档案</button>
      <button type="button" onClick={onOpenTrace}><GitBranch size={17} aria-hidden="true" />轨迹</button>
      <details className="employee-focus__voice"><summary role="button" aria-label="语音设置">{speaking ? <SpeakerSlash size={17} aria-hidden="true" /> : <SpeakerHigh size={17} aria-hidden="true" />}语音</summary><div>
        <label><span>播报模式</span><select value={voiceMode} onChange={(event) => setVoiceMode(event.target.value as typeof voiceMode)}><option value="off">关闭</option><option value="manual">手动</option><option value="auto">自动播报新回复</option></select></label>
        <label><span>声音</span><select value={voiceId} onChange={(event) => setVoiceId(event.target.value)} disabled={!speechSupported}><option value="">系统默认</option>{voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select></label>
        <label className="employee-focus__motion"><input type="checkbox" checked={!staticMode} onChange={(event) => onStaticModeChange(!event.target.checked)} />启用角色动效</label>
        <button type="button" disabled={spokenText.length === 0 || voiceMode === 'off'} onClick={speaking ? stopSpeech : startSpeech}>{speaking ? '停止播报' : '播放当前回复'}</button>
      </div></details>
      <button type="button" onClick={onOpenConversation}><DotsThree size={17} aria-hidden="true" />对话</button>
    </footer>
  </section>
}

function stateLabel(state: ReturnType<typeof visualStateForEntity>): string {
  return ({ idle: '待命', thinking: '思考中', executing: '执行中', speaking: '说话中', approval: '等待审批', failed: '失败' })[state]
}
function readVoiceMode(worldId: string): 'off' | 'manual' | 'auto' { try { const value = localStorage.getItem(`dsh-cyber-digital-voice-mode:${worldId}`); return value === 'off' || value === 'auto' ? value : 'manual' } catch { return 'manual' } }
function readVoiceId(worldId: string): string { try { return localStorage.getItem(`dsh-cyber-digital-voice-id:${worldId}`) ?? '' } catch { return '' } }
function readLastSpoken(worldId: string): string | undefined { try { return localStorage.getItem(`dsh-cyber-digital-last-spoken:${worldId}`) ?? undefined } catch { return undefined } }
