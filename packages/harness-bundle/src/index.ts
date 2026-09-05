import type { Context } from '@deepseek-ai/cordis'
import {
  Config,
  HarnessSdkJsonRpcServer,
  type JsonRpcConfig,
} from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'

export { Config, type JsonRpcConfig }

export const name = 'dsh-cyber-sdk-jsonrpc'
export const inject = ['agents', 'approval']

interface NativeApprovalRequest extends Pick<ApprovalRequestEvent, 'toolName' | 'callId' | 'signal'> {
  agent: {
    session: Pick<Session, 'seq' | 'eventAt'>
  }
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
  const rootFiber = ctx.root.fiber
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const exit = config.exit ?? ((code: number) => process.exit(code))
  const transport = new JsonRpcLineTransport(input, output)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    ...(config.maxTokensAsSuccess === undefined ? {} : { maxTokensAsSuccess: config.maxTokensAsSuccess }),
  })
  const pending = new Map<string, PendingApproval>()
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
    const approvalRequestId = latestApprovalRequestId(request)
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

export function latestApprovalRequestId(request: NativeApprovalRequest): string | undefined {
  const session = request.agent.session
  const decided = new Set<string>()
  // rc.1 removed Session.events. Read backwards without copying the full log,
  // and never attach an approval to an earlier turn or a settled question.
  for (let index = Number(session.seq) - 1; index >= 0; index -= 1) {
    const event = session.eventAt(SessionSeq(index))
    if (event?.type === 'turn/start' || event?.type === 'turn/end') break
    if (event?.type === 'approval/decided') {
      decided.add(event.data.id)
      continue
    }
    if (event?.type !== 'approval/asked') continue
    if (event.data.toolName !== request.toolName) continue
    if (request.callId !== undefined && event.data.callId !== request.callId) continue
    const id = event.data.id
    if (typeof id !== 'string' || id.length === 0 || decided.has(id)) continue
    return id
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
