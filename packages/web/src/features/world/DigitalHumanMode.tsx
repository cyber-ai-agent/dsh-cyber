import {
  Brain,
  CheckCircle,
  Circle,
  GitBranch,
  Hourglass,
  Package,
  Play,
  SpeakerHigh,
  SpeakerSlash,
  UserFocus,
  WarningCircle,
  Wrench,
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

interface DigitalHumanModeProps {
  world: World
  employees: CyberEmployee[]
  snapshot: WorldRuntimeSnapshot
  connected: boolean
  staticMode: boolean
  activeEmployeeId?: string
  conversationEmployeeIds: string[]
  messageCount: number
  registeredArtifactCount: number
  latestUtterance?: DigitalHumanUtterance
  onSelectEmployee(employeeId: string): void
  onOpenDossier(employeeId: string): void
  onOpenTrace(): void
  onOpenArtifacts(): void
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
  messageCount,
  registeredArtifactCount,
  latestUtterance,
  onSelectEmployee,
  onOpenDossier,
  onOpenTrace,
  onOpenArtifacts,
}: DigitalHumanModeProps) {
  const [speaking, setSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | undefined>(undefined)
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
  const collaborators = conversationEmployeeIds
    .filter((employeeId) => employeeId !== activeEmployee?.id)
    .map((employeeId) => employees.find((employee) => employee.id === employeeId))
    .filter((employee): employee is CyberEmployee => employee !== undefined)
    .slice(0, 2)
  const hasExecutionFact = entities.some((entity) => entity.activityRef !== undefined && entity.activity !== 'idle')
  const sequence = [
    { id: 'intent', label: '用户意图', detail: messageCount > 0 ? '已确立' : '等待消息', confirmed: messageCount > 0, Icon: CheckCircle, onClick: onOpenTrace },
    { id: 'dispatch', label: '角色分发', detail: conversationEmployeeIds.length > 0 ? `${conversationEmployeeIds.length} 名角色` : '尚未分发', confirmed: conversationEmployeeIds.length > 0, Icon: GitBranch, onClick: onOpenTrace },
    { id: 'tools', label: '工具执行', detail: hasExecutionFact ? '已建立事实' : '等待事实', confirmed: hasExecutionFact, Icon: Wrench, onClick: onOpenTrace },
    { id: 'artifacts', label: '产物登记', detail: registeredArtifactCount > 0 ? `${registeredArtifactCount} 个引用` : '等待事实', confirmed: registeredArtifactCount > 0, Icon: Package, onClick: onOpenArtifacts },
  ]

  const toggleSpeech = useCallback(() => {
    if (!canSpeak || latestUtterance === undefined) return
    if (speaking) {
      window.speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    try {
      const utterance = new SpeechSynthesisUtterance(spokenText)
      utterance.lang = 'zh-CN'
      utterance.rate = 0.96
      utterance.pitch = 1
      const chineseVoice = window.speechSynthesis.getVoices().find((voice) => /^zh(?:-|_)/iu.test(voice.lang))
      if (chineseVoice !== undefined) utterance.voice = chineseVoice
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
  }, [canSpeak, latestUtterance, speaking, spokenText])

  useEffect(() => () => {
    if (utteranceRef.current !== undefined && typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  return <section className={`digital-human${staticMode ? ' digital-human--static' : ''}${connected ? '' : ' digital-human--offline'}`} data-state={activeState} data-expression={motionCue.expression} data-gesture={motionCue.gesture} data-speaking={speaking ? 'true' : 'false'} aria-label={`${world.name}数字人行动舱`}>
    <div className="digital-human__bay" aria-hidden="true" />
    <nav className="digital-human__sequence" aria-label="当前会话耐久事实">
      <span className="digital-human__sequence-title">当前会话耐久事实</span>
      <ol>{sequence.map(({ id, label, detail, confirmed, Icon, onClick }) => <li key={id} className={confirmed ? 'is-confirmed' : 'is-pending'}>
        <button type="button" onClick={onClick} aria-label={`${label}：${detail}`}>
          <Icon size={17} weight={confirmed ? 'fill' : 'regular'} aria-hidden="true" />
          <span><strong>{label}</strong><small>{detail}</small></span>
        </button>
      </li>)}</ol>
    </nav>

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

    <aside className="digital-human__states" aria-label="数字人状态脊柱">
      <header><strong>状态脊柱</strong><small>由真实运行事实驱动</small></header>
      <ol>{STATUS_ITEMS.map(({ id, label, description, Icon }) => <li key={id} className={id === activeState ? 'is-active' : ''}>
        <Icon size={18} weight={id === activeState ? 'fill' : 'regular'} aria-hidden="true" />
        <span><strong>{label}</strong><small>{description}</small></span>
      </li>)}</ol>
    </aside>

    <footer className="digital-human__actions">
      <button type="button" disabled={activeEmployee === undefined} onClick={() => activeEmployee && onOpenDossier(activeEmployee.id)}><UserFocus size={17} aria-hidden="true" /><span><strong>数字人档案</strong><small>查看身份与职责</small></span></button>
      <button type="button" disabled={!canSpeak} aria-pressed={speaking} onClick={toggleSpeech}>{speaking ? <SpeakerSlash size={17} aria-hidden="true" /> : <SpeakerHigh size={17} aria-hidden="true" />}<span><strong>{speaking ? '停止播报' : '播报回复'}</strong><small>{voiceHint}</small></span></button>
      <button type="button" onClick={onOpenTrace}><GitBranch size={17} aria-hidden="true" /><span><strong>序列追溯</strong><small>查看耐久事实</small></span></button>
      <button type="button" disabled={collaborators[0] === undefined} onClick={() => collaborators[0] && onSelectEmployee(collaborators[0].id)}><UserFocus size={17} aria-hidden="true" /><span><strong>聚焦协作者</strong><small>{collaborators[0]?.displayName ?? '当前没有协作者'}</small></span></button>
    </footer>
    {connected ? null : <div className="digital-human__connection" role="status"><WarningCircle size={16} aria-hidden="true" />实时世界正在重连，画面已冻结</div>}
  </section>
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
  const column = normalized % 4
  const row = Math.floor(normalized / 4)
  return {
    '--digital-human-x': `${column * 33.3333}%`,
    '--digital-human-y': `${row * 100}%`,
  } as CSSProperties
}
