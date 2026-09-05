import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  RendererRegistry,
  WorldCue,
  WorldRenderer,
  WorldRendererCallbacks,
  WorldRuntimeSnapshot,
  WorldThemeManifestV1,
  WorldZoomCommand,
} from '@dsh-cyber/contracts'

import { WorldCanvas } from '../src/features/world/WorldCanvas.js'

/**
 * A zoom command belongs to the render it arrived on.
 *
 * This file was never collected — the vitest projects matched only `*.test.ts`
 * — so it kept asserting a `rendererKind` prop and a Three follow camera that
 * `WorldCanvas` deliberately no longer has: Three, VRM and 3D camera state live
 * in the optional spatial extension and are never imported by this path. What
 * survives, and is still worth holding, is that a command id applies once.
 */

class ZoomRenderer implements WorldRenderer<HTMLElement> {
  #zoom = 1
  constructor(readonly kind: string) {}
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
  readonly created = new Map<string, ZoomRenderer[]>()
  register(): void {}
  supports(): boolean { return true }
  create(kind: string, _callbacks: WorldRendererCallbacks): WorldRenderer<HTMLElement> {
    const renderer = new ZoomRenderer(kind)
    const list = this.created.get(kind) ?? []
    list.push(renderer)
    this.created.set(kind, list)
    return renderer
  }
  latest(kind: string): ZoomRenderer {
    const renderer = this.created.get(kind)?.at(-1)
    if (renderer === undefined) throw new Error(`renderer not created: ${kind}`)
    return renderer
  }
}

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

describe('WorldCanvas renderer-local zoom', () => {
  it('applies a zoom command once per id and never replays it on a later render', async () => {
    const registry = new ZoomRegistry()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)

    await render(root, registry)
    await render(root, registry, { id: 'zoom-1', delta: 0.1 })
    expect(registry.latest('pixi-2d').getZoom()).toBeCloseTo(1.1)

    // The same command id arriving again is the same command, not a second one.
    await render(root, registry, { id: 'zoom-1', delta: 0.1 })
    expect(registry.latest('pixi-2d').getZoom()).toBeCloseTo(1.1)

    await render(root, registry, { id: 'zoom-2', delta: -0.3 })
    expect(registry.latest('pixi-2d').getZoom()).toBeCloseTo(0.8)

    document.body.removeChild(host)
  })
})

async function render(
  root: ReturnType<typeof createRoot>,
  registry: RendererRegistry<HTMLElement>,
  zoomCommand?: WorldZoomCommand,
): Promise<void> {
  await act(async () => {
    root.render(createElement(WorldCanvas, {
      manifest: manifest(),
      rendererRegistry: registry,
      rendererIdentity: 'zoom-test',
      snapshot: snapshot(),
      cues: [],
      cameraMode: 'overview',
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
