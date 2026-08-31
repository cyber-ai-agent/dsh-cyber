import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorldRendererCallbacks, WorldRuntimeSnapshot, WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import { ThreeWorldRenderer } from '../src/features/world/renderer/spatial/three-world-renderer.js'
import { createWorldRendererRegistry } from '../src/features/world/renderer/renderer-registry.js'
import { WorldLocomotion } from '../src/features/world/runtime/world-locomotion.js'
import { VrmActor } from '../src/features/world/avatar/vrm/VrmActor.js'

class FakeWebGLRenderer {
  readonly domElement = document.createElement('canvas')
  readonly shadowMap = { enabled: false, type: undefined }
  outputColorSpace = THREE.SRGBColorSpace
  toneMapping = THREE.NoToneMapping
  animationLoop: (() => void) | null = null
  renderCount = 0
  lastScene: THREE.Scene | undefined
  lastCamera: THREE.PerspectiveCamera | undefined
  disposed = false
  contextLost = false

  setPixelRatio(_value: number): void {}
  setClearColor(_color: number, _alpha: number): void {}
  setSize(_width: number, _height: number, _updateStyle?: boolean): void {}
  setAnimationLoop(loop: (() => void) | null): void { this.animationLoop = loop }
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void { this.renderCount += 1; this.lastScene = scene; this.lastCamera = camera }
  forceContextLoss(): void { this.contextLost = true }
  dispose(): void { this.disposed = true }
}

const renderers: FakeWebGLRenderer[] = []
afterEach(() => { renderers.length = 0 })

