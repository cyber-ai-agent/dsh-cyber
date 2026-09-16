import { WorldDirectoryTools } from './world-directory-tools.js'
import type { Context } from '@deepseek-ai/cordis'
import {
  Config,
  HarnessSdkJsonRpcServer,
  type JsonRpcConfig,
} from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'

import { registerFirecrawlWebSearch } from './web-search-firecrawl.js'
import { registerCredentialRedaction } from './credential-redaction.js'

export { Config, type JsonRpcConfig }

export const name = 'dsh-cyber-sdk-jsonrpc'
export const inject = ['agents', 'approval', 'tools', 'web', 'shellEnv']

interface NativeApprovalRequest extends Pick<ApprovalRequestEvent, 'toolName' | 'callId' | 'signal'> {
  agent: {
    session: Session
  }
}

export interface PendingApprovalQuestion {
  id: string
  toolName: string
  callId?: string
}

interface PendingApproval {
  settle: (outcome: ApprovalOutcome) => void
  disposeAbort?: () => void
}

/**
 * Extend the official SDK server with the missing answer path for DSH's
 * same-turn approval seam. The question itself already travels through the
 * durable `approval/asked` session event, so the bridge only accepts a
 * one-shot decision for that exact event id.
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  // The 连接中心「联网搜索」Firecrawl backend. Dormant unless the host injects
  // the loopback coordinates; the DSH `web` seam selects it via `searchProvider`.
  registerFirecrawlWebSearch(ctx)
  registerCredentialRedaction(ctx)
  registerEagerToolResultPruning(ctx)
  const approvalQuestions = registerApprovalQuestionTracking(ctx)
  const rootFiber = ctx.root.fiber
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const exit = config.exit ?? ((code: number) => process.exit(code))
  const transport = new JsonRpcLineTransport(input, output)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    ...(config.maxTokensAsSuccess === undefined ? {} : { maxTokensAsSuccess: config.maxTokensAsSuccess }),
  })
  const pending = new Map<string, PendingApproval>()
  const directory = new WorldDirectoryTools(ctx)
  let exitTask: Promise<void> | undefined

  const settleAll = (outcome: ApprovalOutcome) => {
    for (const item of pending.values()) item.settle(outcome)
    pending.clear()
  }
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      settleAll('unavailable')
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  ctx.on('approval/request', async (request) => {
    if (request.signal?.aborted) return 'cancelled'
    const approvalRequestId = latestApprovalRequestId(
      request,
      approvalQuestions.get(request.agent.session) ?? [],
    )
    if (approvalRequestId === undefined || pending.has(approvalRequestId)) return 'unavailable'
    return await new Promise<ApprovalOutcome>((resolvePromise) => {
      let settled = false
      const settle = (outcome: ApprovalOutcome) => {
        if (settled) return
        settled = true
        const item = pending.get(approvalRequestId)
        item?.disposeAbort?.()
        pending.delete(approvalRequestId)
        resolvePromise(outcome)
      }
      const onAbort = () => settle('cancelled')
      if (request.signal !== undefined) request.signal.addEventListener('abort', onAbort, { once: true })
      pending.set(approvalRequestId, {
        settle,
        ...(request.signal === undefined ? {} : {
          disposeAbort: () => request.signal?.removeEventListener('abort', onAbort),
        }),
      })
    })
  }, { global: true })

  transport.onRequest(async (method, params) => {
    if (method === 'initialize') await ctx.get('loader')?.await()
    if (method === 'world-directory/set') return directory.update(params)
    if (method === 'approval/decide') return decideApproval(pending, params)
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') setImmediate(() => { void disposeAndExit() })
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      settleAll('unavailable')
      await server.shutdown()
      transport.close()
    }
  }, 'jsonrpc.serve')
}

/**
 * Give the installed pruner an early pass at every step boundary that received
 * tool output. This keeps one oversized result from reaching another model
 * request while preserving the package's durable shadow-price replacement.
 */
function registerEagerToolResultPruning(ctx: Context): void {
  const dirty = new WeakSet<Session>()
  ctx.on('session/created', (session) => { dirty.add(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/result') dirty.add(session)
  }, { global: true })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!signal.aborted && dirty.has(agent.session)) {
      const pruner = ctx.get('toolResultPruner') as ToolResultPruner | undefined
      if (pruner !== undefined) {
        try {
          pruner.pruneSession(agent.session)
          dirty.delete(agent.session)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`early tool-result pruning failed: ${message}`)
        }
      }
    }
    return next()
  })
}

function registerApprovalQuestionTracking(ctx: Context): WeakMap<Session, PendingApprovalQuestion[]> {
  const questions = new WeakMap<Session, PendingApprovalQuestion[]>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      questions.delete(session)
      return
    }
    if (event.type === 'approval/asked') {
      const current = questions.get(session) ?? []
      current.push({
        id: event.data.id,
        toolName: event.data.toolName,
        ...(event.data.callId === undefined ? {} : { callId: event.data.callId }),
      })
      questions.set(session, current)
      return
    }
    if (event.type === 'approval/decided') {
      const current = questions.get(session)
      if (current === undefined) return
      const remaining = current.filter((question) => question.id !== event.data.id)
      if (remaining.length === 0) questions.delete(session)
      else questions.set(session, remaining)
    }
  }, { global: true })
  return questions
}

export function latestApprovalRequestId(
  request: Pick<NativeApprovalRequest, 'toolName' | 'callId'>,
  questions: readonly PendingApprovalQuestion[],
): string | undefined {
  for (let index = questions.length - 1; index >= 0; index -= 1) {
    const question = questions[index]!
    if (question.toolName !== request.toolName) continue
    if (request.callId !== undefined && question.callId !== request.callId) continue
    if (question.id.length > 0) return question.id
  }
  return undefined
}

function decideApproval(
  pending: Map<string, PendingApproval>,
  params: Record<string, unknown> | undefined,
): { accepted: true } {
  const approvalRequestId = params?.approvalRequestId
  const outcome = params?.outcome
  if (typeof approvalRequestId !== 'string' || approvalRequestId.length === 0) {
    throw new TypeError('approvalRequestId is required')
  }
  if (outcome !== 'allowed-once' && outcome !== 'rejected') {
    throw new TypeError('approval outcome must be allowed-once or rejected')
  }
  const item = pending.get(approvalRequestId)
  if (item === undefined) throw new Error('approval request is no longer active')
  item.settle(outcome)
  return { accepted: true }
}
