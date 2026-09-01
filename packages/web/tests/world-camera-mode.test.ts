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

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('core world view modes', () => {
  it('keeps both core modes on the lightweight Pixi renderer', () => {
    expect(rendererKindFor('map')).toBe('pixi-2d')
    expect(rendererKindFor('2d')).toBe('pixi-2d')
  })

  it('exposes no spatial camera modes in core', () => {
    expect(cameraModesFor('map')).toEqual(['overview'])
    expect(cameraModesFor('2d')).toEqual(['focus'])
    expect(supportsCameraMode('map', 'follow')).toBe(false)
    expect(supportsCameraMode('2d', 'follow')).toBe(false)
    expect(supportsCameraMode('2d', 'focus')).toBe(true)
  })

  it('normalizes map and focused 2d views', () => {
    expect(reconcileView({ renderer: 'map', camera: 'follow' })).toEqual({ renderer: 'map', camera: 'overview' })
    expect(reconcileView({ renderer: '2d', camera: 'follow' })).toEqual({ renderer: '2d', camera: 'focus' })
  })

  it('falls back to the map when 2d has nobody to focus', () => {
    expect(viewForFocus({ renderer: '2d', camera: 'focus' }, undefined)).toEqual({ renderer: 'map', camera: 'overview' })
  })

  it('keeps a focused character in 2d', () => {
    expect(viewForFocus({ renderer: '2d', camera: 'focus' }, 'employee-1')).toEqual({ renderer: '2d', camera: 'focus' })
  })
})

describe('stored core views', () => {
  it('round-trips map and 2d only', () => {
    writeWorldView('world-1', { renderer: 'map', camera: 'overview' })
    expect(readWorldView('world-1')).toEqual({ renderer: 'map', camera: 'overview' })
    writeWorldView('world-1', { renderer: '2d', camera: 'focus' })
    expect(readWorldView('world-1')).toEqual({ renderer: '2d', camera: 'focus' })
  })

  it('migrates old direct renderer values without reopening 3d', () => {
    localStorage.setItem('dsh-cyber-world-view:world-1', 'map')
    expect(readWorldView('world-1')).toEqual({ renderer: 'map', camera: 'overview' })

    localStorage.setItem('dsh-cyber-world-view:world-1', '2d')
    expect(readWorldView('world-1')).toEqual({ renderer: '2d', camera: 'focus' })

    localStorage.setItem('dsh-cyber-world-view:world-1', '3d')
    expect(readWorldView('world-1')).toEqual({ renderer: '2d', camera: 'focus' })

    localStorage.setItem('dsh-cyber-world-view:world-1', '3d/overview')
    expect(readWorldView('world-1')).toEqual({ renderer: 'map', camera: 'overview' })

    localStorage.setItem('dsh-cyber-world-view:world-1', '3d/follow')
    expect(readWorldView('world-1')).toEqual({ renderer: '2d', camera: 'focus' })
  })

  it('reconciles illegal combinations', () => {
    localStorage.setItem('dsh-cyber-world-view:world-1', '2d/follow')
    expect(readWorldView('world-1')).toEqual({ renderer: '2d', camera: 'focus' })
    localStorage.setItem('dsh-cyber-world-view:world-1', '2d/overview')
    expect(readWorldView('world-1')).toEqual({ renderer: 'map', camera: 'overview' })
  })

  it('falls back on anything it cannot read', () => {
    localStorage.setItem('dsh-cyber-world-view:world-1', 'nonsense')
    expect(readWorldView('world-1')).toEqual(DEFAULT_WORLD_VIEW)
    localStorage.clear()
    expect(readWorldView('world-1')).toEqual(DEFAULT_WORLD_VIEW)
  })

  it('opens on the lightweight company map by default', () => {
    expect(DEFAULT_WORLD_VIEW).toEqual({ renderer: 'map', camera: 'overview' })
  })

  it('keeps one world out of another world view', () => {
    writeWorldView('world-1', { renderer: '2d', camera: 'focus' })
    expect(readWorldView('world-2')).toEqual(DEFAULT_WORLD_VIEW)
  })
})
