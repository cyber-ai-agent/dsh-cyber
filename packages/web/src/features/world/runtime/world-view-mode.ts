import type { RendererKind } from '@dsh-cyber/contracts'

/**
 * Core world view modes.
 *
 * 3D is intentionally not part of this state anymore. It is an optional
 * extension with its own lifecycle, camera and renderer. Keeping it out of the
 * core view model prevents a spatial experiment from becoming a requirement
 * for every world/session/navigation path.
 */
export type WorldRendererMode = 'map' | '2d'

export type WorldCameraMode =
  | 'overview'
  | 'focus'
  /** Kept in the shared camera vocabulary for the optional spatial extension. */
  | 'follow'

export interface WorldViewState {
  renderer: WorldRendererMode
  camera: WorldCameraMode
}

/** The company opens as a lightweight map. */
export const DEFAULT_WORLD_VIEW: WorldViewState = { renderer: 'map', camera: 'overview' }

/** Both core modes are views over the same lightweight Pixi world. */
export function rendererKindFor(_mode: WorldRendererMode): RendererKind {
  return 'pixi-2d'
}

/** Core UI exposes map/2D, not a second camera-mode switch. */
export function cameraModesFor(mode: WorldRendererMode): WorldCameraMode[] {
  return mode === 'map' ? ['overview'] : ['focus']
}

export function supportsCameraMode(renderer: WorldRendererMode, camera: WorldCameraMode): boolean {
  return cameraModesFor(renderer).includes(camera)
}

export function reconcileView(view: WorldViewState): WorldViewState {
  return view.renderer === 'map'
    ? { renderer: 'map', camera: 'overview' }
    : { renderer: '2d', camera: 'focus' }
}

/** A focused 2D view without a character falls back to the map. */
export function viewForFocus(view: WorldViewState, focusedEntityId: string | undefined): WorldViewState {
  if (view.renderer === 'map') return { renderer: 'map', camera: 'overview' }
  return focusedEntityId === undefined
    ? { renderer: 'map', camera: 'overview' }
    : { renderer: '2d', camera: 'focus' }
}

const STORAGE_PREFIX = 'dsh-cyber-world-view'

/**
 * Read old states safely. Legacy 3D never re-opens the heavy renderer: overview
 * becomes the map, while focused/follow 3D becomes the equivalent 2D focus.
 */
export function readWorldView(worldId: string): WorldViewState {
  if (typeof localStorage === 'undefined') return DEFAULT_WORLD_VIEW
  const stored = safeRead(`${STORAGE_PREFIX}:${worldId}`)
  if (stored === null) return DEFAULT_WORLD_VIEW
  return parseView(stored) ?? DEFAULT_WORLD_VIEW
}

export function writeWorldView(worldId: string, view: WorldViewState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(`${STORAGE_PREFIX}:${worldId}`, `${view.renderer}/${view.camera}`)
  } catch {
    // A private window or a full quota is not a reason to fail the world view.
  }
}

function parseView(stored: string): WorldViewState | undefined {
  if (stored === 'map') return { renderer: 'map', camera: 'overview' }
  if (stored === '2d') return { renderer: '2d', camera: 'focus' }
  if (stored === '3d') return { renderer: '2d', camera: 'focus' }

  const [renderer, camera] = stored.split('/')
  if (renderer === 'map') return { renderer: 'map', camera: 'overview' }
  if (renderer === '2d') return camera === 'overview'
    ? { renderer: 'map', camera: 'overview' }
    : { renderer: '2d', camera: 'focus' }
  if (renderer === '3d') return camera === 'overview'
    ? { renderer: 'map', camera: 'overview' }
    : { renderer: '2d', camera: 'focus' }
  return undefined
}

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
