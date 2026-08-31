import type { RendererKind } from '@dsh-cyber/contracts'

/**
 * How the world is drawn, and where the camera is looking. Two questions.
 *
 * They used to be one: `WorldViewMode = 'map' | '2d' | '3d'` made "the whole
 * company" and "one character" alternatives to each other, so looking closely
 * at somebody meant leaving the world, and 3D meant a single-character view
 * rather than a way of drawing the company. Splitting them is what lets a
 * character be focused *inside* the world, in either renderer.
 */

export type WorldRendererMode = '2d' | '3d'

export type WorldCameraMode =
  /** The whole company. */
  | 'overview'
  /** Held on one character, who stays in their world. */
  | 'focus'
  /** Trailing a character as they move. */
  | 'follow'

export interface WorldViewState {
  renderer: WorldRendererMode
  camera: WorldCameraMode
}

/**
 * What a world opens on.
 *
 * Focus rather than overview, because that is what the single view mode
 * defaulted to before it was split: a user arriving with a character selected
 * was shown that character. `viewForFocus` sends this back to the whole
 * company when there is nobody to look at, so an empty world still opens on
 * the office.
 */
export const DEFAULT_WORLD_VIEW: WorldViewState = { renderer: '2d', camera: 'focus' }

const RENDERER_KINDS: Record<WorldRendererMode, RendererKind> = {
  '2d': 'pixi-2d',
  '3d': 'three-3d',
}

export function rendererKindFor(mode: WorldRendererMode): RendererKind {
  return RENDERER_KINDS[mode]
}

/**
 * Which camera modes a renderer can actually offer.
 *
 * The 2D world is drawn from directly above and cannot trail a character
 * through a scene, so `follow` is a 3D-only camera. Offering it in 2D would be
 * a control that does nothing.
 */
export function cameraModesFor(mode: WorldRendererMode): WorldCameraMode[] {
  return mode === '3d' ? ['overview', 'focus', 'follow'] : ['overview', 'focus']
}

export function supportsCameraMode(renderer: WorldRendererMode, camera: WorldCameraMode): boolean {
  return cameraModesFor(renderer).includes(camera)
}

/**
 * Keeps a view coherent after a renderer change.
 *
 * Switching from 3D to 2D while following somebody has to land somewhere
 * legal; staying on the character is closer to what was asked for than being
 * thrown back to the whole company.
 */
export function reconcileView(view: WorldViewState): WorldViewState {
  if (supportsCameraMode(view.renderer, view.camera)) return view
  return { renderer: view.renderer, camera: view.camera === 'follow' ? 'focus' : 'overview' }
}

/**
 * A camera mode needs somebody to point at.
 *
 * Losing the focused character while focused must fall back rather than leave
 * the camera pointing at nothing.
 */
export function viewForFocus(view: WorldViewState, focusedEntityId: string | undefined): WorldViewState {
  if (focusedEntityId !== undefined || view.camera === 'overview') return view
  return { renderer: view.renderer, camera: 'overview' }
}

const STORAGE_PREFIX = 'dsh-cyber-world-view'

/**
 * Reads the stored view, accepting what earlier versions wrote.
 *
 * `map` meant "the whole company in 2D" and `2d`/`3d` meant "one character",
 * so the old values carry both halves of the new state and are migrated rather
 * than discarded — a user who was last in 3D should still arrive in 3D.
 */
export function readWorldView(worldId: string): WorldViewState {
  if (typeof localStorage === 'undefined') return DEFAULT_WORLD_VIEW
  const stored = safeRead(`${STORAGE_PREFIX}:${worldId}`)
  if (stored === null) return DEFAULT_WORLD_VIEW
  const parsed = parseView(stored)
  return parsed === undefined ? DEFAULT_WORLD_VIEW : reconcileView(parsed)
}

export function writeWorldView(worldId: string, view: WorldViewState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(`${STORAGE_PREFIX}:${worldId}`, `${view.renderer}/${view.camera}`)
  } catch {
    // A private window or a full quota is not a reason to fail the view.
  }
}

function parseView(stored: string): WorldViewState | undefined {
  if (stored === 'map') return { renderer: '2d', camera: 'overview' }
  if (stored === '2d') return { renderer: '2d', camera: 'focus' }
  if (stored === '3d') return { renderer: '3d', camera: 'focus' }
  const [renderer, camera] = stored.split('/')
  if (renderer !== '2d' && renderer !== '3d') return undefined
  if (camera !== 'overview' && camera !== 'focus' && camera !== 'follow') return undefined
  return { renderer, camera }
}

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
