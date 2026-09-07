import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  AgentTurnResult,
} from '@dsh-cyber/contracts'

import {
  HarnessCompatibilityAdapter,
  type HarnessAdapterOptions,
} from './adapter.js'

export interface HarnessModelRoute {
  id: string
  displayName: string
  api: string
  baseURL: string
  modelId: string
  apiKeyEnv?: string
  webSearch?: {
    baseURL: string
    apiKeyEnv: string
  }
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: false | Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  compat?: { thinkingFormat?: string; supportsReasoningEffort?: boolean }
}

/**
 * Drop a requested reasoning effort the routed model does not declare.
 *
 * Worlds persist one effort knob while model profiles differ in what they can
 * serve; when the routed profile declares its levels explicitly (or declares a
 * non-reasoning model), an unsupported request must degrade to "no explicit
 * effort" instead of failing the whole turn inside the worker. Profiles without
 * a declaration keep the request untouched — their capability lives in the
 * installed catalog and cannot be judged here.
 */
export function withoutUnsupportedReasoningEffort(
  request: AgentTurnRequest,
  route: HarnessModelRoute | undefined,
): AgentTurnRequest {
  const effort = request.reasoningEffort
  if (effort === undefined || route?.reasoningEfforts === undefined) return request
  const declared = route.reasoningEfforts
  if (declared !== false && Object.hasOwn(declared, effort)) return request
  const { reasoningEffort: _dropped, ...rest } = request
  return rest
}

export interface HarnessModelRouterOptions {
  stateRoot: string
  resolveRoute(request: AgentTurnRequest): HarnessModelRoute | undefined
  adapterFactory?: (options: HarnessAdapterOptions) => AgentRuntimePort
  inheritedEnvironment?: NodeJS.ProcessEnv
  dshBinPath?: string
}

interface AdapterEntry {
  routeId: string
  fingerprint: string
  adapter: AgentRuntimePort
  leases: number
  retired: boolean
  closePromise?: Promise<void>
}

interface AdapterLease {
  entry: AdapterEntry
  release(): void
}

interface AttemptObservation {
  terminalFailure?: AgentRuntimeEvent
  unsafeToRetry: boolean
}

/**
 * Routes every character turn through its selected model profile.
 *
 * A Harness worker is long-lived per character. If a worker/channel/provider
 * connection dies between turns, a perfectly valid model configuration can
 * otherwise keep failing until the process is restarted. To make that failure
 * mode self-healing, this router performs at most one retry after resetting the
 * affected character runtime when the first attempt fails with a transient
 * transport/upstream signal and no assistant output or tool call was emitted.
 * Authentication, model selection, quota/rate-limit and other explicit 4xx
 * failures are never retried.
 */
export class HarnessModelRouter implements AgentRuntimePort, AsyncDisposable {
  readonly #options: HarnessModelRouterOptions
  /** The current generation for each route id. Retired generations remain in #allEntries. */
  readonly #currentEntries = new Map<string, AdapterEntry>()
  /** Every generation created by this router, including retired generations. */
  readonly #allEntries = new Set<AdapterEntry>()
  readonly #runEntries = new Map<string, AdapterEntry>()
  readonly #abortedRuns = new Set<string>()
  #closed = false
  #closePromise: Promise<void> | undefined

