import {
  Brain,
  CaretLeft,
  CaretRight,
  Circle,
  GitBranch,
  Hourglass,
  Play,
  SpeakerHigh,
  SpeakerSlash,
  UserFocus,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import type { World, WorldRuntimeEntityState, WorldRuntimeSnapshot } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import './digital-human.css'
import { motionCueForState, speechTextFromMessage, type DigitalHumanVisualState } from './digital-human-motion.js'

interface DigitalHumanUtterance {
  messageId: string
  employeeId: string
  text: string
}

type DigitalHumanVoiceMode = 'off' | 'manual' | 'auto'

interface DigitalHumanModeProps {
  world: World
  employees: CyberEmployee[]
  snapshot: WorldRuntimeSnapshot
  connected: boolean
  staticMode: boolean
  activeEmployeeId?: string
  conversationEmployeeIds: string[]
  latestUtterance?: DigitalHumanUtterance
  onSelectEmployee(employeeId: string): void
  onOpenDossier(employeeId: string): void
  onOpenTrace(): void
  onStaticModeChange(value: boolean): void
}

const STATUS_ITEMS = [
  { id: 'idle', label: '待命', description: '已就绪，等待事件触发', Icon: Circle },
  { id: 'thinking', label: '思考中', description: '理解意图，规划下一步', Icon: Brain },
  { id: 'executing', label: '执行中', description: '调用工具，推进当前步骤', Icon: Play },
  { id: 'speaking', label: '说话中', description: '本机播报当前角色回复', Icon: SpeakerHigh },
  { id: 'approval', label: '等待审批', description: '动作暂停，等待人工确认', Icon: Hourglass },
  { id: 'failed', label: '失败', description: '执行停止，需要人工处理', Icon: XCircle },
] as const

export function DigitalHumanMode({
  world,
  employees,
  snapshot,
  connected,
  staticMode,
  activeEmployeeId,
  conversationEmployeeIds,
  latestUtterance,
  onSelectEmployee,
  onOpenDossier,
  onOpenTrace,
  onStaticModeChange,
}: DigitalHumanModeProps) {
  const [speaking, setSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | undefined>(undefined)
  const [voiceMode, setVoiceMode] = useState<DigitalHumanVoiceMode>(() => readVoiceMode(world.id))
  const [voiceId, setVoiceId] = useState(() => readVoiceId(world.id))
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [statusCollapsed, setStatusCollapsed] = useState(() => readStatusCollapsed(world.id))
  const lastAutoSpokenRef = useRef(readLastAutoSpokenMessage(world.id))
  const entities = useMemo(() => snapshot.entities.filter((entity) => entity.kind === 'agent'), [snapshot.entities])
  const selectedEntity = selectActiveEntity(entities, activeEmployeeId, latestUtterance?.employeeId, conversationEmployeeIds)
  const activeEntity = speaking && latestUtterance !== undefined
    ? entities.find((entity) => entity.id === latestUtterance.employeeId) ?? selectedEntity
    : selectedEntity
  const activeEmployee = employees.find((employee) => employee.id === activeEntity?.id) ?? employees[0]
  const activeState = speaking ? 'speaking' : digitalHumanState(activeEntity, connected)
  const motionCue = motionCueForState(activeState)
  const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  const spokenText = latestUtterance === undefined ? '' : speechTextFromMessage(latestUtterance.text)
  const canSpeak = speechSupported && spokenText.length > 0
  const voiceHint = !speechSupported ? '当前浏览器不支持本机语音' : canSpeak ? '本机语音，不上传内容' : '等待角色最终回复'
  const voiceModeLabel = voiceMode === 'auto' ? '自动播报' : voiceMode === 'manual' ? '手动播报' : '语音已关闭'
  const collaborators = conversationEmployeeIds
    .filter((employeeId) => employeeId !== activeEmployee?.id)
    .map((employeeId) => employees.find((employee) => employee.id === employeeId))
    .filter((employee): employee is CyberEmployee => employee !== undefined)
    .slice(0, 2)
  const startSpeech = useCallback(() => {
    if (!canSpeak || latestUtterance === undefined) return
    try {
      const utterance = new SpeechSynthesisUtterance(spokenText)
      utterance.lang = 'zh-CN'
      utterance.rate = 0.96
      utterance.pitch = 1
      const selectedVoice = voices.find((voice) => voice.voiceURI === voiceId)
        ?? voices.find((voice) => /^zh(?:-|_)/iu.test(voice.lang))
      if (selectedVoice !== undefined) utterance.voice = selectedVoice
      utterance.onstart = () => setSpeaking(true)
      utterance.onend = () => { utteranceRef.current = undefined; setSpeaking(false) }
      utterance.onerror = () => { utteranceRef.current = undefined; setSpeaking(false) }
      utteranceRef.current = utterance
      setSpeaking(true)
      window.speechSynthesis.speak(utterance)
    } catch {
      utteranceRef.current = undefined
      setSpeaking(false)
    }
  }, [canSpeak, latestUtterance, spokenText, voiceId, voices])

  const toggleSpeech = useCallback(() => {
    if (speaking) {
      window.speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    startSpeech()
  }, [speaking, startSpeech])

  const changeVoiceMode = useCallback((mode: DigitalHumanVoiceMode) => {
    if (mode === 'off' && speaking && speechSupported) window.speechSynthesis.cancel()
    if (mode === 'auto' && latestUtterance !== undefined) {
      lastAutoSpokenRef.current = latestUtterance.messageId
      persistLastAutoSpokenMessage(world.id, latestUtterance.messageId)
    }
    setVoiceMode(mode)
  }, [latestUtterance, speaking, speechSupported, world.id])

  useEffect(() => {
    if (!speechSupported) return
    const updateVoices = () => setVoices([...window.speechSynthesis.getVoices()].sort(compareVoices))
    updateVoices()
    window.speechSynthesis.addEventListener('voiceschanged', updateVoices)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', updateVoices)
  }, [speechSupported])

  useEffect(() => {
    persistVoicePreferences(world.id, voiceMode, voiceId)
  }, [voiceId, voiceMode, world.id])

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`dsh-cyber-digital-status-collapsed:${world.id}`, statusCollapsed ? 'true' : 'false')
  }, [statusCollapsed, world.id])

  useEffect(() => {
    if (voiceMode !== 'auto' || !canSpeak || latestUtterance === undefined || speaking) return
    if (lastAutoSpokenRef.current === latestUtterance.messageId) return
    lastAutoSpokenRef.current = latestUtterance.messageId
    persistLastAutoSpokenMessage(world.id, latestUtterance.messageId)
    startSpeech()
  }, [canSpeak, latestUtterance, speaking, startSpeech, voiceMode, world.id])

  useEffect(() => () => {
    if (utteranceRef.current !== undefined && typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  return <section className={`digital-human${staticMode ? ' digital-human--static' : ''}${connected ? '' : ' digital-human--offline'}`} data-state={activeState} data-expression={motionCue.expression} data-gesture={motionCue.gesture} data-speaking={speaking ? 'true' : 'false'} aria-label={`${world.name}数字人行动舱`}>
    <div className="digital-human__bay" aria-hidden="true" />

    <div className="digital-human__stage">
      {collaborators.map((employee, index) => <button key={employee.id} type="button" className={`digital-human__collaborator digital-human__collaborator--${index + 1}`} onClick={() => onSelectEmployee(employee.id)} aria-label={`聚焦${employee.displayName}对话`}>
        <i style={digitalHumanAtlasStyle(employee.avatarIndex)} aria-hidden="true" />
        <span><strong>{employee.displayName}</strong><small>{employee.role}</small><em>已加入会话</em></span>
      </button>)}
      {activeEmployee === undefined ? <div className="digital-human__empty"><UserFocus size={28} aria-hidden="true" /><strong>等待角色进入行动舱</strong></div> : <>
        <button type="button" className="digital-human__figure" style={digitalHumanAtlasStyle(activeEmployee.avatarIndex)} onClick={() => onOpenDossier(activeEmployee.id)} aria-label={`打开${activeEmployee.displayName}档案`}>
          <span className="digital-human__scan" aria-hidden="true" />
        </button>
        <div className="digital-human__identity" aria-live="polite">
          <strong>{activeEmployee.displayName} · {activeEmployee.role}</strong>
          <span>{connected ? activeEntity?.activityLabel ?? '等待事件触发' : '实时连接中断，正在重连'}</span>
        </div>
      </>}
    </div>

    <aside className={`digital-human__states${statusCollapsed ? ' is-collapsed' : ''}`} aria-label="数字人状态">
      <header><button type="button" aria-expanded={!statusCollapsed} aria-label={statusCollapsed ? '展开数字人状态' : '收起数字人状态'} onClick={() => setStatusCollapsed((current) => !current)}>{statusCollapsed ? <CaretLeft size={18} aria-hidden="true" /> : <><strong>状态</strong><CaretRight size={16} aria-hidden="true" /></>}</button></header>
      {statusCollapsed ? null : <ol>{STATUS_ITEMS.map(({ id, label, description, Icon }) => <li key={id} className={id === activeState ? 'is-active' : ''}>
        <Icon size={18} weight={id === activeState ? 'fill' : 'regular'} aria-hidden="true" />
        <span><strong>{label}</strong><small>{description}</small></span>
      </li>)}</ol>}
    </aside>

    <footer className="digital-human__actions">
      <button type="button" disabled={activeEmployee === undefined} onClick={() => activeEmployee && onOpenDossier(activeEmployee.id)}><UserFocus size={17} aria-hidden="true" /><span><strong>数字人档案</strong><small>查看身份与职责</small></span></button>
      <details className="digital-human__voice-menu">
        <summary role="button" aria-label="语音回复设置"><SpeakerHigh size={17} aria-hidden="true" /><span><strong>语音回复</strong><small>{voiceModeLabel}</small></span></summary>
        <div className="digital-human__voice-panel">
          <strong>语音回复</strong>
          <label><span>播报模式</span><select aria-label="语音播报模式" value={voiceMode} onChange={(event) => changeVoiceMode(event.target.value as DigitalHumanVoiceMode)}><option value="off">关闭语音</option><option value="manual">手动播报</option><option value="auto">自动播报新回复</option></select></label>
          <label><span>声音</span><select aria-label="数字人语音选择" value={voiceId} onChange={(event) => setVoiceId(event.target.value)} disabled={!speechSupported}><option value="">系统默认中文声音</option>{voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}{voice.localService ? ' · 本机' : ''}</option>)}</select></label>
          <label className="digital-human__motion-toggle"><input type="checkbox" checked={!staticMode} onChange={(event) => onStaticModeChange(!event.target.checked)} /><span>启用角色动效</span></label>
          <button type="button" disabled={voiceMode === 'off' || !canSpeak} aria-pressed={speaking} onClick={toggleSpeech}>{speaking ? <SpeakerSlash size={16} aria-hidden="true" /> : <SpeakerHigh size={16} aria-hidden="true" />}{speaking ? '停止播报' : '播放当前回复'}</button>
          <small>{voiceHint}。自动模式只播报之后产生的新回复。</small>
        </div>
      </details>
      <button type="button" onClick={onOpenTrace}><GitBranch size={17} aria-hidden="true" /><span><strong>序列追溯</strong><small>查看耐久事实</small></span></button>
      <button type="button" disabled={collaborators[0] === undefined} onClick={() => collaborators[0] && onSelectEmployee(collaborators[0].id)}><UserFocus size={17} aria-hidden="true" /><span><strong>聚焦协作者</strong><small>{collaborators[0]?.displayName ?? '当前没有协作者'}</small></span></button>
    </footer>
    {connected ? null : <div className="digital-human__connection" role="status"><WarningCircle size={16} aria-hidden="true" />实时世界正在重连，画面已冻结</div>}
  </section>
}

function compareVoices(left: SpeechSynthesisVoice, right: SpeechSynthesisVoice): number {
  const leftChinese = /^zh(?:-|_)/iu.test(left.lang) ? 0 : 1
  const rightChinese = /^zh(?:-|_)/iu.test(right.lang) ? 0 : 1
  return leftChinese - rightChinese || left.lang.localeCompare(right.lang) || left.name.localeCompare(right.name)
}

function readVoiceMode(worldId: string): DigitalHumanVoiceMode {
  if (typeof localStorage === 'undefined') return 'manual'
  const value = localStorage.getItem(`dsh-cyber-digital-voice-mode:${worldId}`)
  return value === 'off' || value === 'auto' || value === 'manual' ? value : 'manual'
}

function readVoiceId(worldId: string): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(`dsh-cyber-digital-voice-id:${worldId}`) ?? ''
}

