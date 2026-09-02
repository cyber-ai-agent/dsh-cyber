import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentRunContextInspectionResponse,
  ContextInspection,
  ContextInspectionResponse,
  ContextSnapshotSummary,
} from '@dsh-cyber/contracts'

import { api } from '../../api.js'

export interface UseContextInspectionResult {
  inspection?: ContextInspection
  /**
   * The durable snapshot's numbers for the focused run, when the run has one.
   * Only set in run mode; a conversation's latest turn is answered by
   * `inspection` alone.
   */
  snapshot?: ContextSnapshotSummary
  loading: boolean
  error?: string
  refresh(): Promise<void>
}

/**
 * Reads back the context structure a turn was given.
 *
 * Two addresses. A conversation answers with its last turn's record. A run
 * (the trace card's 上下文 link) answers with that run's own record while the
 * server still holds it, plus the durable snapshot's numbers for as long as
 * the run exists — so an older run can still say how large each layer was
 * after the process-local record is gone.
 *
 * An empty answer is a normal answer: the record lives with the running server
 * and a conversation that has not run a turn yet simply has nothing to show.
 * The hook keeps that distinct from a failed request so the panel can say
 * which one happened instead of blaming the user for an error.
 */
export function useContextInspection(
  conversationId: string | undefined,
  demoMode: boolean,
  agentRunId?: string,
): UseContextInspectionResult {
  const [inspection, setInspection] = useState<ContextInspection>()
  const [snapshot, setSnapshot] = useState<ContextSnapshotSummary>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    if ((conversationId === undefined && agentRunId === undefined) || demoMode) {
      setInspection(undefined)
      setSnapshot(undefined)
      setError(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      if (agentRunId !== undefined) {
        const result = await api<AgentRunContextInspectionResponse>(
          `/api/agent-runs/${encodeURIComponent(agentRunId)}/context-inspection`,
        )
        if (current !== generation.current) return
        setInspection(result.inspection)
        setSnapshot(result.snapshot)
      } else {
        const result = await api<ContextInspectionResponse>(
          `/api/sessions/${encodeURIComponent(conversationId!)}/context-inspection`,
        )
        if (current !== generation.current) return
        setInspection(result.inspection)
        setSnapshot(undefined)
      }
    } catch (cause) {
      if (current !== generation.current) return
      setInspection(undefined)
      setSnapshot(undefined)
      setError(cause instanceof Error ? cause.message : '上下文读取失败')
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [agentRunId, conversationId, demoMode])

  useEffect(() => { void refresh() }, [refresh])

  return {
    ...(inspection === undefined ? {} : { inspection }),
    ...(snapshot === undefined ? {} : { snapshot }),
    loading,
    ...(error === undefined ? {} : { error }),
    refresh,
  }
}
