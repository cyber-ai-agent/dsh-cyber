import { useEffect, useState } from 'react'
import type { ConversationModelReadiness } from '@dsh-cyber/contracts'
import { readConversationModelReadiness } from './readiness.js'

/** Key every result to its exact conversation/model, including during render before effects run. */
export function useModelReadiness(input: { worldId: string | undefined; employeeIds: readonly string[]; modelProfileId: string | undefined; revision: unknown; enabled: boolean }) {
  const key = JSON.stringify([input.worldId, input.employeeIds, input.modelProfileId])
  const [result, setResult] = useState<{ key: string; readiness?: ConversationModelReadiness; failed?: boolean }>()
  useEffect(() => {
    const [worldId, employeeIds, modelProfileId] = JSON.parse(key) as [string | null, string[], string | null]
    if (!input.enabled || worldId === null || employeeIds.length === 0) return
    const controller = new AbortController()
    setResult({ key })
    void readConversationModelReadiness(worldId, employeeIds, modelProfileId ?? undefined, controller.signal).then(
      (readiness) => { if (!controller.signal.aborted) setResult({ key, readiness }) },
      () => { if (!controller.signal.aborted) setResult({ key, failed: true }) },
    )
    return () => controller.abort()
  }, [key, input.enabled, input.revision])
  return input.enabled && result?.key === key ? result : undefined
}