describe('ThreeWorldRenderer integration', () => {
  it('mounts a real office scene, routes picks, moves a shared actor and disposes cleanly', async () => {
    const selectedEntities: string[] = []
    const selectedObjects: string[] = []
    const callbacks: WorldRendererCallbacks = {
      onEntitySelect: (id) => selectedEntities.push(id),
      onObjectSelect: (id) => selectedObjects.push(id),
    }
    const locomotion = new WorldLocomotion()
    const fake = new FakeWebGLRenderer()
    renderers.push(fake)
    const renderer = new ThreeWorldRenderer(callbacks, {
      locomotion,
      shadows: false,
      createRenderer: () => fake as unknown as THREE.WebGLRenderer,
    })
    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 640 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 360 })
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    await renderer.mount(host, manifest(), snapshot())
    expect(host.querySelector('canvas')).toBe(fake.domElement)
    fake.animationLoop?.()
    expect(fake.lastScene?.children.length).toBeGreaterThanOrEqual(4)
    expect(fake.lastScene?.fog).toBeInstanceOf(THREE.Fog)
    expect(fake.lastScene?.children.some((child) => child.name === 'world-floor')).toBe(true)
    expect(fake.lastScene?.children.filter((child) => child.name.startsWith('world-wall:')).length).toBe(4)
    expect(fake.lastScene?.children.some((child) => child.name.startsWith('world-placement:'))).toBe(true)
    expect(renderer.actorRepresentation('employee-a')).toEqual({ vrmLoaded: false, vrmVisible: false, standInVisible: true, visibleRepresentationCount: 1 })
    const actorBeforeRoute = fake.lastScene?.children.find((child) => child.userData.entityId === 'employee-a')
    const actorBeforeRouteX = actorBeforeRoute?.position.x

    // The click path uses the renderer's own raycast and runtime ids. Stub only
    // the geometric intersection so this test remains deterministic in DOM CI.
    const raycast = vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects')
    raycast.mockReturnValueOnce([{ object: { userData: { entityId: 'employee-a' }, parent: null } }] as never)
    host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 12, clientY: 12 }))
    expect(selectedEntities).toEqual(['employee-a'])
    raycast.mockReturnValueOnce([{ object: { userData: { objectId: 'meeting-table' }, parent: null } }] as never)
    host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 12, clientY: 12 }))
    expect(selectedObjects).toEqual(['meeting-table'])

    // Camera modes are exercised on the mounted renderer, not just on the
    // pure pose helpers; each mode produces a real camera pose on the next draw.
    const camera = fake.lastCamera!
    renderer.setCameraMode('overview')
    fake.animationLoop?.()
    const overview = camera.position.clone()
    renderer.setCameraMode('focus', 'employee-a')
    fake.animationLoop?.()
    const focus = camera.position.clone()
    renderer.setCameraMode('follow', 'employee-a')
    fake.animationLoop?.()
    const follow = camera.position.clone()
    expect(focus.distanceTo(overview)).toBeGreaterThan(0)
    expect(follow.distanceTo(focus)).toBeGreaterThan(0)

    // An omitted subject is authoritative. It must not leave the previous
    // employee attached to a non-overview camera.
    renderer.setCameraMode('overview')
    fake.animationLoop?.()
    renderer.setCameraMode('focus', undefined)
    expect(renderer.cameraState()).toEqual({ mode: 'focus', subjectId: undefined })

    // A route is consumed by the same locomotion store that the other renderer
    // receives, and the mounted Three renderer reflects its live position.
    renderer.applyCues([{ id: 'route-1', kind: 'entity.route', entityId: 'employee-a', payload: { route: [{ x: 100, y: 100 }, { x: 700, y: 100 }] } } as never])
    locomotion.advance(1_000)
    fake.animationLoop?.()
    const actor = fake.lastScene?.children.find((child) => child.userData.entityId === 'employee-a')
    expect(actor?.position.x).not.toBe(actorBeforeRouteX)
    expect(renderer.actorRepresentation('employee-a')?.visibleRepresentationCount).toBeGreaterThanOrEqual(1)

    renderer.destroy()
    expect(fake.contextLost).toBe(true)
    expect(fake.disposed).toBe(true)
    expect(host.querySelector('canvas')).toBeNull()
    raycast.mockRestore()
  })

  it('swaps a VRM and its stand-in without ever leaving both hidden', async () => {
    const fakeRenderer = new FakeWebGLRenderer()
    renderers.push(fakeRenderer)
    const locomotion = new WorldLocomotion()
    const loadAvatar = vi.fn(async (_url: string, signal?: AbortSignal) => {
      if (signal?.aborted === true) throw new DOMException('cancelled', 'AbortError')
      return VrmActor.fromLoaded(fakeVrm() as never)
    })
    const renderer = new ThreeWorldRenderer({ onEntitySelect: () => {}, onObjectSelect: () => {} }, {
      locomotion,
      shadows: false,
      createRenderer: () => fakeRenderer as unknown as THREE.WebGLRenderer,
      resolveAvatarUrl: () => '/avatar.vrm',
      loadAvatar,
      motionLibrary: noMotionLibrary(),
    })
    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 640 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 360 })
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    await renderer.mount(host, manifest(), snapshot())
    fakeRenderer.animationLoop?.()
    await vi.waitFor(() => expect(loadAvatar).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(renderer.actorRepresentation('employee-a')?.vrmLoaded).toBe(true))

    // Overview makes the VRM yield to the billboard. Focusing the same actor
    // upgrades it back to the real mesh and hides the stand-in.
    expect(renderer.actorRepresentation('employee-a')).toMatchObject({ vrmVisible: false, standInVisible: true })
    renderer.selectEntity('employee-a')
    renderer.setCameraMode('focus', 'employee-a')
    fakeRenderer.animationLoop?.()
    expect(renderer.actorRepresentation('employee-a')).toMatchObject({ vrmVisible: true, standInVisible: false, visibleRepresentationCount: 1 })
    renderer.destroy()
  })

  it('mounts the real ThreeWorldRenderer through the lazy registry seam', async () => {
    const fake = new FakeWebGLRenderer()
    renderers.push(fake)
    const registry = createWorldRendererRegistry({ shadows: false, createRenderer: () => fake as unknown as THREE.WebGLRenderer })
    const renderer = registry.create('three-3d', { onEntitySelect: () => {}, onObjectSelect: () => {} })
    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 640 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 360 })
    await renderer.mount(host, manifest(), snapshot())
    fake.animationLoop?.()
    expect(renderer.kind).toBe('three-3d')
    expect(host.querySelector('canvas')).toBe(fake.domElement)
    expect(fake.lastScene?.children.some((child) => child.name === 'world-floor')).toBe(true)
    expect(fake.lastScene?.children.filter((child) => child.name.startsWith('world-wall:')).length).toBe(4)
    renderer.destroy()
  })
})

