import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { parse } from 'yaml'
import type {
  ConversationCredentialSource,
  ConversationModelReadiness,
  ConversationModelReadinessInput,
  ConversationModelReadinessItem,
  ConversationModelReadinessState,
  ConversationModelSource,
  ModelProfile,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import { HttpError } from '../http/errors.js'
import type { ModelCredentialService } from './model-credential-service.js'
import { isImageGenerationModel } from './image-generation-service.js'
import { modelBaseUrlIdentity } from './model-url-policy.js'

export interface ModelReadinessOptions {
  store: SqliteStore
  credentials: Pick<ModelCredentialService, 'resolve' | 'credentialEnvName'>
  runtimeStateRoot: string
  /** An injected runtime owns its configuration; never infer that it needs an API key. */
  externalRuntime?: boolean
  environment?: NodeJS.ProcessEnv
  resolveWorkspacePath?: (worldId: string, employeeId: string) => Promise<string>
}

/** Shared by readiness and the real Harness route so credential claims match execution. */
export function resolveModelCredential(
  store: Pick<SqliteStore, 'getModelProvider'>,
  credentials: ModelReadinessOptions['credentials'],
  profile: ModelProfile,
  environment: NodeJS.ProcessEnv = process.env,
): { credentialEnvName?: string; source: ConversationCredentialSource; configured: boolean } {
  const provider = profile.providerId === undefined ? undefined : store.getModelProvider(profile.providerId)
  // A provider link cannot authorize sending its credential to a different endpoint.
  const profileUrl = modelBaseUrlIdentity(profile.baseUrl)
  const linkedProvider = profileUrl !== undefined && provider?.workspaceId === profile.workspaceId
    && modelBaseUrlIdentity(provider.baseUrl) === profileUrl ? provider : undefined
  const managedRef = credentials.credentialEnvName(profile.id)
  if ((profile.credentialEnvName === undefined || profile.credentialEnvName === managedRef)
    && credentials.resolve(profile.id)?.trim()) {
    return { credentialEnvName: managedRef, source: 'profile', configured: true }
  }
  if (profile.credentialEnvName !== undefined) {
    if (environment[profile.credentialEnvName]?.trim()) {
      return { credentialEnvName: profile.credentialEnvName, source: profile.credentialEnvName === linkedProvider?.credentialEnvName ? 'provider' : 'environment', configured: true }
    }
    // A named reference is an explicit choice, including when absent. Never
    // replace a missing named credential with a different provider's secret.
    return { credentialEnvName: profile.credentialEnvName, source: 'none', configured: false }
  }
  if (linkedProvider !== undefined) {
    if (credentials.resolve(linkedProvider.id)?.trim()) {
      return { credentialEnvName: credentials.credentialEnvName(linkedProvider.id), source: 'provider', configured: true }
    }
    if (linkedProvider.credentialEnvName !== undefined && environment[linkedProvider.credentialEnvName]?.trim()) {
      return { credentialEnvName: linkedProvider.credentialEnvName, source: 'provider', configured: true }
    }
  }
  if (profile.credentialEnvName === undefined && linkedProvider?.credentialEnvName === undefined && profile.providerKind === 'openai-compatible-local') {
    return { source: 'not-required', configured: true }
  }
  // The managed provider has a distinct route name, so explicitly forward the
  // built-in environment reference rather than assuming Harness will infer it.
  // An arbitrary gateway cannot opt into an ambient secret merely by naming
  // its provider kind DeepSeek; a custom endpoint needs an explicit reference.
  if (profile.credentialEnvName === undefined && linkedProvider?.credentialEnvName === undefined && profile.providerKind === 'deepseek'
    && profileUrl !== undefined && new URL(profileUrl).origin === 'https://api.deepseek.com') {
    const configured = Boolean(environment.DEEPSEEK_API_KEY?.trim())
    return { credentialEnvName: 'DEEPSEEK_API_KEY', source: configured ? 'environment' : 'none', configured }
  }
  const credentialEnvName = profile.credentialEnvName ?? linkedProvider?.credentialEnvName
  return { ...(credentialEnvName === undefined ? {} : { credentialEnvName }), source: 'none', configured: false }
}

export class ModelReadinessService {
  readonly #options: ModelReadinessOptions
  constructor(options: ModelReadinessOptions) { this.#options = options }

  async inspect(worldId: string, input: ConversationModelReadinessInput): Promise<ConversationModelReadiness> {
    const { store, credentials } = this.#options
    const world = store.getWorld(worldId)
    if (world === undefined) throw new HttpError(404, 'world_not_found', '世界不存在')
    if (input.employeeIds.length === 0 || input.employeeIds.length > 20) throw new HttpError(422, 'agent_required', '请选择 1 至 20 名角色')
    const employeeIds = [...new Set(input.employeeIds)]
    for (const id of employeeIds) {
      const employee = store.getEmployee(id)
      if (employee === undefined || employee.worldId !== world.id || employee.workspaceId !== world.workspaceId || employee.status === 'archived') {
        throw new HttpError(422, 'character_unavailable', '所选角色不属于当前世界或已归档')
      }
    }
    const profileIds = [input.modelProfileId, ...Object.values(input.modelProfileIds ?? {})].filter((id): id is string => id !== undefined)
    for (const id of profileIds) {
      const profile = store.getModelProfile(id)
      if (profile === undefined || profile.workspaceId !== world.workspaceId) throw new HttpError(422, 'conversation_model_unavailable', '所选临时会话模型不存在或不属于当前工作区')
    }
    if (Object.keys(input.modelProfileIds ?? {}).some((id) => !employeeIds.includes(id))) throw new HttpError(422, 'conversation_model_unavailable', '指定模型的角色不在本次会话中')
    const external = this.#options.externalRuntime === true
    const items = await Promise.all(employeeIds.map(async (employeeId): Promise<ConversationModelReadinessItem> => {
      if (external) return { employeeId, source: 'external-runtime', state: 'configured-unverified', credentialSource: 'external-runtime' }
      // Group execution uses per-character overrides and intentionally ignores
      // the legacy scalar; a solo turn uses the scalar exactly as the runtime.
      const temporaryId = employeeIds.length === 1 ? input.modelProfileId : input.modelProfileIds?.[employeeId]
      const profile = temporaryId === undefined
        ? store.resolveModelProfile(world.workspaceId, world.id, employeeId)
        : store.getModelProfile(temporaryId)
      if (profile === undefined) {
        const fallbackState = await this.#harnessDefaultState(worldId, employeeId)
        return fallbackState === 'configured-unverified'
          ? { employeeId, source: 'harness-default', state: fallbackState, credentialSource: 'harness-default', modelId: 'deepseek-flash', displayName: 'DeepSeek' }
          : fallbackState === 'missing-credential'
            ? { employeeId, source: 'harness-default', state: fallbackState, credentialSource: 'none', modelId: 'deepseek-flash', displayName: 'DeepSeek', blockingReason: 'missing-credential', guidance: '默认模型缺少可用凭据。请检查本机 Harness 凭据配置，或打开“模型中心”添加服务商和模型。' }
            : { employeeId, source: 'harness-default', state: 'none', credentialSource: 'none', blockingReason: 'no-model', guidance: '还没有可用的模型配置。请打开“模型中心”，添加服务商并导入模型后再发送。' }
      }
      const credential = resolveModelCredential(store, credentials, profile, this.#options.environment)
      // Image HTTP requests do not run inside Harness and cannot read its .env sources.
      const dotenvConfigured = !isImageGenerationModel(profile) && !credential.configured && credential.credentialEnvName !== undefined
        && await this.#hasProjectDotenv(worldId, employeeId, credential.credentialEnvName)
      const configured = credential.configured || dotenvConfigured
      return {
        employeeId,
        source: temporaryId === undefined ? this.#profileSource(world.workspaceId, world.id, employeeId, profile) : 'temporary',
        modelProfileId: profile.id,
        modelId: profile.modelId,
        displayName: profile.displayName,
        credentialSource: dotenvConfigured ? 'environment' : credential.source,
        state: configured ? 'configured-unverified' : 'missing-credential',
        ...(configured ? {} : { blockingReason: 'missing-credential' as const, guidance: '当前模型缺少可用凭据。请打开“模型中心”补充服务商密钥，或检查所选凭据环境变量。' }),
      }
    }))
    return { worldId, canSend: items.every((item) => item.blockingReason === undefined), items }
  }

  async assertCanSend(worldId: string, input: ConversationModelReadinessInput): Promise<void> {
    const result = await this.inspect(worldId, input)
    const blocked = result.items.find((item) => item.blockingReason !== undefined)
    if (blocked !== undefined) throw new HttpError(422, 'model_setup_required', blocked.guidance!)
  }

  #profileSource(workspaceId: string, worldId: string, employeeId: string, profile: ModelProfile): ConversationModelSource {
    const { store } = this.#options
    const assignment = store.getModelAssignment(workspaceId, 'employee', employeeId)
      ?? store.getModelAssignment(workspaceId, 'world', worldId)
      ?? store.getModelAssignment(workspaceId, 'workspace', workspaceId)
    if (assignment?.modelProfileId === profile.id) return assignment.scope
    return profile.isDefault ? 'default' : 'first-profile'
  }

  async #hasProjectDotenv(worldId: string, employeeId: string, ref: string): Promise<boolean> {
    const path = await this.#options.resolveWorkspacePath?.(worldId, employeeId)
    return path === undefined ? false : dotenvHasCredential(join(path, '.env'), ref)
  }

  async #harnessDefaultState(worldId: string, employeeId: string): Promise<ConversationModelReadinessState> {
    // Route-undefined workers are explicitly launched with deepseek-official /
    // deepseek-flash by HarnessCompatibilityAdapter, so other pi-ai providers,
    // an llm model choice, or retry tuning cannot establish their readiness.
    // Only this isolated worker home and its allowlisted launch environment
    // are authoritative; ambient DSH_HOME and ~/.dsh are not inherited.
    const home = join(this.#options.runtimeStateRoot, 'providers', 'dsh-default', 'harness-home')
    const credentials = await readExternalConfig(join(home, '.credentials.yaml'))
    const settings = await readExternalConfig(join(home, 'settings.yaml'))
    if (credentials === 'unknown' || settings === 'unknown') return 'configured-unverified'
    const native = object(settings?.['llm-deepseek'])
    const configuredRef = typeof native?.apiKeyEnv === 'string' ? native.apiKeyEnv.trim() : undefined
    const ref = configuredRef ?? 'DEEPSEEK_API_KEY'
    const stored = object(credentials?.refs)?.[ref]
    if (typeof stored === 'string' && stored.trim() !== '') return 'configured-unverified'
    // workerEnvironment forwards DEEPSEEK_API_KEY for the default route;
    // arbitrary named host environment variables are deliberately not inherited.
    if (ref === 'DEEPSEEK_API_KEY' && (this.#options.environment ?? process.env).DEEPSEEK_API_KEY?.trim()) return 'configured-unverified'
    if (await this.#hasProjectDotenv(worldId, employeeId, ref) || await dotenvHasCredential(join(home, '.env'), ref)) return 'configured-unverified'
    return native !== undefined && Object.keys(native).length > 0 ? 'missing-credential' : 'none'
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Never return any raw external config or credential data over HTTP. */
async function readExternalConfig(path: string): Promise<Record<string, unknown> | 'unknown' | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    if (text.length > 1024 * 1024) return 'unknown'
    return object(parse(text, { logLevel: 'silent' }))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    // Do not claim known absence if an external config cannot be inspected.
    return 'unknown'
  }
}

/** Read only the named reference; never copy .env contents into the host environment. */
async function dotenvHasCredential(path: string, ref: string): Promise<boolean> {
  try {
    const text = await readFile(path, 'utf8')
    if (text.length > 1024 * 1024) return true // External config exists but cannot be safely inspected.
    return Boolean(parseEnv(text)[ref]?.trim())
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    return true // Defer an unreadable external configuration to the real runtime.
  }
}
