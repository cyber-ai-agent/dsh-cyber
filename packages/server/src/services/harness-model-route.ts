import type { ModelProfile } from '@dsh-cyber/contracts'
import type { HarnessModelRoute } from '@dsh-cyber/harness-adapter'

import { optionalPositiveInteger } from '../http/request.js'

type ReasoningEffortLevel = Exclude<HarnessModelRoute['reasoning'], undefined>

/**
 * Keep a requested effort only when the profile explicitly declares support.
 *
 * A profile declaring `reasoningEfforts: false` serves no level at all, and a
 * dict offers exactly its keys; an unsupported request must degrade to "no
 * explicit effort" instead of failing the turn inside the worker. Profiles
 * without a declaration rely on installed-catalog defaults and pass through.
 */
export function supportedReasoningEffort(
  profile: ModelProfile,
  reasoningEffort?: ReasoningEffortLevel,
): ReasoningEffortLevel | undefined {
  if (reasoningEffort === undefined) return undefined
  const declared = profile.settings.reasoningEfforts
  if (declared === false) return undefined
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    return Object.hasOwn(declared, reasoningEffort) ? reasoningEffort : undefined
  }
  return reasoningEffort
}

export function harnessModelRoute(
  profile: ModelProfile,
  reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): HarnessModelRoute {
  const contextWindow = optionalPositiveInteger(profile.settings.contextWindow)
  const maxTokens = optionalPositiveInteger(profile.settings.maxTokens)
  const webSearchEnabled = profile.settings.webSearchEnabled === true
  const webSearchBaseUrl = typeof profile.settings.webSearchBaseUrl === 'string'
    ? profile.settings.webSearchBaseUrl.trim()
    : ''
  const effectiveEffort = supportedReasoningEffort(profile, reasoningEffort)
  return {
    id: profile.id,
    displayName: profile.displayName,
    api: profile.api,
    baseURL: profile.baseUrl,
    modelId: profile.modelId,
    ...(profile.credentialEnvName === undefined ? {} : { apiKeyEnv: profile.credentialEnvName }),
    ...(webSearchEnabled && webSearchBaseUrl && profile.credentialEnvName !== undefined
      ? {
          webSearch: {
            baseURL: webSearchBaseUrl,
            apiKeyEnv: profile.credentialEnvName,
          },
        }
      : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(effectiveEffort === undefined ? {} : { reasoning: effectiveEffort }),
    ...(profile.settings.reasoningEfforts === false
      ? { reasoningEfforts: false }
      : typeof profile.settings.reasoningEfforts === 'object' && profile.settings.reasoningEfforts !== null
        ? {
            reasoningEfforts: profile.settings.reasoningEfforts as Exclude<
              HarnessModelRoute['reasoningEfforts'],
              undefined
            >,
          }
        : {}),
    ...(typeof profile.settings.thinkingFormat === 'string'
      ? {
          compat: {
            thinkingFormat: profile.settings.thinkingFormat,
            supportsReasoningEffort: true,
          },
        }
      : {}),
  }
}