function manifest(): WorldThemeManifestV1 {
  return {
    schemaVersion: 1,
    id: 'theme-1',
    version: '1.0.0',
    templateId: 'cyber-company',
    displayName: '公司',
    renderer: 'three-3d',
    terminology: {},
    assets: [],
    actorSets: [],
    activityMapping: {},
    scenes: [{
      id: 'scene-1', displayName: '办公室', size: { width: 1792, height: 1120 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1120 }, safeArea: { x: 40, y: 40, width: 1712, height: 1040 }, layers: [],
      anchors: [{ id: 'desk-a', position: { x: 400, y: 400 }, facing: 'south', capacity: 1, tags: ['work'] }],
      navigation: { origin: { x: 0, y: 0 }, cellSize: 64, columns: 28, rows: 18, blocked: [] },
      interactables: [{ id: 'meeting-table', kind: 'meeting-table', displayName: '圆桌', bounds: { x: 1000, y: 500, width: 300, height: 180 }, approachAnchorIds: ['desk-a'], actions: [], zIndex: 1 }],
      growthSlots: [],
    }],
  }
}

function snapshot(): WorldRuntimeSnapshot {
  return {
    contractVersion: 1, workspaceId: 'workspace-1', worldId: 'world-1', templateId: 'cyber-company', themeId: 'theme-1', sceneId: 'scene-1',
    sequence: 1, generatedAt: '2026-08-28T00:00:00.000Z', clock: { now: '2026-08-28T00:00:00.000Z', timezone: 'Asia/Shanghai', lightsOn: true },
    entities: [{ id: 'employee-a', kind: 'agent', sceneId: 'scene-1', displayName: '小刘', position: { x: 400, y: 400 }, footOffset: { x: 0, y: 0 }, facing: 'south', activity: 'idle', activityLabel: '待命', route: [], visualState: {}, updatedAt: '2026-08-28T00:00:00.000Z' }],
    objects: [{ id: 'meeting-table', kind: 'meeting-table', displayName: '圆桌', state: 'idle', position: { x: 1000, y: 500 }, updatedAt: '2026-08-28T00:00:00.000Z' }],
    growthSlots: {},
  } as unknown as WorldRuntimeSnapshot
}

function fakeVrm() {
  const scene = new THREE.Group()
  const visibleMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, 0.2), new THREE.MeshBasicMaterial())
  scene.add(visibleMesh)
  const bones = new Map<string, THREE.Object3D>()
  for (const name of ['spine', 'leftUpperArm', 'rightUpperArm', 'head']) {
    const bone = new THREE.Object3D()
    scene.add(bone)
    bones.set(name, bone)
  }
  return {
    scene,
    humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name), getRawBoneNode: () => undefined },
    expressionManager: { setValue: () => {}, getValue: () => 0, expressions: [], getExpression: () => undefined },
    lookAt: { target: undefined, update: () => {} },
    update: () => {},
  }
}

function noMotionLibrary() {
  return {
    breathe: { gesture: 'breathe' as const, transitionMs: 320 },
    walk: { gesture: 'walk' as const, transitionMs: 220 },
    listen: { gesture: 'listen' as const, transitionMs: 280 },
    explain: { gesture: 'explain' as const, transitionMs: 250 },
    present: { gesture: 'present' as const, transitionMs: 280 },
    hold: { gesture: 'hold' as const, transitionMs: 220 },
    freeze: { gesture: 'freeze' as const, transitionMs: 180 },
  }
}
