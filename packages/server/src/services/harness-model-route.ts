import type { ModelProfile } from '@dsh-cyber/contracts'
import type { HarnessModelRoute } from '@dsh-cyber/harness-adapter'

import { optionalPositiveInteger } from '../http/request.js'

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
    ...(reasoningEffort === undefined ? {} : { reasoning: reasoningEffort }),
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