  constructor(options: HarnessModelRouterOptions) {
    this.#options = options
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (this.#closed) throw new Error('Harness model router closed')
    const route = this.#options.resolveRoute(request)
    const routeId = route?.id ?? '__dsh-default__'
    const fingerprint = routeFingerprint(route)
    // Entry acquisition and lease binding intentionally happen synchronously.
    // There must be no await between selecting a generation and registering the
    // run: a concurrent route update may retire the generation, but it must not
    // close it while this turn is still about to start.
    const lease = this.#acquireLease(routeId, route, fingerprint)
    const entry = lease.entry
    if (request.agentRunId !== undefined && this.#abortedRuns.has(request.agentRunId)) {
      lease.release()
      throw new Error('Agent run aborted')
    }
    if (request.agentRunId !== undefined) this.#runEntries.set(request.agentRunId, entry)

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (this.#isAborted(request)) throw new Error('Agent run aborted')
        const observation: AttemptObservation = { unsafeToRetry: false }
        // Re-normalize the request and rebuild the event boundary for every
        // attempt. The retry must carry the same provider-safe request shape,
        // and its events must remain visible to the router for retry safety and
        // approval routing.
        const turnRequest = withoutUnsupportedReasoningEffort(request, route)
        const observedRequest: AgentTurnRequest = {
          ...turnRequest,
          onEvent: (event) => {
            if (event.kind === 'turn.failed') {
              observation.terminalFailure = event
              return
            }
            if (
              event.kind === 'assistant.message'
              || event.kind === 'text.delta'
              || event.kind === 'tool.started'
              || event.kind === 'tool.completed'
              || event.kind === 'approval.requested'
            ) {
              observation.unsafeToRetry = true
            }
            request.onEvent?.(event)
          },
        }

        let result: AgentTurnResult | undefined
        let thrown = false
        let error: unknown
        try {
          result = await entry.adapter.runTurn(observedRequest)
        } catch (caught) {
          thrown = true
          error = caught
        }

        if (this.#isAborted(request)) {
          // Preserve the provider's cancellation error when the adapter was
          // able to interrupt the underlying run. A successful late result is
          // rejected locally so cancellation can never enter the retry path.
          if (thrown) throw error
          throw new Error('Agent run aborted')
        }
        const failureSignal = observation.terminalFailure?.metadata ?? (thrown ? error : undefined)
        const canRetry = attempt === 0
          && !observation.unsafeToRetry
          && entry.adapter.resetSession !== undefined
          && request.conversationId.trim().length > 0
          && isTransientRuntimeFailure(failureSignal)

        if (canRetry) {
          try {
            await this.#resetFailedRun(entry, request)
          } catch (resetError) {
            // The original transient failure is otherwise hidden while the
            // router was deciding whether it could safely retry. If reset
            // itself fails, surface that original terminal fact once before
            // returning the reset error.
            if (observation.terminalFailure !== undefined) request.onEvent?.(observation.terminalFailure)
            throw resetError
          }
          if (this.#isAborted(request)) throw new Error('Agent run aborted')
          // A turn remains pinned to the generation it acquired before its
          // first await. Route updates affect later turns; they must not swap
          // the adapter underneath this retry while the old generation drains.
          continue
        }

        if (observation.terminalFailure !== undefined) request.onEvent?.(observation.terminalFailure)
        if (thrown) throw error
        return result!
      }
      throw new Error('Harness model router exhausted retry attempts')
    } finally {
      lease.release()
      if (request.agentRunId !== undefined) {
        if (this.#runEntries.get(request.agentRunId) === entry) this.#runEntries.delete(request.agentRunId)
        this.#abortedRuns.delete(request.agentRunId)
      }
    }
  }

  async abortRun(agentRunId: string): Promise<void> {
    this.#abortedRuns.add(agentRunId)
    const entry = this.#runEntries.get(agentRunId)
    if (entry !== undefined) {
      await entry.adapter.abortRun?.(agentRunId)
      return
    }
    // A queued/just-starting run may not have reached the adapter map yet.
    // Keep the tombstone so a late runTurn cannot start it after Stop.
    await Promise.all([...this.#allEntries].map((item) => item.adapter.abortRun?.(agentRunId)))
  }

  async decideApproval(agentRunId: string, approvalRequestId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const entry = this.#runEntries.get(agentRunId)
    if (entry?.adapter.decideApproval === undefined) throw new Error('审批对应的运行回合已经结束')
    await entry.adapter.decideApproval(agentRunId, approvalRequestId, decision)
  }

  async closeAgent(agentId: string): Promise<void> {
    await Promise.all(
      [...this.#allEntries]
        .filter((entry) => !entry.retired || entry.leases > 0)
        .map((entry) => entry.adapter.closeAgent?.(agentId)),
    )
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#runEntries.clear()
    this.#abortedRuns.clear()
    for (const [routeId, entry] of this.#currentEntries) {
      this.#currentEntries.delete(routeId)
      this.#retireEntry(entry)
    }
    const entries = [...this.#allEntries]
    this.#closePromise = (async () => {
      const results = await Promise.allSettled(entries.map((entry) => this.#closeEntry(entry, true)))
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          `Failed to close ${failures.length} routed Harness runtime(s)`,
        )
      }
    })()
    return this.#closePromise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  #isAborted(request: AgentTurnRequest): boolean {
    return this.#closed || (request.agentRunId !== undefined && this.#abortedRuns.has(request.agentRunId))
  }

  async #resetFailedRun(entry: AdapterEntry, request: AgentTurnRequest): Promise<void> {
    // Only the conversation-scoped reset is a valid retry boundary. Aborting a
    // run or closing an employee can either be a no-op after a terminal event
    // or tear down unrelated conversation lanes.
    if (entry.adapter.resetSession === undefined) throw new Error('Harness adapter cannot reset a conversation session')
    await entry.adapter.resetSession(request.agent.id, request.conversationId)
  }

  #acquireLease(
    routeId: string,
    route: HarnessModelRoute | undefined,
    fingerprint: string,
  ): AdapterLease {
    if (this.#closed) throw new Error('Harness model router closed')
    const current = this.#currentEntries.get(routeId)
    if (current !== undefined && current.fingerprint === fingerprint && !current.retired) {
      return this.#lease(current)
    }

    if (current !== undefined) {
      this.#currentEntries.delete(routeId)
      this.#retireEntry(current)
    }

    // The factory is deliberately called before publishing the new entry. A
    // transient factory failure therefore leaves no poisoned cache entry, so a
    // later turn can retry creation.
    const entry: AdapterEntry = {
      routeId,
      fingerprint,
      adapter: this.#createAdapter(route, fingerprint),
      leases: 0,
      retired: false,
    }
    this.#currentEntries.set(routeId, entry)
    this.#allEntries.add(entry)
    return this.#lease(entry)
  }

  #lease(entry: AdapterEntry): AdapterLease {
    entry.leases += 1
    let released = false
    return {
      entry,
      release: () => {
        if (released) return
        released = true
        entry.leases = Math.max(0, entry.leases - 1)
        if (entry.leases === 0 && (entry.retired || this.#closed)) this.#closeEntry(entry)
      },
    }
  }

  #retireEntry(entry: AdapterEntry): void {
    if (entry.retired) return
    entry.retired = true
    if (entry.leases === 0) this.#closeEntry(entry)
  }

  #closeEntry(entry: AdapterEntry, force = false): Promise<void> {
    if (entry.closePromise !== undefined) return entry.closePromise
    if (!force && entry.leases > 0) return Promise.resolve()
    entry.closePromise = Promise.resolve()
      .then(() => entry.adapter.close())
      .then(() => {
        // Successful retired generations no longer need to stay in the
        // registry. Failed closes remain recorded so close() can report the
        // evidence and never invoke the same adapter twice.
        this.#allEntries.delete(entry)
      })
    // Retired generations are closed in the background. Router.close() still
    // awaits the same promise and reports any close failure to its caller.
    void entry.closePromise.catch(() => undefined)
    return entry.closePromise
  }

  #createAdapter(route: HarnessModelRoute | undefined, fingerprint: string): AgentRuntimePort {
    const options: HarnessAdapterOptions = {
      stateRoot: join(
        resolve(this.#options.stateRoot),
        'providers',
        route === undefined ? 'dsh-default' : safeRouteDirectory(route.id, fingerprint),
      ),
      ...(this.#options.inheritedEnvironment === undefined
        ? {}
        : { inheritedEnvironment: this.#options.inheritedEnvironment }),
      ...(this.#options.dshBinPath === undefined
        ? {}
        : { dshBinPath: this.#options.dshBinPath }),
    }
    if (route !== undefined) {
      const providerRoute = `cyber-${fingerprint.slice(0, 16)}`
      options.provider = providerRoute
      options.model = route.modelId
      options.providerProfile = {
        route: providerRoute,
        displayName: route.displayName,
        api: route.api,
        baseURL: route.baseURL,
        model: {
          id: route.modelId,
          ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
          ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
          ...(route.reasoningEfforts === undefined ? {} : { reasoningEfforts: route.reasoningEfforts }),
          ...(route.compat === undefined ? {} : { compat: route.compat }),
        },
        ...(route.reasoning === undefined ? {} : { reasoning: route.reasoning }),
        ...(route.apiKeyEnv === undefined ? {} : { apiKeyEnv: route.apiKeyEnv }),
        ...(route.webSearch === undefined ? {} : { webSearch: route.webSearch }),
      }
    }
    return this.#options.adapterFactory?.(options) ?? new HarnessCompatibilityAdapter(options)
  }
}

export function isTransientRuntimeFailure(value: unknown): boolean {
  const facts = failureFacts(value)
  if (facts.status !== undefined) {
    if ([401, 402, 403, 404, 409, 422, 429].includes(facts.status)) return false
    if ([408, 425, 500, 502, 503, 504].includes(facts.status)) return true
  }
  const signal = facts.signal.toLowerCase()
  if (
    /invalid[_ -]?api[_ -]?key|unauthori[sz]ed|forbidden|authentication|model[_ -]?(?:not[_ -]?found|invalid)|unknown[_ -]?model|quota|insufficient[_ -]?funds|rate[_ -]?limit|too many requests/.test(signal)
  ) {
    return false
  }
  return /timeout|timed out|etimedout|econnreset|econnaborted|epipe|socket hang up|connection reset|connection closed|channel closed|rpc[^a-z0-9]*(?:closed|disconnect)|worker[^a-z0-9]*(?:exit|closed|terminated)|transport[^a-z0-9]*(?:closed|error)|temporar(?:y|ily) unavailable|service unavailable|bad gateway|gateway timeout|upstream_unreachable/.test(signal)
}

function failureFacts(value: unknown): { status?: number; signal: string } {
  const values: string[] = []
  let status: number | undefined
  const visit = (current: unknown, depth: number): void => {
    if (depth > 3 || current === null || current === undefined) return
    if (current instanceof Error) {
      values.push(current.name, current.message)
      const errorRecord = current as Error & Record<string, unknown>
      visit(errorRecord.cause, depth + 1)
      for (const key of ['status', 'statusCode', 'httpStatus', 'code']) {
        const parsed = httpStatus(errorRecord[key])
        if (status === undefined && parsed !== undefined) status = parsed
        const raw = errorRecord[key]
        if (typeof raw === 'string') values.push(raw)
      }
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      values.push(String(current))
      return
    }
    if (typeof current !== 'object' || Array.isArray(current)) return
    const record = current as Record<string, unknown>
    for (const key of ['status', 'statusCode', 'httpStatus', 'http_status']) {
      const parsed = httpStatus(record[key])
      if (status === undefined && parsed !== undefined) status = parsed
    }
    for (const key of ['code', 'errorCode', 'errorType', 'type', 'message', 'detail', 'error_description', 'reason']) {
      const item = record[key]
      if (typeof item === 'string' || typeof item === 'number') values.push(String(item))
    }
    for (const key of ['error', 'cause', 'response', 'data', 'metadata']) visit(record[key], depth + 1)
  }
  visit(value, 0)
  return { ...(status === undefined ? {} : { status }), signal: values.join(' ') }
}

function httpStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed
  }
  return undefined
}

function routeFingerprint(route: HarnessModelRoute | undefined): string {
  return createHash('sha256')
    .update(route === undefined ? 'dsh-default' : JSON.stringify(route))
    .digest('hex')
}

function safeRouteDirectory(routeId: string, fingerprint: string): string {
  const prefix = routeId
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 32)
  return `${prefix || 'model'}-${fingerprint.slice(0, 12)}`
}