function readLastAutoSpokenMessage(worldId: string): string | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return localStorage.getItem(`dsh-cyber-digital-last-spoken:${worldId}`) ?? undefined
}

function readStatusCollapsed(worldId: string): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(`dsh-cyber-digital-status-collapsed:${worldId}`) === 'true'
}

function persistVoicePreferences(worldId: string, mode: DigitalHumanVoiceMode, voiceId: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(`dsh-cyber-digital-voice-mode:${worldId}`, mode)
  localStorage.setItem(`dsh-cyber-digital-voice-id:${worldId}`, voiceId)
}

function persistLastAutoSpokenMessage(worldId: string, messageId: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(`dsh-cyber-digital-last-spoken:${worldId}`, messageId)
}

function selectActiveEntity(entities: WorldRuntimeEntityState[], activeEmployeeId: string | undefined, latestSpeakerId: string | undefined, conversationEmployeeIds: string[]): WorldRuntimeEntityState | undefined {
  return entities.find((entity) => entity.id === activeEmployeeId)
    ?? entities.find((entity) => entity.activity !== 'idle')
    ?? entities.find((entity) => entity.id === latestSpeakerId)
    ?? conversationEmployeeIds.map((employeeId) => entities.find((entity) => entity.id === employeeId)).find((entity) => entity !== undefined)
    ?? entities[0]
}

