import type { ProceduralAvatarDesign } from './procedural-vrm.js'

export type AvatarCreationPhase = 'generating' | 'packaging' | 'validating'

export interface AvatarCreationRequest {
  displayName: string
  design: ProceduralAvatarDesign
}

export interface CreatedAvatarFile {
  file: File
  providerId: string
  source: 'local'
}

export interface AvatarCreationContext {
  onPhase?: (phase: AvatarCreationPhase) => void
  signal?: AbortSignal
}

export interface CharacterAvatarCreationProvider {
  id: string
  displayName: string
  description: string
  source: 'local' | 'remote'
  create(request: AvatarCreationRequest, context?: AvatarCreationContext): Promise<CreatedAvatarFile>
}

interface WorkerRequest {
  requestId: string
  displayName: string
  design: ProceduralAvatarDesign
}

type WorkerResponse =
  | { requestId: string; ok: true; buffer: ArrayBuffer }
  | { requestId: string; ok: false; error: string }

export const LOCAL_PROCEDURAL_AVATAR_PROVIDER_ID = 'dsh.local-procedural-vrm-v1'

export class CharacterAvatarCreationProviderRegistry {
  readonly #providers = new Map<string, CharacterAvatarCreationProvider>()

  register(provider: CharacterAvatarCreationProvider): void {
    if (this.#providers.has(provider.id)) throw new Error(`3D 形象创建 Provider 重复注册：${provider.id}`)
    this.#providers.set(provider.id, provider)
  }

  require(providerId: string): CharacterAvatarCreationProvider {
    const provider = this.#providers.get(providerId)
    if (provider === undefined) throw new Error(`3D 形象创建 Provider 不存在：${providerId}`)
    return provider
  }

  list(): CharacterAvatarCreationProvider[] {
    return [...this.#providers.values()]
  }
}

export const localProceduralAvatarProvider: CharacterAvatarCreationProvider = {
  id: LOCAL_PROCEDURAL_AVATAR_PROVIDER_ID,
  displayName: '本机 3D 草稿',
  description: '在设备上生成低面数、自包含的 VRM 1.0 草稿，不发送角色资料。实时世界会优先保留角色原有 2D 身份，直到发布匹配的正式 3D 形象。',
  source: 'local',
  async create(request, context = {}) {
    throwIfAborted(context.signal)
    context.onPhase?.('generating')
    const buffer = await generateVrm(request, context.signal)
    throwIfAborted(context.signal)
    context.onPhase?.('packaging')
    const safeName = request.displayName.trim().replace(/[\\/:*?"<>|]+/gu, '-').slice(0, 80) || '本地角色'
    return {
      file: new File([buffer], `${safeName}-本机创建.vrm`, { type: 'model/gltf-binary' }),
      providerId: LOCAL_PROCEDURAL_AVATAR_PROVIDER_ID,
      source: 'local',
    }
  },
}

export const avatarCreationProviders = new CharacterAvatarCreationProviderRegistry()
avatarCreationProviders.register(localProceduralAvatarProvider)

async function generateVrm(request: AvatarCreationRequest, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (typeof Worker === 'undefined') {
    const { createProceduralVrm } = await import('./procedural-vrm.js')
    throwIfAborted(signal)
    return createProceduralVrm(request.displayName, request.design)
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const worker = new Worker(new URL('./procedural-vrm.worker.ts', import.meta.url), { type: 'module', name: 'dsh-avatar-creator' })
    const requestId = crypto.randomUUID()
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const finish = (): boolean => {
      if (settled) return false
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener)
      worker.terminate()
      return true
    }
    const fail = (error: Error) => {
      if (!finish()) return
      reject(error)
    }
    abortListener = () => fail(abortError())
    signal?.addEventListener('abort', abortListener, { once: true })
    timeout = setTimeout(() => fail(new Error('3D 形象生成超时，请重试')), 20_000)
    worker.onerror = (event) => {
      event.preventDefault()
      fail(new Error('3D 形象生成器启动失败'))
    }
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.requestId !== requestId) return
      if (!finish()) return
      if (event.data.ok) resolve(event.data.buffer)
      else reject(new Error(event.data.error))
    }
    const message: WorkerRequest = { requestId, displayName: request.displayName, design: request.design }
    worker.postMessage(message)
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

function abortError(): DOMException {
  return new DOMException('已取消 3D 形象创建', 'AbortError')
}
