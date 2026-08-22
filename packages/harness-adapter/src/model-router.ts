import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  AgentTurnResult,
  JsonObject,
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
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: false | Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  compat?: { thinkingFormat?: string; supportsReasoningEffort?: boolean }
}

export interface HarnessModelRouterOptions {
  stateRoot: string
  resolveRoute(request: AgentTurnRequest): HarnessModelRoute | undefined
  adapterFactory?: (options: HarnessAdapterOptions) => AgentRuntimePort
  inheritedEnvironment?: NodeJS.ProcessEnv
  nodeExecutable?: string
  dshBinPath?: string
}

interface AdapterEntry {
  fingerprint: string
  adapter: AgentRuntimePort
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
  readonly #entries = new Map<string, AdapterEntry>()

  constructor(options: HarnessModelRouterOptions) {
    this.#options = options
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const route = this.#options.resolveRoute(request)
    const routeId = route?.id ?? '__dsh-default__'
    const fingerprint = routeFingerprint(route)
    let entry = await this.#entry(routeId, route, fingerprint)
    const observation: AttemptObservation = { unsafeToRetry: false }
    const observedRequest: AgentTurnRequest = {
      ...request,
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
        ) {
          observation.unsafeToRetry = true
        }
        request.onEvent?.(event)
      },
    }

    try {
      const result = await entry.adapter.runTurn(observedRequest)
      const failure = observation.terminalFailure
      if (
        failure !== undefined
        && !observation.unsafeToRetry
        && isTransientRuntimeFailure(failure.metadata)
        && entry.adapter.closeAgent !== undefined
      ) {
        await entry.adapter.closeAgent(request.agent.id)
        return entry.adapter.runTurn(request)
      }
      if (failure !== undefined) request.onEvent?.(failure)
      return result
    } catch (error) {
      if (
        !observation.unsafeToRetry
        && isTransientRuntimeFailure(error)
        && entry.adapter.closeAgent !== undefined
      ) {
        await entry.adapter.closeAgent(request.agent.id)
        entry = await this.#entry(routeId, route, fingerprint)
        return entry.adapter.runTurn(request)
      }
      throw error
    }
  }

  async closeAgent(agentId: string): Promise<void> {
    await Promise.all(
      [...this.#entries.values()].map((entry) => entry.adapter.closeAgent?.(agentId)),
    )
  }

  async close(): Promise<void> {
    const adapters = [...this.#entries.values()].map((entry) => entry.adapter)
    this.#entries.clear()
    const results = await Promise.allSettled(adapters.map((adapter) => adapter.close()))
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to close ${failures.length} routed Harness runtime(s)`,
      )
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  async #entry(
    routeId: string,
    route: HarnessModelRoute | undefined,
    fingerprint: string,
  ): Promise<AdapterEntry> {
    let entry = this.#entries.get(routeId)
    if (entry !== undefined && entry.fingerprint !== fingerprint) {
      this.#entries.delete(routeId)
      await entry.adapter.close()
      entry = undefined
    }
    if (entry === undefined) {
      entry = {
        fingerprint,
        adapter: this.#createAdapter(route, fingerprint),
      }
      this.#entries.set(routeId, entry)
    }
    return entry
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
      ...(this.#options.nodeExecutable === undefined
        ? {}
        : { nodeExecutable: this.#options.nodeExecutable }),
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
