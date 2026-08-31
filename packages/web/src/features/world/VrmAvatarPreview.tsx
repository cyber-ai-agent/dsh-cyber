import { useEffect, useRef, useState } from 'react'

import type { DigitalHumanVisualState } from './digital-human-motion.js'
import { disposeVrmScene } from './avatar/vrm/VrmResourceManager.js'

interface VrmAvatarPreviewProps {
  assetUrl: string
  label: string
  state?: DigitalHumanVisualState
  staticMode?: boolean
  className?: string
  allowGenericGlb?: boolean
  onFallback?(reason: string): void
}

export function VrmAvatarPreview({ assetUrl, label, state = 'idle', staticMode = false, className, allowGenericGlb = false, onFallback }: VrmAvatarPreviewProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef(state)
  const staticModeRef = useRef(staticMode)
  const onFallbackRef = useRef(onFallback)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { staticModeRef.current = staticMode }, [staticMode])
  useEffect(() => { onFallbackRef.current = onFallback }, [onFallback])

  useEffect(() => {
    const host = viewportRef.current
    if (host === null) return
    if (/HeadlessChrome/iu.test(navigator.userAgent)) {
      setStatus('failed')
      onFallbackRef.current?.('Headless 环境不创建 3D 预览上下文')
      return
    }
    let disposed = false
    let frame = 0
    let resizeObserver: ResizeObserver | undefined
    let cleanup: () => void = () => undefined
    setStatus('loading')

    void (async () => {
      try {
        const [THREE, loaderModule, vrmModule] = await Promise.all([
          import('three'),
          import('three/addons/loaders/GLTFLoader.js'),
          import('@pixiv/three-vrm'),
        ])
        if (disposed) return
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: !lowPowerDevice(), powerPreference: 'high-performance' })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPowerDevice() ? 1 : 1.5))
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.setClearColor(0x000000, 0)
        renderer.domElement.setAttribute('aria-label', label)
        renderer.domElement.setAttribute('role', 'img')
        host.replaceChildren(renderer.domElement)
        const disposeRenderer = () => {
          renderer.renderLists.dispose()
          renderer.dispose()
          renderer.forceContextLoss()
          renderer.domElement.remove()
        }
        cleanup = disposeRenderer

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
        scene.add(new THREE.HemisphereLight(0xfff3d5, 0x18202a, 2.2))
        const keyLight = new THREE.DirectionalLight(0xffd58a, 2.8)
        keyLight.position.set(2, 3, 3)
        scene.add(keyLight)
        const loader = new loaderModule.GLTFLoader()
        loader.register((parser) => new vrmModule.VRMLoaderPlugin(parser))
        const gltf = await loader.loadAsync(assetUrl)
        if (disposed) {
          disposeVrmScene(gltf.scene)
          disposeRenderer()
          cleanup = () => undefined
          return
        }
        const disposeAvatar = () => {
          disposeVrmScene(gltf.scene)
          disposeRenderer()
        }
        cleanup = disposeAvatar
        const vrm = gltf.userData.vrm as import('@pixiv/three-vrm').VRM | undefined
        if (vrm === undefined && !allowGenericGlb) throw new Error('文件未包含可渲染的 VRM 角色')
        if (vrm !== undefined) vrmModule.VRMUtils.rotateVRM0(vrm)
        const avatarScene = vrm?.scene ?? gltf.scene
        scene.add(avatarScene)
        frameAvatar(THREE, avatarScene, camera)

        const resize = () => {
          const width = Math.max(1, host.clientWidth)
          const height = Math.max(1, host.clientHeight)
          renderer.setSize(width, height, false)
          camera.aspect = width / height
          camera.updateProjectionMatrix()
        }
        resizeObserver = new ResizeObserver(resize)
        resizeObserver.observe(host)
        resize()
        cleanup = () => {
          resizeObserver?.disconnect()
          disposeAvatar()
        }
        const timer = new THREE.Timer()
        timer.connect(document)
        let lastRender = 0
        const render = (time: number) => {
          if (disposed) return
          frame = window.requestAnimationFrame(render)
          const interval = lowPowerDevice() ? 1000 / 15 : 1000 / 30
          if (document.hidden || time - lastRender < interval) return
          lastRender = time
          timer.update(time)
          const delta = Math.min(timer.getDelta(), 0.05)
          if (vrm !== undefined) {
            applyVrmMotion(vrm, stateRef.current, staticModeRef.current, time)
            vrm.update(delta)
          }
          renderer.render(scene, camera)
        }
        frame = window.requestAnimationFrame(render)
        cleanup = () => {
          window.cancelAnimationFrame(frame)
          resizeObserver?.disconnect()
          timer.dispose()
          disposeAvatar()
        }
        setStatus('ready')
      } catch (error) {
        cleanup()
        cleanup = () => undefined
        if (disposed) return
        const reason = error instanceof Error ? error.message : 'VRM 预览初始化失败'
        setStatus('failed')
        onFallbackRef.current?.(reason)
      }
    })()

    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      cleanup()
    }
  }, [allowGenericGlb, assetUrl, label])

  return <div className={`vrm-avatar-preview${className ? ` ${className}` : ''}`} data-status={status} aria-busy={status === 'loading'}>
    <div ref={viewportRef} className="vrm-avatar-preview__viewport" />
    {status === 'loading' ? <span role="status">正在载入 VRM 预览…</span> : null}
    {status === 'failed' ? <span role="status">VRM 无法渲染，已使用内置形象</span> : null}
  </div>
}

function lowPowerDevice(): boolean {
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number }
  return (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4)
    || (navigatorWithMemory.deviceMemory !== undefined && navigatorWithMemory.deviceMemory <= 4)
}

function frameAvatar(THREE: typeof import('three'), object: import('three').Object3D, camera: import('three').PerspectiveCamera): void {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const height = Math.max(size.y, 0.5)
  camera.position.set(center.x, center.y + height * 0.03, center.z + height * 2.2)
  camera.lookAt(center.x, center.y + height * 0.03, center.z)
}

function applyVrmMotion(vrm: import('@pixiv/three-vrm').VRM, state: DigitalHumanVisualState, staticMode: boolean, time: number): void {
  const manager = vrm.expressionManager
  if (manager !== null && manager !== undefined) {
    const speaking = !staticMode && state === 'speaking' ? 0.12 + Math.abs(Math.sin(time / 95)) * 0.7 : 0
    manager.setValue('aa', speaking)
    manager.setValue('relaxed', state === 'idle' ? 0.18 : 0)
    manager.setValue('surprised', state === 'approval' ? 0.24 : 0)
    manager.setValue('sad', state === 'failed' ? 0.22 : 0)
  }
  if (!staticMode) vrm.scene.position.y = Math.sin(time / 850) * 0.006
}
