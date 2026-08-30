import type { ComponentType } from 'react'
import type { WorldRuntimeEntityState } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../../../types.js'
import type { DigitalHumanMotionCue, DigitalHumanVisualState } from '../../digital-human-motion.js'
import type { RenderingQuality } from './RenderingQuality.js'

export type RuntimeRendererKind = 'sprite-2d' | 'vrm-3d' | 'live-avatar'
export type RuntimeRendererCapability = 'speech' | 'viseme' | 'expression' | 'gesture' | 'look-at'

export interface DigitalHumanRendererProps {
  employee: CyberEmployee
  entity?: WorldRuntimeEntityState | undefined
  state: DigitalHumanVisualState
  motionCue: DigitalHumanMotionCue
  speaking: boolean
  staticMode: boolean
  quality: RenderingQuality
  onReady(): void
  onFallback(reason: string): void
}

export interface DigitalHumanRendererAdapter {
  id: string
  kind: RuntimeRendererKind
  capabilities: RuntimeRendererCapability[]
  Component: ComponentType<DigitalHumanRendererProps>
  supports(employee: CyberEmployee, quality: RenderingQuality): boolean
}

/** Future provider-neutral live video renderer. No vendor SDK belongs here. */
export interface LiveAvatarRendererPort {
  readonly id: string
  readonly capabilities: RuntimeRendererCapability[]
  mount(host: HTMLElement): Promise<void>
  update(input: Pick<DigitalHumanRendererProps, 'state' | 'motionCue' | 'speaking'>): void
  pause(): void
  dispose(): void
}
