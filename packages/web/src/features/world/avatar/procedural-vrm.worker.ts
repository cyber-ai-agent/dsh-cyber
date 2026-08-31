import { createProceduralVrm, type ProceduralAvatarDesign } from './procedural-vrm.js'

interface WorkerRequest {
  requestId: string
  displayName: string
  design: ProceduralAvatarDesign
}

type WorkerResponse =
  | { requestId: string; ok: true; buffer: ArrayBuffer }
  | { requestId: string; ok: false; error: string }

interface AvatarWorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
}

const scope = self as unknown as AvatarWorkerScope

scope.onmessage = (event) => {
  const { requestId, displayName, design } = event.data
  try {
    const buffer = createProceduralVrm(displayName, design)
    scope.postMessage({ requestId, ok: true, buffer }, [buffer])
  } catch (cause) {
    scope.postMessage({
      requestId,
      ok: false,
      error: cause instanceof Error ? cause.message : '3D 形象生成失败',
    })
  }
}
