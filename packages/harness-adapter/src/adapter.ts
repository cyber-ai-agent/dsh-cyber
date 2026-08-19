import { join, resolve } from 'node:path'

import { DeepSeekHarness, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  AgentTurnResult,
  EmployeeInstance,
  EmployeeRevision,
  JsonObject,
} from '@dsh-cyber/contracts'

import {
  ensureHarnessProfile,
  resolveDshBin,
  WORKER_PROFILE_NAME,
  type HarnessProviderProfile,
  type HarnessProfilePaths,
} from './profile.js'

export interface EmployeeTurnRequest {
  employee: EmployeeInstance
  revision: EmployeeRevision
  prompt: string
  workspacePath: string
  onNotification?: (notification: HarnessNotification) => void
}

export interface EmployeeTurnResult {
  agentSessionId: string
  finalResponse: string
  notifications: HarnessNotification[]
}

export interface HarnessRuntime {
  run(
    sessionId: string,
    prompt: string,
    onNotification?: (notification: HarnessNotification) => void,
  ): Promise<{ finalResponse: string; notifications: HarnessNotification[] }>
  close(): Promise<void>
}

export interface HarnessRuntimeSpec {
  employee: EmployeeInstance
  revision: EmployeeRevision
  profile: HarnessProfilePaths
  workspacePath: string
  sessionsRoot: string
}

export type HarnessRuntimeFactory = (spec: HarnessRuntimeSpec) => HarnessRuntime

export interface HarnessAdapterOptions {
  stateRoot: string
  runtimeFactory?: HarnessRuntimeFactory
  inheritedEnvironment?: NodeJS.ProcessEnv
  nodeExecutable?: string
  provider?: string
  model?: string
  providerProfile?: HarnessProviderProfile
}

export class HarnessCompatibilityAdapter implements AgentRuntimePort, AsyncDisposable {
  readonly #options: HarnessAdapterOptions
  readonly #runtimes = new Map<string, HarnessRuntime>()
  #profile: Promise<HarnessProfilePaths> | undefined

  constructor(options: HarnessAdapterOptions) {
    this.#options = options
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const employeeRequest: EmployeeTurnRequest = {
      employee: request.agent,
      revision: request.revision,
      prompt: request.prompt,
      workspacePath: request.workspacePath,
    }
    if (request.onEvent !== undefined) {
      employeeRequest.onNotification = (notification) => {
        for (const event of normalizeHarnessNotification(notification)) {
          request.onEvent?.(event)
        }
      }
    }
    const result = await this.runEmployeeTurn(employeeRequest)
    return {
      agentSessionId: result.agentSessionId,
      finalResponse: result.finalResponse,
      eventCount: result.notifications.length,
    }
  }

