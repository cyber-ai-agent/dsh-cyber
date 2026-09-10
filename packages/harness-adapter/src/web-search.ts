import { WEB_SEARCH_WORKER_ENV } from '@dsh-cyber/contracts'

/**
 * How a DSH Cyber worker drives the built-in model-facing `web_search` tool,
 * resolved host-side per turn and written into the worker's profile + launch
 * environment. This is the DSH-Cyber-side mirror of the DSH `web` seam's
 * provider selection (`ctx.web.registerSearchProvider` + `web.searchProvider`).
 *
 * - `deepseek`: point the built-in `web-search-deepseek` provider at an
 *   Anthropic-compatible endpoint, feeding the key through a generated env
 *   name (same trust boundary as model credentials).
 * - `firecrawl`: select the `firecrawl` provider registered by the worker
 *   bundle; it calls back into the host over loopback, which holds the key.
 * - `disabled`: no usable search backend → hide `web_search` so the model
 *   never calls a tool that can only fail on a missing credential.
 */
export type WorkerWebSearchPlan =
  | { kind: 'deepseek'; baseUrl: string; apiKeyEnv: string; apiKey: string }
  | { kind: 'firecrawl'; workspaceId: string; hostOrigin?: string; workerToken?: string }
  | { kind: 'disabled' }

export const WORKER_WEBSEARCH_DEEPSEEK_KEY_ENV = 'DSH_CYBER_WEBSEARCH_DEEPSEEK_KEY'

/**
 * Materialize a plan into the worker's launch environment. The DeepSeek key
 * lands under the exact generated name the `web-search-deepseek` provider is
 * told to read; the Firecrawl bridge exposes only the loopback coordinates —
 * the Firecrawl credential itself never leaves the host process.
 */
export function applyWebSearchPlanToEnvironment(
  environment: NodeJS.ProcessEnv,
  plan: WorkerWebSearchPlan | undefined,
): void {
  if (plan === undefined) return
  if (plan.kind === 'deepseek') {
    environment[plan.apiKeyEnv] = plan.apiKey
    return
  }
  if (plan.kind === 'firecrawl') {
    environment[WEB_SEARCH_WORKER_ENV.workspaceId] = plan.workspaceId
    if (plan.hostOrigin !== undefined) environment[WEB_SEARCH_WORKER_ENV.loopbackOrigin] = plan.hostOrigin
    if (plan.workerToken !== undefined) environment[WEB_SEARCH_WORKER_ENV.workerToken] = plan.workerToken
  }
}
