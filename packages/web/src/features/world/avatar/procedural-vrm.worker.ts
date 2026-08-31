import type { AvatarRecipe } from './avatar-recipe.js'
import { createIdentityProceduralVrm, createProceduralVrm, type ProceduralAvatarDesign } from './procedural-vrm.js'

interface WorkerRequest {
  requestId: string
  displayName: string
  design: ProceduralAvatarDesign
  identityRecipe?: AvatarRecipe
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
  const { requestId, displayName, design, identityRecipe } = event.data
  try {
    const buffer = identityRecipe === undefined
      ? createProceduralVrm(displayName, design)
      : createIdentityProceduralVrm(displayName, identityRecipe, design)
    scope.postMessage({ requestId, ok: true, buffer }, [buffer])
  } catch (cause) {
    scope.postMessage({
      requestId,
      ok: false,
      error: cause instanceof Error ? cause.message : '3D 形象生成失败',
    })
  }
}