function digitalHumanState(entity: WorldRuntimeEntityState | undefined, connected: boolean): DigitalHumanVisualState {
  if (!connected || entity?.activity === 'blocked' || entity?.status === 'blocked') return 'failed'
  if (/审批|approval|等待确认/iu.test(entity?.activityLabel ?? '')) return 'approval'
  if (entity?.activity === 'thinking' || entity?.activity === 'talking') return 'thinking'
  if (entity?.activity === 'working' || entity?.activity === 'walking' || entity?.activity === 'meeting') return 'executing'
  return 'idle'
}

function digitalHumanAtlasStyle(index: number): CSSProperties {
  const normalized = Math.max(0, Math.min(7, Math.floor(index)))
  const firstFrameByAvatar = [2, 0, 4, 6, 10, 8, 12, 14]
  const closedFrame = firstFrameByAvatar[normalized] ?? 0
  const openFrame = closedFrame + 1
  const closedColumn = closedFrame % 4
  const closedRow = Math.floor(closedFrame / 4)
  const openColumn = openFrame % 4
  const openRow = Math.floor(openFrame / 4)
  return {
    '--digital-human-closed-x': `${closedColumn * 33.3333}%`,
    '--digital-human-closed-y': `${closedRow * 33.3333}%`,
    '--digital-human-open-x': `${openColumn * 33.3333}%`,
    '--digital-human-open-y': `${openRow * 33.3333}%`,
  } as CSSProperties
}
