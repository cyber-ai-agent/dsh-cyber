export type DigitalHumanVisualState = 'idle' | 'thinking' | 'executing' | 'speaking' | 'approval' | 'failed'
export type DigitalHumanExpression = 'neutral' | 'focused' | 'confident' | 'speaking' | 'concerned' | 'exhausted'
export type DigitalHumanGesture = 'breathe' | 'listen' | 'explain' | 'present' | 'hold' | 'freeze'
export type DigitalHumanRendererKind = 'sprite-2d' | 'live-portrait' | 'vrm-3d'
export type DigitalHumanCapability = 'speech' | 'viseme' | 'expression' | 'gesture' | 'look-at'

export interface DigitalHumanRendererDescriptor {
  kind: DigitalHumanRendererKind
  capabilities: DigitalHumanCapability[]
  assetRef: string
}

export interface DigitalHumanMotionCue {
  expression: DigitalHumanExpression
  gesture: DigitalHumanGesture
}

/**
 * Provider-neutral motion intent. Sprite, portrait and VRM renderers consume
 * the same cue so model/provider code never leaks into the world UI.
 */
export function motionCueForState(state: DigitalHumanVisualState): DigitalHumanMotionCue {
  if (state === 'thinking') return { expression: 'focused', gesture: 'listen' }
  if (state === 'executing') return { expression: 'confident', gesture: 'present' }
  if (state === 'speaking') return { expression: 'speaking', gesture: 'explain' }
  if (state === 'approval') return { expression: 'concerned', gesture: 'hold' }
  if (state === 'failed') return { expression: 'exhausted', gesture: 'freeze' }
  return { expression: 'neutral', gesture: 'breathe' }
}

export function visualStateForEntity(entity: import('@dsh-cyber/contracts').WorldRuntimeEntityState | undefined, connected: boolean, speaking = false): DigitalHumanVisualState {
  if (!connected || entity?.activity === 'blocked' || entity?.status === 'blocked') return 'failed'
  if (speaking) return 'speaking'
  if (/审批|approval|等待确认/iu.test(entity?.activityLabel ?? '')) return 'approval'
  if (entity?.activity === 'thinking' || entity?.activity === 'talking') return 'thinking'
  if (entity?.activity === 'working' || entity?.activity === 'walking' || entity?.activity === 'meeting') return 'executing'
  return 'idle'
}

/** Keep local TTS useful by removing markup, code blocks and machine URLs. */
export function speechTextFromMessage(content: string, limit = 800): string {
  const normalized = content
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/[>*_~|-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}
