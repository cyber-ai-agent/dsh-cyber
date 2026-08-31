import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  RendererKind,
  RendererRegistry,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldCue,
} from '@dsh-cyber/contracts'

import { WorldCanvas } from '../src/features/world/WorldCanvas.js'

class DeferredRenderer implements WorldRenderer<HTMLElement> {
  readonly kind: RendererKind = 'three-3d'
  readonly cameraCalls: Array<{ mode: string; subjectId?: string }> = []
  readonly selectedEntities: Array<string | undefined> = []
  readonly selectedObjects: Array<string | undefined> = []
  readonly focusCalls: string[] = []
  resolveMount: (() => void) | undefined
  #zoom = 1

  mount(): Promise<void> {
    return new Promise((resolve) => { this.resolveMount = resolve })
  }

  updateSnapshot(): void {}
  applyCues(_cues: WorldCue[]): void {}
  selectEntity(entityId?: string): void { this.selectedEntities.push(entityId) }
  selectObject(objectId?: string): void { this.selectedObjects.push(objectId) }
  focusEntity(entityId: string): void { this.focusCalls.push(entityId) }
  setCameraMode(mode: string, subjectId?: string): void { this.cameraCalls.push({ mode, subjectId }) }
  fitScene(): void { this.#zoom = 1 }
  zoomBy(delta: number): void { this.#zoom += delta }
  getZoom(): number { return this.#zoom }
  destroy(): void {}
}

class DeferredRegistry implements RendererRegistry<HTMLElement> {
  constructor(readonly renderer: DeferredRenderer) {}
  supports(kind: RendererKind): boolean { return kind === 'three-3d' }
  create(_kind: RendererKind, _callbacks: WorldRendererCallbacks): WorldRenderer<HTMLElement> { return this.renderer }
}

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

describe('WorldCanvas lazy mount state replay', () => {
  it('replays the latest camera and selection after a delayed 3D mount', async () => {
    const renderer = new DeferredRenderer()
    const registry = new DeferredRegistry(renderer)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    const initial = props(registry, { mode: 'overview', subjectId: undefined, focusEntityId: undefined, selectedEntityId: undefined, selectedObjectId: undefined })

    await act(async () => { root.render(createElement(WorldCanvas, initial)) })
    expect(renderer.resolveMount).toBeTypeOf('function')

    const focus = props(registry, { mode: 'focus', subjectId: 'employee-a', focusEntityId: 'employee-a', selectedEntityId: 'employee-a', selectedObjectId: 'desk-a' })
    await act(async () => { root.render(createElement(WorldCanvas, focus)) })
    const latest = props(registry, { mode: 'follow', subjectId: 'employee-a', focusEntityId: undefined, selectedEntityId: 'employee-a', selectedObjectId: 'desk-a' })
    await act(async () => { root.render(createElement(WorldCanvas, latest)) })
    renderer.resolveMount?.()
    await act(async () => { await Promise.resolve() })

    expect(renderer.cameraCalls.at(-1)).toEqual({ mode: 'follow', subjectId: 'employee-a' })
    expect(renderer.focusCalls).toEqual([])
    expect(renderer.selectedEntities.at(-1)).toBe('employee-a')
    expect(renderer.selectedObjects.at(-1)).toBe('desk-a')
    document.body.removeChild(host)
  })
})

function props(
  rendererRegistry: RendererRegistry<HTMLElement>,
  state: { mode: 'overview' | 'focus' | 'follow'; subjectId: string | undefined; focusEntityId: string | undefined; selectedEntityId: string | undefined; selectedObjectId: string | undefined },
) {
  const snapshot = {
    contractVersion: 1,
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    templateId: 'cyber-company',
    themeId: 'theme-1',
    sceneId: 'scene-1',
    sequence: 1,
    generatedAt: '2026-08-28T00:00:00.000Z',
    clock: { now: '2026-08-28T00:00:00.000Z', timezone: 'Asia/Shanghai', lightsOn: true },
    entities: [{
      id: 'employee-a', kind: 'agent', sceneId: 'scene-1', displayName: '小刘', position: { x: 0, y: 0 }, footOffset: { x: 0, y: 0 }, facing: 'south', activity: 'idle', activityLabel: '待命', route: [], visualState: {}, updatedAt: '2026-08-28T00:00:00.000Z',
    }],
    objects: [{ id: 'desk-a', kind: 'desk', displayName: '桌面', state: 'idle', position: { x: 0, y: 0 }, updatedAt: '2026-08-28T00:00:00.000Z' }],
    growthSlots: {},
  } as unknown as WorldRuntimeSnapshot
  const manifest = {
    schemaVersion: 1, id: 'theme-1', version: '1.0.0', templateId: 'cyber-company', displayName: '公司', renderer: 'three-3d', terminology: {}, assets: [], actorSets: [], activityMapping: {}, scenes: [{
      id: 'scene-1', displayName: '办公室', size: { width: 800, height: 600 }, cameraBounds: { x: 0, y: 0, width: 800, height: 600 }, safeArea: { x: 0, y: 0, width: 800, height: 600 }, layers: [], anchors: [], navigation: { origin: { x: 0, y: 0 }, cellSize: 64, columns: 12, rows: 9, blocked: [] }, interactables: [], growthSlots: [],
    }],
  } as unknown as WorldThemeManifestV1
  return {
    manifest,
    rendererKind: 'three-3d' as const,
    rendererRegistry,
    spatialCapabilityProvider: { supportsSpatialRendering: () => true, quality: () => 'high' as const },
    rendererIdentity: 'test-renderer', snapshot, cues: [],
    cameraMode: state.mode, cameraSubjectId: state.subjectId, selectedEntityId: state.selectedEntityId, selectedObjectId: state.selectedObjectId,
    focusEntityId: state.focusEntityId, fitRequest: 0, onEntitySelect: () => {}, onObjectSelect: () => {}, onReady: () => {},
  }
}
