import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { AgentRuntimeEventKind, EmployeeInstance, EmployeeRevision, JsonObject } from '@dsh-cyber/contracts'

import { HarnessCompatibilityAdapter } from './adapter.js'
import {
  HARNESS_PROTOCOL_CONTRACT,
  harnessCompatibilityEntry,
  inspectHarnessCandidate,
} from './compatibility.js'
import type { HarnessModelRoute } from './model-router.js'

const ACTIVE_RUNTIME_FILE = 'active-runtime.json'

export interface ActiveHarnessRuntime {
  schemaVersion: 1
  transactionId: string
  candidateRoot: string
  version: string
  activatedAt: string
}

export interface HarnessCanaryReport extends JsonObject {
  ok: true
  contractId: typeof HARNESS_PROTOCOL_CONTRACT
  candidateRoot: string
  version: string
  eventKinds: AgentRuntimeEventKind[]
  finalResponseLength: number
  stableSession: true
  checkedAt: string
}

export async function resolveCandidateDshBin(candidateRoot: string): Promise<string> {
  const root = resolve(candidateRoot)
  const require = createRequire(join(root, 'package.json'))
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(manifestPath), 'lib', 'bin.js')
}

export async function readActiveHarnessRuntime(runtimeStateRoot: string): Promise<ActiveHarnessRuntime | undefined> {
  try {
    const parsed = JSON.parse(await readFile(activeRuntimePath(runtimeStateRoot), 'utf8')) as unknown
    return validateActiveRuntime(parsed)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

export async function writeActiveHarnessRuntime(
  runtimeStateRoot: string,
  value: ActiveHarnessRuntime,
): Promise<string> {
  const validated = validateActiveRuntime(value)
  const destination = activeRuntimePath(runtimeStateRoot)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, destination)
  return destination
}

export async function clearActiveHarnessRuntime(runtimeStateRoot: string): Promise<void> {
  try {
    await unlink(activeRuntimePath(runtimeStateRoot))
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

export async function inspectHarnessCandidateContract(options: {
  candidateRoot: string
  stateRoot: string
}): Promise<JsonObject> {
  const report = await inspectHarnessCandidate(options)
  if (!report.ok || report.version === undefined || report.contractId === undefined) {
    throw new Error(report.errors.join('; ') || 'Candidate Harness verification failed')
  }
  const entry = harnessCompatibilityEntry(report.version)
  if (entry === undefined) throw new Error(`Harness ${report.version} has no compatibility contract`)
  const dshBinPath = await resolveCandidateDshBin(report.candidateRoot)
  await readFile(dshBinPath)
  return {
    ok: true,
    version: report.version,
    contractId: report.contractId,
    dshBinPath,
    requiredEvents: [...entry.requiredEvents],
    packageVersions: report.checks.packageVersions,
    isolatedProfile: report.checks.isolatedProfile,
    checkedAt: new Date().toISOString(),
  }
}

export async function runHarnessCandidateCanary(options: {
  candidateRoot: string
  stateRoot: string
  workspacePath: string
  route: HarnessModelRoute
  inheritedEnvironment?: NodeJS.ProcessEnv
}): Promise<HarnessCanaryReport> {
  const candidate = await inspectHarnessCandidate({
    candidateRoot: options.candidateRoot,
    stateRoot: options.stateRoot,
  })
  if (!candidate.ok || candidate.version === undefined) {
    throw new Error(candidate.errors.join('; ') || 'Candidate Harness verification failed')
  }
  const dshBinPath = await resolveCandidateDshBin(candidate.candidateRoot)
  const now = new Date().toISOString()
  const employee: EmployeeInstance = {
    id: 'runtime-canary',
    workspaceId: 'runtime-canary-workspace',
    worldId: 'runtime-canary-world',
    blueprintId: 'runtime-canary',
    blueprintVersion: 1,
    displayName: '运行时金丝雀',
    role: '兼容性验证员',
    presence: 'available',
    health: 'healthy',
    status: 'available',
    currentRevision: 1,
    createdAt: now,
    updatedAt: now,
  }
  const revision: EmployeeRevision = {
    employeeId: employee.id,
    revision: 1,
    persona: '只回复 DSH-CYBER-CANARY-OK，不调用工具。',
    skillGrants: [],
    capabilityGrants: [],
    modelPolicy: {},
    reason: 'runtime-update-canary',
    createdAt: now,
  }
  const fingerprint = randomUUID().replaceAll('-', '')
  const providerRoute = `cyber-canary-${fingerprint.slice(0, 16)}`
  const events: AgentRuntimeEventKind[] = []
  const adapter = new HarnessCompatibilityAdapter({
    stateRoot: join(resolve(options.stateRoot), 'canary', fingerprint),
    dshBinPath,
    model: options.route.modelId,
    provider: providerRoute,
    ...(options.inheritedEnvironment === undefined ? {} : { inheritedEnvironment: options.inheritedEnvironment }),
    providerProfile: {
      route: providerRoute,
      displayName: options.route.displayName,
      api: options.route.api,
      baseURL: options.route.baseURL,
      ...(options.route.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.route.apiKeyEnv }),
      model: {
        id: options.route.modelId,
        ...(options.route.contextWindow === undefined ? {} : { contextWindow: options.route.contextWindow }),
        ...(options.route.maxTokens === undefined ? {} : { maxTokens: options.route.maxTokens }),
      },
    },
  })
  // Both canary turns belong to the same conversation, which is what makes the
  // candidate reuse a single Harness session. The employee's last runtime
  // session id is deliberately not threaded back in: conversation identity is
  // the only thing that may decide session reuse.
  const canaryConversationId = `canary-conversation-${fingerprint}`
  try {
    const first = await adapter.runTurn({
      agent: employee,
      revision,
      conversationId: canaryConversationId,
      history: [],
      observedThroughSequence: 0,
      prompt: '回复 DSH-CYBER-CANARY-OK。',
      workspacePath: resolve(options.workspacePath),
      onEvent: (event) => events.push(event.kind),
    })
    const second = await adapter.runTurn({
      agent: employee,
      revision,
      conversationId: canaryConversationId,
      history: [],
      observedThroughSequence: 0,
      prompt: '保持同一会话，再次回复 DSH-CYBER-CANARY-OK。',
      workspacePath: resolve(options.workspacePath),
      onEvent: (event) => events.push(event.kind),
    })
    const required: AgentRuntimeEventKind[] = ['turn.started', 'assistant.message', 'turn.completed']
    const missing = required.filter((kind) => !events.includes(kind))
    if (!first.finalResponse.trim() || !second.finalResponse.trim()) throw new Error('Candidate canary returned an empty response')
    if (first.agentSessionId !== second.agentSessionId) throw new Error('Candidate canary did not keep one session per conversation')
    if (missing.length > 0) throw new Error(`Candidate canary missed events: ${missing.join(', ')}`)
    return {
      ok: true,
      contractId: HARNESS_PROTOCOL_CONTRACT,
      candidateRoot: candidate.candidateRoot,
      version: candidate.version,
      eventKinds: [...new Set(events)],
      finalResponseLength: first.finalResponse.length + second.finalResponse.length,
      stableSession: true,
      checkedAt: new Date().toISOString(),
    }
  } finally {
    await adapter.close()
  }
}

function activeRuntimePath(runtimeStateRoot: string): string {
  return join(resolve(runtimeStateRoot), ACTIVE_RUNTIME_FILE)
}

function validateActiveRuntime(value: unknown): ActiveHarnessRuntime {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Active Harness runtime pointer is invalid')
  }
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1) throw new Error('Unsupported active Harness runtime pointer schema')
  const transactionId = requiredText(input.transactionId, 'transactionId')
  const candidateRoot = resolve(requiredText(input.candidateRoot, 'candidateRoot'))
  const version = requiredText(input.version, 'version')
  const activatedAt = requiredText(input.activatedAt, 'activatedAt')
  return { schemaVersion: 1, transactionId, candidateRoot, version, activatedAt }
}

function requiredText(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Active runtime ${key} is invalid`)
  return value.trim()
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
