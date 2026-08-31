import { useEffect, useRef, useState } from 'react'

import type { DigitalHumanRendererProps } from '../renderer/DigitalHumanRenderer.js'
import { VrmAnimationController } from './VrmAnimationController.js'
import { VrmBlinkController } from './VrmBlinkController.js'
import { VrmExpressionController } from './VrmExpressionController.js'
import { VrmLookAtController } from './VrmLookAtController.js'
import { VrmMotionController } from './VrmMotionController.js'
import { VrmPerformanceController } from './VrmPerformanceController.js'
import { disposeVrmScene } from './VrmResourceManager.js'
import { VrmSpeechController } from './VrmSpeechController.js'

export function VrmRuntimeRenderer(props: DigitalHumanRendererProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const latestRef = useRef(props)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => { latestRef.current = props }, [props])

  useEffect(() => {
    const host = viewportRef.current
    const assetUrl = props.employee.avatarAssetUrl
    if (host === null || assetUrl === undefined) { props.onFallback('VRM 资产地址缺失'); return }
    let disposed = false
    let frame = 0
    let resizeObserver: ResizeObserver | undefined
    let cleanup: () => void = () => undefined
    setStatus('loading')

    void (async () => {
      try {
        const [THREE, loaderModule, vrmModule] = await Promise.all([
          import('three'), import('three/addons/loaders/GLTFLoader.js'), import('@pixiv/three-vrm'), import('@pixiv/three-vrm-animation'),
        ])
        if (disposed) return
        const current = latestRef.current
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: current.quality === 'high', powerPreference: current.quality === 'low' ? 'low-power' : 'high-performance' })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, current.quality === 'high' ? 1.5 : current.quality === 'balanced' ? 1.25 : 1))
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.setClearColor(0x000000, 0)
        renderer.domElement.setAttribute('aria-label', `${current.employee.displayName} VRM 数字人`)
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
        const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100)
        scene.add(new THREE.HemisphereLight(0xffefd2, 0x101820, current.quality === 'low' ? 1.6 : 2.2))
        const keyLight = new THREE.DirectionalLight(0xffcf78, current.quality === 'low' ? 1.8 : 2.7)
        keyLight.position.set(2, 3, 3)
        scene.add(keyLight)
        const rimLight = new THREE.DirectionalLight(0x88bfff, current.quality === 'high' ? 1.2 : 0.7)
        rimLight.position.set(-2, 1.5, -1)
        scene.add(rimLight)

        const loader = new loaderModule.GLTFLoader()
        loader.register((parser) => new vrmModule.VRMLoaderPlugin(parser))
        const gltf = await loader.loadAsync(assetUrl)
        if (disposed) { disposeVrmScene(gltf.scene); disposeRenderer(); cleanup = () => undefined; return }
        const vrm = gltf.userData.vrm as import('@pixiv/three-vrm').VRM | undefined
        if (vrm === undefined) throw new Error('已发布文件不包含 VRM 1.0 角色')
        vrmModule.VRMUtils.rotateVRM0(vrm)
        scene.add(vrm.scene)
        frameAvatar(THREE, vrm.scene, camera)

        const motion = new VrmMotionController(vrm)
        const expression = new VrmExpressionController(vrm)
        const lookAt = new VrmLookAtController(vrm)
        const blink = new VrmBlinkController(vrm)
        const speech = new VrmSpeechController(vrm)
        const animation = new VrmAnimationController(vrm.scene)
        const performanceController = new VrmPerformanceController(current.quality)
        const timer = new THREE.Timer()
        timer.connect(document)
        let lastRender = 0
        let lowQualitySpringFrame = 0

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

        const render = (time: number) => {
          if (disposed) return
          frame = window.requestAnimationFrame(render)
          if (document.visibilityState !== 'visible' || time - lastRender < performanceController.targetInterval()) return
          lastRender = time
          timer.update(time)
          const delta = Math.min(timer.getDelta(), 0.05)
          const latest = latestRef.current
          const enabled = !latest.staticMode && latest.state !== 'failed'
          motion.setGesture(latest.motionCue.gesture)
          motion.update(time, delta, enabled)
          animation.setGesture(latest.motionCue.gesture)
          animation.update(delta)
          expression.update(latest.motionCue.expression, delta)
          lookAt.update(latest.state, time, delta, enabled)
          blink.update(time, enabled)
          speech.update(time, latest.speaking)
          if (latest.quality !== 'low' || (lowQualitySpringFrame++ % 2 === 0)) vrm.update(delta)
          renderer.render(scene, camera)
          performanceController.recordFrame(time, (fps) => latest.onFallback(`VRM 持续帧率过低（${Math.round(fps)} FPS），已自动降级`))
        }
        frame = window.requestAnimationFrame(render)
        cleanup = () => {
          window.cancelAnimationFrame(frame)
          resizeObserver?.disconnect()
          timer.dispose()
          animation.dispose()
          expression.dispose()
          disposeVrmScene(vrm.scene)
          disposeRenderer()
        }
        setStatus('ready')
        latestRef.current.onReady()
      } catch (error) {
        cleanup()
        cleanup = () => undefined
        if (disposed) return
        setStatus('failed')
        latestRef.current.onFallback(error instanceof Error ? error.message : 'VRM Runtime 初始化失败')
      }
    })()

    return () => { disposed = true; window.cancelAnimationFrame(frame); resizeObserver?.disconnect(); cleanup() }
  }, [props.employee.avatarAssetUrl])

  return <div className="focus-avatar focus-avatar--vrm" data-status={status} aria-busy={status === 'loading'}>
    <div ref={viewportRef} className="focus-avatar__vrm-viewport" />
    {status === 'loading' ? <span className="focus-avatar__loading" role="status">正在进入 3D Focus…</span> : null}
  </div>
}

function frameAvatar(THREE: typeof import('three'), object: import('three').Object3D, camera: import('three').PerspectiveCamera): void {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const height = Math.max(size.y, 0.5)
  camera.position.set(center.x, center.y + height * 0.02, center.z + height * 2.15)
  camera.lookAt(center.x, center.y + height * 0.02, center.z)
}
