import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import type {
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

/**
 * Routes every employee turn through the model profile selected by its immutable
 * employee revision. Credentials remain environment variable references and are
 * only copied into the isolated Harness worker by HarnessCompatibilityAdapter.
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
    return entry.adapter.runTurn(request)
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
