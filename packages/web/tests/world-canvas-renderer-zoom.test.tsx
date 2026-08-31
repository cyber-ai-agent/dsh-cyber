import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  RendererKind,
  RendererRegistry,
  WorldCue,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldZoomCommand,
} from '@dsh-cyber/contracts'

import { WorldCanvas } from '../src/features/world/WorldCanvas.js'

class ZoomRenderer implements WorldRenderer<HTMLElement> {
  #zoom = 1
  constructor(readonly kind: RendererKind) {}
  async mount(): Promise<void> {}
  updateSnapshot(): void {}
  applyCues(_cues: WorldCue[]): void {}
  selectEntity(): void {}
  selectObject(): void {}
  focusEntity(): void {}
  fitScene(): void { this.#zoom = 1 }
  zoomBy(delta: number): void { this.#zoom += delta }
  getZoom(): number { return this.#zoom }
  destroy(): void {}
}

class ZoomRegistry implements RendererRegistry<HTMLElement> {
  readonly created = new Map<RendererKind, ZoomRenderer[]>()
  register(): void {}
  supports(): boolean { return true }
  create(kind: RendererKind, _callbacks: WorldRendererCallbacks): WorldRenderer<HTMLElement> {
    const renderer = new ZoomRenderer(kind)
    const list = this.created.get(kind) ?? []
    list.push(renderer)
    this.created.set(kind, list)
    return renderer
  }
  latest(kind: RendererKind): ZoomRenderer {
    const renderer = this.created.get(kind)?.at(-1)
    if (renderer === undefined) throw new Error(`renderer not created: ${kind}`)
    return renderer
  }
}

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

const spatialCapabilityProvider = {
  supportsSpatialRendering: () => true,
  quality: () => 'high' as const,
}

describe('WorldCanvas renderer-local zoom', () => {
  it('does not replay a Pixi scale into the Three follow camera and restores each renderer independently', async () => {
    const registry = new ZoomRegistry()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)

    await render(root, registry, 'pixi-2d')
    await render(root, registry, 'pixi-2d', { id: '2d-zoom-1', delta: 0.1 })
    await render(root, registry, 'pixi-2d', { id: '2d-zoom-2', delta: 0.1 })
    expect(registry.latest('pixi-2d').getZoom()).toBeCloseTo(1.2)

    await render(root, registry, 'three-3d', { id: '2d-zoom-2', delta: 0.1 })
    expect(registry.latest('three-3d').getZoom()).toBeCloseTo(1)

    await render(root, registry, 'three-3d', { id: '3d-zoom-1', delta: -0.1 })
    expect(registry.latest('three-3d').getZoom()).toBeCloseTo(0.9)

    await render(root, registry, 'pixi-2d', { id: '3d-zoom-1', delta: -0.1 })
    expect(registry.latest('pixi-2d').getZoom()).toBeCloseTo(1.2)

    document.body.removeChild(host)
  })
})

async function render(
  root: ReturnType<typeof createRoot>,
  registry: RendererRegistry<HTMLElement>,
  rendererKind: RendererKind,
  zoomCommand?: WorldZoomCommand,
): Promise<void> {
  await act(async () => {
    root.render(createElement(WorldCanvas, {
      manifest: manifest(),
      rendererKind,
      rendererRegistry: registry,
      spatialCapabilityProvider,
      rendererIdentity: 'zoom-test',
      snapshot: snapshot(),
      cues: [],
      cameraMode: rendererKind === 'three-3d' ? 'follow' : 'overview',
      cameraSubjectId: 'employee-a',
      fitRequest: 0,
      ...(zoomCommand === undefined ? {} : { zoomCommand }),
      onEntitySelect: () => {},
      onObjectSelect: () => {},
      onReady: () => {},
    }))
    await Promise.resolve()
  })
}

function snapshot(): WorldRuntimeSnapshot {
  return {
    contractVersion: 1,
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    templateId: 'cyber-company',
    themeId: 'theme-1',
    sceneId: 'scene-1',
    sequence: 1,
    generatedAt: '2026-08-31T00:00:00.000Z',
    clock: { now: '2026-08-31T00:00:00.000Z', timezone: 'Asia/Shanghai', lightsOn: true },
    entities: [{
      id: 'employee-a', kind: 'agent', sceneId: 'scene-1', displayName: '林思琪', position: { x: 400, y: 400 }, footOffset: { x: 0, y: 0 }, facing: 'south', activity: 'idle', activityLabel: '待命', route: [], visualState: { rosterIndex: 1 }, updatedAt: '2026-08-31T00:00:00.000Z',
    }],
    objects: [],
    growthSlots: {},
  } as unknown as WorldRuntimeSnapshot
}

function manifest(): WorldThemeManifestV1 {
  return {
    schemaVersion: 1,
    id: 'theme-1',
    version: '1.0.0',
    templateId: 'cyber-company',
    displayName: '公司',
    renderer: 'pixi-2d',
    terminology: {},
    assets: [],
    actorSets: [],
    activityMapping: {},
    scenes: [{
      id: 'scene-1', displayName: '办公室', size: { width: 800, height: 600 },
      cameraBounds: { x: 0, y: 0, width: 800, height: 600 },
      safeArea: { x: 0, y: 0, width: 800, height: 600 },
      layers: [], anchors: [],
      navigation: { origin: { x: 0, y: 0 }, cellSize: 64, columns: 12, rows: 9, blocked: [] },
      interactables: [], growthSlots: [],
    }],
  } as unknown as WorldThemeManifestV1
}
