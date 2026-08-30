import { lazy, Suspense } from 'react'

import { SpriteRuntimeRenderer } from '../sprite/SpriteRuntimeRenderer.js'
import type { DigitalHumanRendererAdapter, DigitalHumanRendererProps } from './DigitalHumanRenderer.js'
import type { RenderingQuality } from './RenderingQuality.js'

const VrmRuntimeRenderer = lazy(async () => ({ default: (await import('../vrm/VrmRuntimeRenderer.js')).VrmRuntimeRenderer }))

const spriteAdapter: DigitalHumanRendererAdapter = {
  id: 'dsh.sprite-2d', kind: 'sprite-2d', capabilities: ['speech', 'gesture'], Component: SpriteRuntimeRenderer,
  supports: () => true,
}

const vrmAdapter: DigitalHumanRendererAdapter = {
  id: 'dsh.vrm-3d', kind: 'vrm-3d', capabilities: ['speech', 'viseme', 'expression', 'gesture', 'look-at'],
  Component: (props) => <Suspense fallback={<div className="focus-avatar__loading" role="status">正在载入 3D 数字人…</div>}><VrmRuntimeRenderer {...props} /></Suspense>,
  supports: (employee, quality) => employee.avatarProfile?.rendererKind === 'vrm-3d' && employee.avatarAssetUrl !== undefined && quality !== 'static',
}

const adapters = [vrmAdapter, spriteAdapter]

export function selectRenderer(employee: DigitalHumanRendererProps['employee'], quality: RenderingQuality): DigitalHumanRendererAdapter {
  return adapters.find((adapter) => adapter.supports(employee, quality)) ?? spriteAdapter
}

export function RegisteredDigitalHumanRenderer(props: DigitalHumanRendererProps) {
  const adapter = selectRenderer(props.employee, props.quality)
  const Component = adapter.Component
  return <div className="focus-avatar-renderer" data-renderer-kind={adapter.kind} data-renderer-id={adapter.id}><Component {...props} /></div>
}

export function registeredRendererIds(): string[] { return adapters.map((adapter) => adapter.id) }
