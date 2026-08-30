import { useEffect, type CSSProperties } from 'react'

import type { DigitalHumanRendererProps } from '../renderer/DigitalHumanRenderer.js'

export function SpriteRuntimeRenderer({ employee, state, speaking, staticMode, onReady }: DigitalHumanRendererProps) {
  useEffect(() => { onReady() }, [])
  const customImage = employee.avatarProfile?.rendererKind === 'image-2d' ? employee.avatarAssetUrl : undefined
  return <div className={`focus-avatar focus-avatar--sprite${staticMode ? ' is-static' : ''}`} data-state={state} data-speaking={speaking ? 'true' : 'false'}>
    {customImage === undefined
      ? <span className="focus-avatar__sprite" style={digitalHumanAtlasStyle(employee.avatarIndex)} role="img" aria-label={`${employee.displayName} 2D 数字人`} />
      : <img className="focus-avatar__image" src={customImage} alt={`${employee.displayName} 2D 数字人`} />}
  </div>
}

function digitalHumanAtlasStyle(index: number): CSSProperties {
  const normalized = Math.max(0, Math.min(7, Math.floor(index)))
  const firstFrameByAvatar = [2, 0, 4, 6, 10, 8, 12, 14]
  const closedFrame = firstFrameByAvatar[normalized] ?? 0
  const openFrame = closedFrame + 1
  return {
    '--digital-human-closed-x': `${(closedFrame % 4) * 33.3333}%`,
    '--digital-human-closed-y': `${Math.floor(closedFrame / 4) * 33.3333}%`,
    '--digital-human-open-x': `${(openFrame % 4) * 33.3333}%`,
    '--digital-human-open-y': `${Math.floor(openFrame / 4) * 33.3333}%`,
  } as CSSProperties
}
