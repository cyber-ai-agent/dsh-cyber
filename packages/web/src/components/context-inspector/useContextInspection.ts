import { useCallback, useEffect, useRef, useState } from 'react'

import type { ContextInspection, ContextInspectionResponse } from '@dsh-cyber/contracts'

import { api } from '../../api.js'

export interface UseContextInspectionResult {
  inspection?: ContextInspection
  loading: boolean
  error?: string
  refresh(): Promise<void>
}

/**
 * Reads back the context structure the conversation's last turn was given.
 *
 * An empty answer is a normal answer: the record lives with the running server
 * and a conversation that has not run a turn yet simply has nothing to show.
 * The hook keeps that distinct from a failed request so the panel can say
 * which one happened instead of blaming the user for an error.
 */
export function useContextInspection(
  conversationId: string | undefined,
  demoMode: boolean,
): UseContextInspectionResult {
  const [inspection, setInspection] = useState<ContextInspection>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    if (conversationId === undefined || demoMode) {
      setInspection(undefined)
      setError(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const result = await api<ContextInspectionResponse>(
        `/api/sessions/${encodeURIComponent(conversationId)}/context-inspection`,
      )
      if (current !== generation.current) return
      setInspection(result.inspection)
    } catch (cause) {
      if (current !== generation.current) return
      setInspection(undefined)
      setError(cause instanceof Error ? cause.message : '上下文读取失败')
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [conversationId, demoMode])

  useEffect(() => { void refresh() }, [refresh])

  return {
    ...(inspection === undefined ? {} : { inspection }),
    loading,
    ...(error === undefined ? {} : { error }),
    refresh,
  }
}