  async runEmployeeTurn(request: EmployeeTurnRequest): Promise<EmployeeTurnResult> {
    const profile = await this.#getProfile()
    const agentSessionId = request.employee.agentSessionId ?? stableAgentSessionId(request.employee.id)
    let runtime = this.#runtimes.get(request.employee.id)
    if (runtime === undefined) {
      const spec: HarnessRuntimeSpec = {
        employee: request.employee,
        revision: request.revision,
        profile,
        workspacePath: resolve(request.workspacePath),
        sessionsRoot: join(resolve(this.#options.stateRoot), 'harness-sessions', request.employee.id),
      }
      runtime = this.#options.runtimeFactory?.(spec) ?? this.#createRuntime(spec)
      this.#runtimes.set(request.employee.id, runtime)
    }
    const result = await runtime.run(agentSessionId, request.prompt, request.onNotification)
    return { agentSessionId, ...result }
  }

  async closeEmployee(employeeId: string): Promise<void> {
    const runtime = this.#runtimes.get(employeeId)
    if (runtime === undefined) return
    this.#runtimes.delete(employeeId)
    await runtime.close()
  }

  closeAgent(agentId: string): Promise<void> {
    return this.closeEmployee(agentId)
  }

  async close(): Promise<void> {
    const runtimes = [...this.#runtimes.values()]
    this.#runtimes.clear()
    const results = await Promise.allSettled(runtimes.map((runtime) => runtime.close()))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to close ${failures.length} Harness employee runtime(s)`,
      )
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  async #getProfile(): Promise<HarnessProfilePaths> {
    this.#profile ??= ensureHarnessProfile(
      join(resolve(this.#options.stateRoot), 'harness-home'),
      WORKER_PROFILE_NAME,
      this.#options.providerProfile,
    )
    return this.#profile
  }

  #createRuntime(spec: HarnessRuntimeSpec): HarnessRuntime {
    const environment = workerEnvironment(
      this.#options.inheritedEnvironment ?? process.env,
      spec,
      this.#options.providerProfile?.apiKeyEnv === undefined
        ? []
        : [this.#options.providerProfile.apiKeyEnv],
    )
    const harness = new DeepSeekHarness({
      launch: {
        command: this.#options.nodeExecutable ?? process.execPath,
        args: [resolveDshBin(), '--profile', WORKER_PROFILE_NAME],
        cwd: spec.workspacePath,
        env: environment,
      },
      cwd: spec.workspacePath,
      provider: this.#options.provider ?? 'deepseek-official',
      model: this.#options.model ?? 'deepseek-v4-flash',
    })
    return {
      async run(sessionId, prompt, onNotification) {
        const result = await harness
          .session(sessionId)
          .run(prompt, onNotification === undefined ? undefined : { onNotification })
        return { finalResponse: result.finalResponse, notifications: result.notifications }
      },
      close: () => harness.close(),
    }
  }
}

export function normalizeHarnessNotification(
  notification: HarnessNotification,
): AgentRuntimeEvent[] {
  if (notification.method !== 'session.event') return []
  const event = record(notification.params.event)
  if (event === undefined) return []
  const data = record(event.data) ?? {}
  const eventType = stringValue(event.type)
  const sourceSessionId = stringValue(notification.params.sessionId) ?? 'unknown-session'
  const sourceSequence = numberValue(event.seq)
  const sourceTime = numberValue(event.time)
  const make = (
    kind: AgentRuntimeEvent['kind'],
    extra: Partial<AgentRuntimeEvent> = {},
  ): AgentRuntimeEvent => {
    const normalized: AgentRuntimeEvent = {
      kind,
      source: 'deepseek-harness',
      sourceSessionId,
      metadata: (extra.metadata as JsonObject | undefined) ?? {},
    }
    if (sourceSequence !== undefined) normalized.sourceSequence = sourceSequence
    if (sourceTime !== undefined) normalized.sourceTime = sourceTime
    if (extra.content !== undefined) normalized.content = extra.content
    if (extra.toolName !== undefined) normalized.toolName = extra.toolName
    if (extra.callId !== undefined) normalized.callId = extra.callId
    if (extra.failed !== undefined) normalized.failed = extra.failed
    return normalized
  }

  switch (eventType) {
    case 'turn/start':
      return [make('turn.started', { metadata: numericMetadata(data, ['turn']) })]
    case 'assistant/chunk': {
      const chunk = record(data.chunk)
      if (chunk === undefined) return []
      const chunkType = stringValue(chunk.type)
      if (chunkType === 'reasoning-delta') {
        const content = stringValue(chunk.text)
        return content ? [make('reasoning.delta', { content })] : []
      }
      if (chunkType === 'text-delta') {
        const content = stringValue(chunk.text)
        return content ? [make('text.delta', { content })] : []
      }
      return []
    }
    case 'assistant/message': {
      const message = record(data.message)
      const blocks = Array.isArray(message?.content) ? message.content : []
      const normalized: AgentRuntimeEvent[] = []
      for (const blockValue of blocks) {
        const block = record(blockValue)
        if (block === undefined) continue
        const blockType = stringValue(block.type)
        const content = stringValue(block.text)
        if (!content) continue
        if (blockType === 'reasoning') {
          normalized.push(make('assistant.reasoning', { content }))
        } else if (blockType === 'text') {
          normalized.push(make('assistant.message', { content }))
        }
      }
      return normalized
    }
    case 'tool/call': {
      const toolName = stringValue(data.name) ?? 'unknown-tool'
      const callId = stringValue(data.callId) ?? 'unknown-call'
      return [
        make('tool.started', {
          toolName,
          callId,
          metadata: { turn: numberValue(data.turn) ?? 0, step: numberValue(data.step) ?? 0 },
        }),
      ]
    }
    case 'tool/result': {
      const message = record(data.message)
      const source = record(message?.source)
      const callId = stringValue(source?.callId) ?? 'unknown-call'
      const failure = record(data.error)
      const failed = failure !== undefined
      const metadata: JsonObject = { failed }
      const errorCode = stringValue(failure?.code)
      if (errorCode !== undefined) metadata.errorCode = errorCode
      return [make('tool.completed', { callId, failed, metadata })]
    }
    case 'turn/end': {
      const reason = record(data.reason)
      const reasonKind = stringValue(reason?.kind) ?? 'unknown'
      const metadata: JsonObject = { reason: reasonKind }
      const failure = record(reason?.error)
      const code = stringValue(failure?.code)
      if (code !== undefined) metadata.errorCode = code
      return [
        make(reasonKind === 'completed' ? 'turn.completed' : 'turn.failed', {
          failed: reasonKind !== 'completed',
          metadata,
        }),
      ]
    }
    default:
      return []
  }
}

export function stableAgentSessionId(employeeId: string): string {
  return `employee-${employeeId.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numericMetadata(
  value: Record<string, unknown>,
  keys: readonly string[],
): JsonObject {
  const metadata: JsonObject = {}
  for (const key of keys) {
    const item = numberValue(value[key])
    if (item !== undefined) metadata[key] = item
  }
  return metadata
}

export function workerEnvironment(
  inherited: NodeJS.ProcessEnv,
  spec: HarnessRuntimeSpec,
  credentialEnvironmentNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
  ] as const
  const environment: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    const value = inherited[key]
    if (value !== undefined) environment[key] = value
  }
  for (const key of credentialEnvironmentNames) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid credential environment: ${key}`)
    const value = inherited[key]
    if (value !== undefined) environment[key] = value
  }
  environment.DSH_HOME = spec.profile.homeDir
  environment.DSH_CWD = spec.workspacePath
  environment.DSH_SESSION_ROOT = spec.sessionsRoot
  environment.DSH_SYSTEM_PROMPT = employeeSystemPrompt(spec.employee, spec.revision)
  environment.DSH_TELEMETRY_DISABLED = '1'
  environment.DSH_PERMISSION_MODE = 'read-only'
  return environment
}

function employeeSystemPrompt(employee: EmployeeInstance, revision: EmployeeRevision): string {
  return [
    `You are ${employee.displayName}, the ${employee.role} in DSH Cyber.`,
    revision.persona,
    'You are an independent employee with your own persistent conversation and must never speak as another employee.',
    'When another employee\'s statement is included in a meeting prompt, respond to its substance and identify agreements or disagreements.',
    'Give the boss a concise, evidence-based answer in your own role.',
  ].join('\n\n')
}
