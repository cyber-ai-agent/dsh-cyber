import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_WORLD_VIEW,
  cameraModesFor,
  readWorldView,
  reconcileView,
  rendererKindFor,
  supportsCameraMode,
  viewForFocus,
  writeWorldView,
} from '../src/features/world/runtime/world-view-mode.js'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('renderer and camera are separate questions', () => {
  it('maps each renderer mode to a registered renderer kind', () => {
    expect(rendererKindFor('2d')).toBe('pixi-2d')
    expect(rendererKindFor('3d')).toBe('three-3d')
  })

  it('offers follow only where a camera can trail somebody', () => {
    expect(cameraModesFor('3d')).toContain('follow')
    expect(cameraModesFor('2d')).not.toContain('follow')
    expect(supportsCameraMode('2d', 'follow')).toBe(false)
    expect(supportsCameraMode('2d', 'focus')).toBe(true)
  })

  it('keeps focus when a renderer change makes follow illegal', () => {
    // Dropping to the whole company would throw away the thing the user was
    // actually looking at; staying on the character is nearer the request.
    expect(reconcileView({ renderer: '2d', camera: 'follow' })).toEqual({ renderer: '2d', camera: 'focus' })
  })

  it('leaves a legal view alone', () => {
    const view = { renderer: '3d', camera: 'follow' } as const
    expect(reconcileView(view)).toBe(view)
  })

  it('falls back to the whole company when there is nobody to point at', () => {
    expect(viewForFocus({ renderer: '3d', camera: 'focus' }, undefined))
      .toEqual({ renderer: '3d', camera: 'overview' })
    expect(viewForFocus({ renderer: '3d', camera: 'follow' }, undefined))
      .toEqual({ renderer: '3d', camera: 'overview' })
  })

  it('keeps pointing at a character that exists', () => {
    const view = { renderer: '3d', camera: 'focus' } as const
    expect(viewForFocus(view, 'employee-1')).toBe(view)
  })
})

describe('stored views', () => {
  it('round-trips', () => {
    writeWorldView('world-1', { renderer: '3d', camera: 'follow' })
    expect(readWorldView('world-1')).toEqual({ renderer: '3d', camera: 'follow' })
  })

  it('migrates the three values earlier versions wrote', () => {
    // 'map' meant the whole company in 2D; '2d' and '3d' meant one character.
    // Both halves of the old value survive rather than resetting the user.
    localStorage.setItem('dsh-cyber-world-view:world-1', 'map')
    expect(readWorldView('world-1')).toEqual({ renderer: '2d', camera: 'overview' })

    localStorage.setItem('dsh-cyber-world-view:world-1', '2d')
    expect(readWorldView('world-1')).toEqual({ renderer: '2d', camera: 'focus' })

    localStorage.setItem('dsh-cyber-world-view:world-1', '3d')
    expect(readWorldView('world-1')).toEqual({ renderer: '3d', camera: 'focus' })
  })

  it('reconciles an illegal stored combination', () => {
    localStorage.setItem('dsh-cyber-world-view:world-1', '2d/follow')
    expect(readWorldView('world-1')).toEqual({ renderer: '2d', camera: 'focus' })
  })

  it('falls back on anything it cannot read', () => {
    localStorage.setItem('dsh-cyber-world-view:world-1', 'nonsense')
    expect(readWorldView('world-1')).toEqual(DEFAULT_WORLD_VIEW)
    localStorage.clear()
    expect(readWorldView('world-1')).toEqual(DEFAULT_WORLD_VIEW)
  })

  it('opens on the character, the way the single view mode used to', () => {
    // The old default was '2d', which meant a character view. Opening on the
    // whole company instead would silently change what every existing user
    // sees when they arrive.
    expect(DEFAULT_WORLD_VIEW).toEqual({ renderer: '2d', camera: 'focus' })
  })

  it('keeps one world out of another world view', () => {
    writeWorldView('world-1', { renderer: '3d', camera: 'focus' })
    expect(readWorldView('world-2')).toEqual(DEFAULT_WORLD_VIEW)
  })
})
